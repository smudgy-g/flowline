#!/usr/bin/env node
// Local tracker: work items are Markdown files in the target repo, no account and no network (docs/tracker.md).
//
//   .factory/items/<id>.md        the item: ### Outcome, ### Lane, ### PRs in order, then ## comment sections
//   .factory/items/<id>.closed    closed, with the closing note
//   .factory/claims/<id>          the factory that holds it
//   .factory/delivered/<id>.md    what a finished change proposes
//
// Read from the base checkout only. A task worktree can write these files, so list `.factory/**` in paths.protected.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { basename, join } from 'node:path'

const root = process.env.FACTORY_CHECKOUT
const base = process.env.FACTORY_BASE
if (!root || !base) throw new Error('FACTORY_CHECKOUT and FACTORY_BASE are required')
const dir = name => {
  const path = join(root, '.factory', name)
  mkdirSync(path, { recursive: true })
  return path
}
// Ids are the file's own name: stable, readable, and distinct from another tracker's.
const id = raw => {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(raw) || raw.startsWith('.')) throw new Error(`Invalid item id: ${raw}`)
  return raw
}
const slug = title => (title.toLowerCase().match(/[a-z0-9]+/g) ?? ['item']).join('-').slice(0, 48)
const itemFile = n => join(dir('items'), `${n}.md`)
const read = n => {
  if (!existsSync(itemFile(n))) throw new Error(`No work item ${n} in .factory/items`)
  return readFileSync(itemFile(n), 'utf8')
}
const title = text => (text.match(/^#\s+(.+)$/m)?.[1] ?? `Work item`).trim()
/** Everything before the first `## comment`, then each comment. */
const parts = text => {
  const [body, ...comments] = text.split(/^## comment\s*$/m)
  return { body: body.trim(), comments: comments.map(c => c.trim()).filter(Boolean) }
}
const stdin = () => { try { return readFileSync(0, 'utf8') } catch { return '' } }
const say = value => process.stdout.write(JSON.stringify(value))
const url = n => `file://${itemFile(n)}`
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

const [verb, ...args] = process.argv.slice(2)
switch (verb) {
  case 'list': {
    const claims = dir('claims')
    say(readdirSync(dir('items'))
      .filter(f => f.endsWith('.md') && !existsSync(join(dir('items'), `${basename(f, '.md')}.closed`)))
      .map(f => basename(f, '.md'))
      .filter(n => !existsSync(join(claims, n)))
      .sort()
      .map(n => {
        const text = read(n)
        return { id: n, title: title(text), url: url(n), stack: /^###\s+PRs in order\s*$/m.test(text) }
      }))
    break
  }
  case 'read': {
    const n = id(args[0])
    if (existsSync(join(dir('items'), `${n}.closed`))) throw new Error(`Work item ${n} is closed`)
    const text = read(n)
    const { body, comments } = parts(text)
    // Local files have one author by construction: whoever can write the repo.
    say({ id: n, title: title(text), body: [body, ...comments].join('\n\n---\n\n'), url: url(n), author: 'local', comments })
    break
  }
  case 'claim': {
    const [n, owner] = [id(args[0]), args[1] ?? 'factory']
    const file = join(dir('claims'), n)
    try { closeSync(openSync(file, 'wx')) } // exclusive: two factories can't both take it
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const held = readFileSync(file, 'utf8').trim()
      if (held !== owner) throw new Error(`Work item ${n} is already running on ${held}`)
      say({ ok: true }); break
    }
    writeFileSync(file, owner)
    say({ ok: true })
    break
  }
  case 'release':
    rmSync(join(dir('claims'), id(args[0])), { force: true })
    say({ ok: true })
    break
  case 'comment': {
    const n = id(args[0])
    writeFileSync(itemFile(n), `${read(n).trimEnd()}\n\n## comment\n\n${stdin().trim()}\n`)
    say({ ok: true })
    break
  }
  case 'create': {
    const kind = args[0]
    if (!['task', 'child'].includes(kind)) throw new Error(`Unknown item kind: ${kind}`)
    const { title: heading, body, parent } = JSON.parse(stdin())
    const taken = new Set(readdirSync(dir('items')).map(f => basename(f, '.md')))
    const stem = slug(heading)
    let n = stem
    for (let i = 2; taken.has(n); i++) n = `${stem}-${i}`
    // A child is not startable on its own: its stack hands it to the lane.
    writeFileSync(itemFile(n), `# ${heading}\n\n${parent ? `Parent: ${parent}\n\n` : ''}${body.trim()}\n`)
    if (parent) writeFileSync(join(dir('claims'), n), `stack-${parent}`)
    say({ id: n })
    break
  }
  case 'retitle': {
    const n = id(args[0])
    const text = read(n)
    writeFileSync(itemFile(n), /^#\s+.+$/m.test(text) ? text.replace(/^#\s+.+$/m, `# ${stdin().trim()}`) : `# ${stdin().trim()}\n\n${text}`)
    say({ ok: true })
    break
  }
  case 'section': {
    const [n, name] = [id(args[0]), args[1]]
    const text = read(n)
    const heading = new RegExp(`^###\\s+${name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`, 'm')
    const match = heading.exec(text)
    if (!match) throw new Error(`Work item ${n} has no "### ${name}" section`)
    const start = match.index + match[0].length
    const next = text.slice(start).search(/^#{2,3}\s+/m)
    writeFileSync(itemFile(n), `${text.slice(0, start).trimEnd()}\n\n${stdin().trim()}\n\n${next === -1 ? '' : text.slice(start + next)}`)
    say({ ok: true })
    break
  }
  case 'state':
    say({ open: !existsSync(join(dir('items'), `${id(args[0])}.closed`)) })
    break
  case 'close': {
    const n = id(args[0])
    writeFileSync(join(dir('items'), `${n}.closed`), `${stdin().trim()}\n`)
    rmSync(join(dir('claims'), n), { force: true }) // a closed item is nobody's
    say({ ok: true })
    break
  }
  case 'deliver': {
    const [branch, target] = args
    const { title: heading, body } = JSON.parse(stdin())
    const file = join(dir('delivered'), `${branch.replace(/[^A-Za-z0-9._-]/g, '-')}.md`)
    writeFileSync(file, `# ${heading}\n\nMerge \`${branch}\` into \`${target}\`.\n\n${body.trim()}\n`)
    say({ url: `file://${file}` })
    break
  }
  case 'delivered': {
    // Accepted once the base branch contains the delivered branch's tip; there is nobody else to ask.
    const branch = basename(decodeURIComponent(args[0].replace(/^file:\/\//, '')), '.md')
    if (!existsSync(join(dir('delivered'), `${branch}.md`))) throw new Error(`No delivery record for ${branch}`)
    let merged = false
    try { merged = git('branch', '--contains', branch, '--list', base).length > 0 } catch {}
    say({ state: merged ? 'accepted' : 'open' })
    break
  }
  default:
    throw new Error(`Unknown tracker verb: ${verb}`)
}
