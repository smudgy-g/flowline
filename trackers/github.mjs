#!/usr/bin/env node
// GitHub tracker: issues labelled `factory` / `factory-stack` in, a draft PR out (docs/tracker.md).
// Needs an authenticated `gh`. Only issues and comments by the token's owner, or FACTORY_ISSUE_AUTHORS, are trusted.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const repo = process.env.FACTORY_REPO
const base = process.env.FACTORY_BASE

if (!repo || !base) throw new Error('FACTORY_REPO and FACTORY_BASE are required')

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()
const json = (...args) => JSON.parse(gh(...args))

const stdin = () => { try { return readFileSync(0, 'utf8') } catch { return '' } }

const say = value => process.stdout.write(JSON.stringify(value))

const id = raw => {
  const n = Number(raw)

  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid issue number: ${raw}`)

  return n
}

const trusted = () => [gh('api', 'user', '--jq', '.login'),
  ...(process.env.FACTORY_ISSUE_AUTHORS ?? '').split(',').map(s => s.trim()).filter(Boolean)]

const numberOf = url => id(url.trim().split('/').at(-1))
const nodeId = n => gh('api', `repos/${repo}/issues/${n}`, '--jq', '.id')

const prUrl = (branch, target) =>
  gh('pr', 'list', '--repo', repo, '--head', branch, '--base', target, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""')

const [verb, ...args] = process.argv.slice(2)

switch (verb) {
  case 'list': {
    const labelled = label => json('issue', 'list', '-R', repo, '--label', label, '--state', 'open',
      '--limit', '50', '--json', 'number,title,url,labels')

    // Claimed by a factory: it is that factory's card, not an item anyone can start.
    const free = i => !i.labels.some(l => l.name.startsWith('factory:'))
    const item = (i, stack) => ({ id: i.number, title: i.title, url: i.url, stack })
    say([...labelled('factory-stack').filter(free).map(i => item(i, true)),
      ...labelled('factory').filter(free).map(i => item(i, false))])
    break
  }

  case 'read': {
    const n = id(args[0])
    const raw = json('issue', 'view', String(n), '--repo', repo, '--json', 'number,title,body,url,state,author,comments')

    if (raw.state !== 'OPEN') throw new Error(`Issue #${n} is ${raw.state}`)

    const authors = trusted()

    if (!authors.includes(raw.author.login))
      throw new Error(`Issue #${n} is by ${raw.author.login}, who is not a trusted author (${authors.join(', ')})`)

    const comments = raw.comments.filter(c => authors.includes(c.author.login)).map(c => c.body)
    say({ id: raw.number, title: raw.title, body: [raw.body, ...comments].join('\n\n---\n\n'), url: raw.url, author: raw.author.login, comments })
    break
  }

  case 'claim': {
    const [n, owner] = [id(args[0]), args[1] ?? 'factory']
    const label = `factory:${owner}`
    const labels = gh('issue', 'view', String(n), '--repo', repo, '--json', 'labels', '--jq', '.labels[].name').split('\n').filter(Boolean)
    const other = labels.find(l => l.startsWith('factory:') && l !== label)

    if (other) throw new Error(`#${n} is already running on ${other.slice('factory:'.length)}`)

    if (!labels.includes(label)) {
      // --force creates the label the first time and is a no-op after.
      gh('label', 'create', label, '--repo', repo, '--color', '5319e7', '--description', `Running on the ${owner} factory`, '--force')
      gh('issue', 'edit', String(n), '--repo', repo, '--add-label', label)
    }

    say({ ok: true })
    break
  }

  case 'release': {
    const n = id(args[0])
    for (const label of gh('issue', 'view', String(n), '--repo', repo, '--json', 'labels', '--jq', '.labels[].name').split('\n').filter(l => l.startsWith('factory:')))
      gh('issue', 'edit', String(n), '--repo', repo, '--remove-label', label)
    say({ ok: true })
    break
  }

  case 'comment':
    gh('issue', 'comment', String(id(args[0])), '--repo', repo, '--body', stdin())
    say({ ok: true })
    break

  case 'create': {
    const kind = args[0]

    if (!['task', 'child'].includes(kind)) throw new Error(`Unknown item kind: ${kind}`)

    const { title, body, parent, after } = JSON.parse(stdin())

    // A child gets no `factory` label: a stack member must not show up as an item anyone can start.
    const n = numberOf(gh('issue', 'create', '--repo', repo, '--title', title, '--body', body,
      ...(kind === 'task' ? ['--label', 'factory'] : [])))

    if (parent) {
      const sub = nodeId(n)
      gh('api', '-X', 'POST', `repos/${repo}/issues/${parent}/sub_issues`, '-F', `sub_issue_id=${sub}`)

      if (after) gh('api', '-X', 'PATCH', `repos/${repo}/issues/${parent}/sub_issues/priority`,
        '-F', `sub_issue_id=${sub}`, '-F', `after_id=${nodeId(after)}`)
    }

    say({ id: n })
    break
  }

  case 'retitle':
    gh('issue', 'edit', String(id(args[0])), '--repo', repo, '--title', stdin().trim())
    say({ ok: true })
    break

  case 'section': {
    const [n, name] = [id(args[0]), args[1]]
    const body = gh('issue', 'view', String(n), '--repo', repo, '--json', 'body', '--jq', '.body')
    const heading = new RegExp(`(^###\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$)([\\s\\S]*?)(?=^#{2,3}\\s+|$)`, 'm')

    if (!heading.test(body)) throw new Error(`Issue #${n} has no "### ${name}" section`)

    gh('issue', 'edit', String(n), '--repo', repo, '--body', body.replace(heading, `$1\n\n${stdin().trim()}\n\n`))
    say({ ok: true })
    break
  }

  case 'state':
    say({ open: gh('issue', 'view', String(id(args[0])), '--repo', repo, '--json', 'state', '--jq', '.state') === 'OPEN' })
    break

  case 'close': {
    const n = id(args[0])

    if (gh('issue', 'view', String(n), '--repo', repo, '--json', 'state', '--jq', '.state') === 'OPEN')
      gh('issue', 'close', String(n), '--repo', repo, '--comment', stdin())

    say({ ok: true })
    break
  }

  case 'deliver': {
    const [branch, target] = args
    const { title, body } = JSON.parse(stdin())
    const existing = prUrl(branch, target)

    if (existing) {
      gh('pr', 'edit', existing, '--repo', repo, '--title', title, '--body', body)
      say({ url: existing })
      break
    }

    say({ url: gh('pr', 'create', '--repo', repo, '--draft', '--base', target, '--head', branch, '--title', title, '--body', body) })
    break
  }

  case 'delivered': {
    const state = gh('pr', 'view', args[0], '--repo', repo, '--json', 'state', '--jq', '.state')
    say({ state: state === 'MERGED' ? 'accepted' : state === 'CLOSED' ? 'rejected' : 'open' })
    break
  }

  default:
    throw new Error(`Unknown tracker verb: ${verb}`)
}
