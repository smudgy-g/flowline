// fx: drive fast-lane runs from a terminal. Each command runs the lane until it next waits for someone.
//
//   fx start <issue>                          start a run for a GitHub issue in the client repo
//   fx status [<issue>]                       list runs, or show what one is waiting for
//   fx plan <issue> --summary S --tests T     driver: record the agreed plan
//   fx approve <issue> [--baseline SHA]       human: approve the plan or outcome shown (needs a terminal);
//                                             --baseline also moves UAT to a later factory commit
//   fx reject <issue> <why>                   human: send the plan or outcome back
//   fx findings <issue> <findings.json>       driver: record review findings the reviewer could not format
//   fx retry <issue> [--note N] [--proceed] [--baseline SHA]
//                                             continue after a factory fix; --proceed tests the change without a
//                                             coder round, --baseline moves UAT to a later factory commit
//   fx restart <issue>                        continue a run whose process died mid-step
//   fx pause <issue|all>                      stop the run (or every run) before its next step, e.g. for a sync
//   fx resume <issue|all>                     lift the pause; paused runs carry on from where they stopped
import { mkdir, readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { databaseUrl } from './database.ts'
import { factoryRoot, paused, realOps, realStackOps, setPaused } from './ops.ts'
import { createFactory, list, restart, resumable, resume, runIdFor, start, view, type RunView } from './runs.ts'

function show(v: RunView) {
  console.log(`${v.runId}: ${v.status}${v.prUrl ? ` ${v.prUrl}` : ''}${v.error ? `\n  error: ${v.error}` : ''}`)
  if (!v.waiting) return
  const { step, kind, message, ...details } = v.waiting
  console.log(`  waiting at ${step} (${kind}): ${message}`)
  for (const [key, value] of Object.entries(details)) console.log(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
}

/**
 * Approval needs a person at a terminal who types the issue number. This keeps the driver Pi from approving
 * by accident; it is not a security boundary against an agent with a shell in the same VM (README.md).
 */
async function confirm(v: RunView, issue: string): Promise<true> {
  const kind = v.waiting?.kind
  if (kind !== 'plan-approval' && kind !== 'outcome-approval') throw new Error(`${v.runId} is not waiting for an approval (${kind ?? v.status})`)
  if (!process.stdin.isTTY) throw new Error('fx approve needs an interactive terminal; only a human approves')
  show(v)
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await prompt.question(`Type ${issue} to approve this ${kind === 'plan-approval' ? 'plan' : 'outcome'}: `)
  prompt.close()
  if (answer.trim() !== issue) throw new Error('Not approved')
  return true
}

async function main() {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { summary: { type: 'string' }, tests: { type: 'string' }, json: { type: 'boolean' }, note: { type: 'string' }, proceed: { type: 'boolean' }, baseline: { type: 'string' } } })
  const [command, issueArg, ...rest] = positionals
  await mkdir(`${factoryRoot}/mastra/.data`, { recursive: true })
  const factory = createFactory(realOps, databaseUrl, [], realStackOps)
  const issue = issueArg ?? ''
  const id = runIdFor(issue)
  const needIssue = () => { if (!/^[A-Za-z0-9._-]{1,64}$/.test(issue)) throw new Error(`fx ${command} <work item>`) }
  const print = (v: RunView | RunView[]) => values.json ? console.log(JSON.stringify(v, null, 2)) : [v].flat().forEach(show)

  switch (command) {
    case 'start': needIssue(); return print(await start(factory, issue))
    case 'status': {
      if (!issueArg) return print(await list(factory))
      needIssue()
      const v = await view(factory, id)
      if (!v) throw new Error(`No run for issue #${issue}`)
      return print(v)
    }
    case 'plan':
      needIssue()
      if (!values.summary || !values.tests) throw new Error('fx plan <issue> --summary "..." --tests "..."')
      return print(await resume(factory, id, { plan: { summary: values.summary, tests: values.tests } }))
    case 'approve': {
      needIssue()
      const v = await view(factory, id)
      if (!v) throw new Error(`No run for issue #${issue}`)
      return print(await resume(factory, id, { approve: await confirm(v, issue), baseline: values.baseline }))
    }
    case 'reject':
      needIssue()
      if (!rest.length) throw new Error('fx reject <issue> "<why>"')
      return print(await resume(factory, id, { reject: rest.join(' ') }))
    case 'findings':
      needIssue()
      return print(await resume(factory, id, { findings: JSON.parse(await readFile(rest[0], 'utf8')).findings }))
    case 'retry': needIssue(); return print(await resume(factory, id, { retry: true, note: values.note, proceed: values.proceed, baseline: values.baseline }))
    case 'restart': needIssue(); return print(await restart(factory, id))
    case 'pause':
    case 'resume': {
      if (issueArg !== 'all') needIssue()
      const target = issueArg === 'all' ? 'all' : id
      await setPaused(target, command === 'pause')
      if (command === 'pause') return console.log(`${target}: pausing before the next step`)
      const ids = await resumable(factory, target, paused)
      if (!ids.length) console.log(`${target}: not paused any more; no run was waiting on the pause`)
      // Together, as the board does: each runs until it next waits.
      return (await Promise.all(ids.map(runId => resume(factory, runId, {})))).forEach(v => print(v))
    }
    default:
      console.log((await readFile(new URL(import.meta.url), 'utf8')).split('\n').filter(l => l.startsWith('//')).slice(0, 14).join('\n').replaceAll('// ', '').replaceAll('//', ''))
  }
}

main().catch(error => { console.error(`fx: ${error.message}`); process.exitCode = 1 })
