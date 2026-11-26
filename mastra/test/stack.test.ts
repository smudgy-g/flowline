// Drives a whole stack with fake GitHub: design gate, sub-issues, a by-hand member, fast-lane members, the stack PR.
import './workflow-profile.ts'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Ops } from '../src/fast-lane.ts'
import type { StackOps } from '../src/stack.ts'
import { card } from '../src/board.ts'
import { createFactory, laneState, resume, runIdFor, stackState, startStack, view } from '../src/runs.ts'

const parentBody = '### Outcome\n\nImport offers\n\n### PRs in order\n\n1. Database (by hand)\n2. Read offers\n3. Review them\n\n### Lane\n\nfast lane'

function fakes() {
  const calls: string[] = []
  const history: string[] = []
  const designs: string[] = []
  const open = new Set<number>()
  let next = 1424
  const splits = new Map<number, string[]>()
  let reviewReply = (_prompt: string) => '```json\n{"findings":[]}\n```'
  const stackOps: StackOps = {
    paused: async () => false,
    readIssue: async number => ({ number, title: 'Import offers', body: parentBody, url: 'u', author: 'adam', comments: ['## Draft design'] }),
    claim: async n => { history.push(`claimed #${n}`) },
    createStackBranch: async branch => { calls.push(`branch ${branch}`) },
    createSubIssue: async (parent, title, _body, after) => { const n = next++; open.add(n); calls.push(`sub #${n} of #${parent}: ${title}${after ? ` after #${after}` : ''}`); return n },
    retitleIssue: async (n, title) => { calls.push(`retitle #${n}: ${title}`) },
    updateIssueSection: async (n, name, text) => { calls.push(`#${n} ${name}: ${text.replace(/\n/g, ' / ')}`) },
    withReviewCheckout: async work => work(async prompt => reviewReply(prompt)),
    splitOf: async (_branch, member) => splits.get(member) ?? [],
    issueOpen: async n => open.has(n),
    closeIssue: async (n, comment) => { open.delete(n); calls.push(`close #${n}: ${comment}`) },
    openStackPr: async branch => { calls.push(`stack pr ${branch}`); return 'https://github.com/x/pull/9' },
    record: async (_branch, title) => { history.push(title) },
    saveDesign: async (_branch, design) => { designs.push(design) },
  }
  // Fast-lane members only need to reach their first wait (the plan).
  const ops = { readIssue: async (number: number) => ({ number, title: 'member', body: '', url: 'u', author: 'adam', comments: [] }), claim: async () => {}, branchExists: async () => false, uatBaseline: async () => 'f'.repeat(40), provision: async (branch: string) => `/wt/${branch}`, runPi: async () => 'no plan', record: async () => {} } as unknown as Ops
  return { calls, history, designs, open, stackOps, ops, splits, setReviewer: (f: (prompt: string) => string) => { reviewReply = f } }
}

test('stack: design gate, sub-issues once, by-hand member, members in order on the stack branch, stack PR', async () => {
  const { calls, history, designs, open, stackOps, ops } = fakes()
  const db = `file:${join(mkdtempSync(join(tmpdir(), 'fx-')), 'factory.db')}`
  const fx = () => createFactory(ops, db, [], stackOps)
  const id = runIdFor(1423)

  let v = await startStack(fx(), 1423)
  assert.equal(v.workflow, 'stack')
  assert.equal(v.waiting?.kind, 'design')
  assert.equal(v.waiting?.draft, '## Draft design')
  const pick = (c: any) => c && { column: c.column, kind: c.kind, status: c.status }
  assert.deepEqual(pick(await card(fx(), id)), { column: 'Stacks', kind: 'needs', status: 'Agree the design' })
  v = await resume(fx(), id, { design: 'Tables X and Y' })
  assert.equal(v.waiting?.kind, 'design-approval')
  v = await resume(fx(), id, { reject: 'name the shared shape' })
  assert.equal(v.waiting?.kind, 'design')
  assert.match(v.waiting!.message, /name the shared shape/)
  await resume(fx(), id, { design: 'Tables X and Y; shape Z' })
  v = await resume(fx(), id, { approve: true })

  // Sub-issues made in order on the stack branch; the first member is by hand.
  assert.deepEqual(calls.slice(0, 4), ['branch stack/1423-import-offers', 'sub #1424 of #1423: 1/3 Database', 'sub #1425 of #1423: 2/3 Read offers', 'sub #1426 of #1423: 3/3 Review them'])
  assert.equal((await stackState(fx(), id))?.design, 'Tables X and Y; shape Z')
  assert.equal(v.waiting?.kind, 'by-hand')
  assert.equal(v.waiting?.number, 1424)

  // A retry re-runs the step without creating sub-issues again.
  v = await resume(fx(), id, { retry: true })
  assert.equal(calls.filter(c => c.startsWith('sub ')).length, 3)
  assert.equal(v.waiting?.kind, 'by-hand')

  // Done: the by-hand issue closes and member 2 starts as a fast-lane run on the stack branch.
  v = await resume(fx(), id, { approve: true })
  assert.ok(calls.includes('close #1424: Done by hand.'))
  assert.equal(v.waiting?.kind, 'member-running')
  assert.equal(v.waiting?.number, 1425)
  assert.equal((await view(fx(), runIdFor(1425)))?.waiting?.kind, 'plan')
  assert.equal((await laneState(fx(), runIdFor(1425)))?.base, 'stack/1423-import-offers')
  assert.deepEqual(pick(await card(fx(), id)), { column: 'Stacks', kind: 'running', status: 'PR 2 of 3: #1425' })
  assert.deepEqual(pick(await card(fx(), runIdFor(1425))), { column: 'Plan', kind: 'needs', status: 'Agree a plan' })

  // Checking again while it runs changes nothing; once its issue is closed (cleaned up), member 3 starts.
  v = await resume(fx(), id, { retry: true })
  assert.equal(v.waiting?.number, 1425)
  open.delete(1425)
  v = await resume(fx(), id, { retry: true })
  assert.equal(v.waiting?.number, 1426)
  assert.equal((await stackState(fx(), id))?.current, 2)

  open.delete(1426)
  v = await resume(fx(), id, { retry: true })
  assert.equal(v.status, 'success')
  assert.equal(v.prUrl, 'https://github.com/x/pull/9')
  assert.equal(calls.at(-1), 'stack pr stack/1423-import-offers')

  // The stack's written history, which each member gets a copy of.
  assert.equal(designs.length, 1)
  assert.deepEqual(history, [
    'claimed #1423',
    'You sent the design back', 'You approved the design',
    'Sub-issue #1424 created', 'Sub-issue #1425 created', 'Sub-issue #1426 created',
    'PR 1 of 3 finished',
    'PR 2 of 3 started', 'PR 2 of 3 finished',
    'PR 3 of 3 started', 'PR 3 of 3 finished',
    'Stack PR opened',
  ])
})

test('stack: a body without a PR list, or another lane, stops at intake', async () => {
  const { stackOps, ops } = fakes()
  stackOps.readIssue = async number => ({ number, title: 'T', body: '### PRs in order\n\n1. A\n\n### Lane\n\nslow lane', url: 'u', author: 'adam', comments: [] })
  const db = `file:${join(mkdtempSync(join(tmpdir(), 'fx-')), 'factory.db')}`
  const v = await startStack(createFactory(ops, db, [], stackOps), 5)
  assert.equal(v.waiting?.kind, 'error')
  assert.match(v.waiting!.message, /use fast lane or standard/)
})

test('standard stack: design reviewed, proposed PR list approved, a member split inserted after it', async () => {
  const { calls, history, open, stackOps, ops, splits, setReviewer } = fakes()
  stackOps.readIssue = async number => ({ number, title: 'Import offers', body: parentBody.replace('fast lane', 'standard'), url: 'u', author: 'adam', comments: [] })
  setReviewer(prompt => prompt.includes('/skill:plan-fitness')
    ? '```json\n{"findings":[{"severity":"high","file":"issue","line":0,"description":"Read offers is two PRs"}]}\n```\nProposed PRs:\n1. Database (by hand)\n2. Read offers\n3. Review them'
    : '```json\n{"findings":[]}\n```')
  const db = `file:${join(mkdtempSync(join(tmpdir(), 'fx-')), 'factory.db')}`
  const fx = () => createFactory(ops, db, [], stackOps)
  const id = runIdFor(1423)

  await startStack(fx(), 1423)
  let v = await resume(fx(), id, { design: 'Tables X and Y' })
  assert.equal(v.waiting?.kind, 'design-approval')
  assert.deepEqual((v.waiting!.findings as Array<{ description: string }>).map(f => f.description), ['[plan-fitness] Read offers is two PRs'])
  assert.deepEqual(v.waiting!.proposed, [{ title: 'Database', byHand: true }, { title: 'Read offers', byHand: false }, { title: 'Review them', byHand: false }])
  assert.ok(history.includes('Design review: 1 finding'))

  // Shorten the proposal to see it applied: approving with it rewrites the parent's list and makes its sub-issues.
  setReviewer(() => '```json\n{"findings":[]}\n```\nProposed PRs:\n1. Read offers\n2. Review them')
  v = await resume(fx(), id, { reject: 'drop the database PR' })
  v = await resume(fx(), id, { design: 'Tables X and Y, existing' })
  v = await resume(fx(), id, { approve: true, useProposed: true })
  assert.ok(calls.includes('#1423 PRs in order: 1. Read offers / 2. Review them'))
  assert.deepEqual(calls.filter(c => c.startsWith('sub ')), ['sub #1424 of #1423: 1/2 Read offers', 'sub #1425 of #1423: 2/2 Review them'])
  assert.equal(v.waiting?.number, 1424)
  assert.equal((await laneState(fx(), runIdFor(1424)))?.base, 'stack/1423-import-offers')

  // Member 1 was split into two more PRs at its plan approval; when it finishes they go right after it.
  splits.set(1424, ['Read offers: background job', 'Read offers: retries'])
  open.delete(1424)
  v = await resume(fx(), id, { retry: true })
  assert.deepEqual(calls.filter(c => c.startsWith('sub ')).slice(2), [
    'sub #1426 of #1423: 2/4 Read offers: background job after #1424',
    'sub #1427 of #1423: 3/4 Read offers: retries after #1426',
  ])
  assert.ok(calls.includes('#1423 PRs in order: 1. Read offers / 2. Read offers: background job / 3. Read offers: retries / 4. Review them'))
  assert.ok(calls.includes('retitle #1425: 4/4 Review them'))
  assert.equal(v.waiting?.number, 1426)
  // A retry inserts nothing twice.
  v = await resume(fx(), id, { retry: true })
  assert.equal((await stackState(fx(), id))?.members.length, 4)
  assert.equal(calls.filter(c => c.startsWith('sub ')).length, 4)
})
