// Starting, reading and resuming runs: fast-lane tasks and stacks. The `fx` CLI, the board and the tests go through here.
import { Mastra } from '@mastra/core/mastra'
import { MastraCompositeStore, type ObservabilityStorage } from '@mastra/core/storage'
import type { ApiRoute } from '@mastra/core/server'
import { createWorkflowStateReader } from '@mastra/core/workflows'
import { LibSQLStore } from '@mastra/libsql'
import { PinoLogger } from '@mastra/loggers'
import { MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability'
import { createFastLane, initialState, type LaneState, type Ops } from './fast-lane.ts'
import { createStack, initialStackState, type Members, type StackOps, type StackState } from './stack.ts'

const noStackOps = new Proxy({} as StackOps, { get: () => async () => { throw new Error('This factory has no stack ops') } })

/**
 * `apiRoutes` adds pages to the `mastra dev` server (the board); the CLI and tests leave it out. `observability`, the
 * server's only, is where Studio's traces and logs go (a DuckDB file takes one process, so the CLI can't share it).
 */
export function createFactory(ops: Ops, databaseUrl: string, apiRoutes: ApiRoute[] = [], stackOps: StackOps = noStackOps, observability?: ObservabilityStorage) {
  // A stack's members are fast-lane runs in this same factory, which exists once the constructor returns.
  const self: { factory?: any } = {}
  const members: Members = {
    start: (issue: number, base: string): Promise<unknown> => start(self.factory, issue, base),
    has: async (issue: number): Promise<boolean> => !!await find(self.factory, runIdFor(issue)),
  }
  const runs = new LibSQLStore({ id: 'factory', url: databaseUrl })
  const mastra = new Mastra({
    workflows: {
      fastLane: createFastLane(ops),
      stack: createStack(stackOps, members),
    },
    storage: observability ? new MastraCompositeStore({ id: 'factory', default: runs, domains: { observability } }) : runs,
    // Only the laptop's board tunnels may call the API from a browser: this factory's (4111) and a second
    // factory's (4112), whose cards the board merges in. Mastra's default lets any web page call it.
    server: { apiRoutes, cors: { origin: BOARD_ORIGINS } },
    ...(observability && {
      logger: new PinoLogger({ name: 'factory', level: 'info' }),
      observability: new Observability({
        configs: {
          default: {
            serviceName: 'factory',
            logging: { level: 'info' },
            exporters: [new MastraStorageExporter()],
            spanOutputProcessors: [new SensitiveDataFilter()],
          },
        },
      }),
    }),
  })
  self.factory = mastra
  return mastra
}
export type Factory = ReturnType<typeof createFactory>

export const BOARD_ORIGINS = [4111, 4112].flatMap(port => [`http://localhost:${port}`, `http://127.0.0.1:${port}`])

/** One run per issue (task or stack), so a second start for the same issue is refused. */
export const runIdFor = (issue: number) => `issue-${issue}`

/** Workflow key in the factory, and the id its snapshots are stored under. */
const WORKFLOWS = [['fastLane', 'fast-lane'], ['stack', 'stack']] as const
type Kind = typeof WORKFLOWS[number][0]
async function find(factory: Factory, runId: string) {
  for (const [key, name] of WORKFLOWS) {
    const run = await factory.getWorkflow(key).getWorkflowRunById(runId)
    if (run) return { key, name, run }
  }
  return null
}

/**
 * `step` is the step running, waiting or failed (or the last one to finish), and `since` when it started or
 * began waiting.
 */
export type RunView = { runId: string; workflow: Kind; status: string; step?: string; since?: number; waiting?: { step: string; kind: string; message: string; [key: string]: unknown }; error?: string; prUrl?: string }

export async function view(factory: Factory, runId: string): Promise<RunView | null> {
  const found = await find(factory, runId)
  if (!found) return null
  const { run } = found
  const reader = createWorkflowStateReader(run)
  const waiting = reader.getSuspendedStep()
  type StepRecord = { status: string; startedAt?: number; suspendedAt?: number; endedAt?: number }
  const steps = Object.entries((run.steps ?? {}) as Record<string, StepRecord>)
  const depth = (key: string) => key.split('.').length
  const [key, step] = steps.filter(([, s]) => ['running', 'suspended', 'failed'].includes(s.status)).sort(([a], [b]) => depth(b) - depth(a))[0]
    ?? steps.sort(([, a], [, b]) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0] ?? []
  return {
    runId, workflow: found.key, status: run.status,
    ...(key ? { step: key.split('.').at(-1), since: step!.suspendedAt ?? step!.startedAt } : {}),
    ...(waiting ? { waiting: { step: waiting.path.at(-1) ?? waiting.stepId, ...waiting.suspendPayload } } : {}),
    ...(run.error ? { error: String((run.error as { message?: string }).message ?? run.error) } : {}),
    ...((run.result as { prUrl?: string } | undefined)?.prUrl ? { prUrl: (run.result as { prUrl: string }).prUrl } : {}),
  }
}

async function snapshot(factory: Factory, workflowName: string, runId: string) {
  const store = await factory.getStorage()?.getStore('workflows')
  return (await store?.loadWorkflowSnapshot({ workflowName, runId }))?.value ?? null
}
/** The lane's own state (issue, plan, worktree, cycles, review notes, UAT report) as last saved. */
export async function laneState(factory: Factory, runId: string): Promise<LaneState | null> {
  return snapshot(factory, 'fast-lane', runId) as Promise<LaneState | null>
}
/** A stack's own state (issue, branch, members, design, current member). */
export async function stackState(factory: Factory, runId: string): Promise<StackState | null> {
  return snapshot(factory, 'stack', runId) as Promise<StackState | null>
}

/** Forgets a run: the board stops showing it. Its PR and issue on GitHub are the record. */
export async function forget(factory: Factory, runId: string): Promise<void> {
  const found = await find(factory, runId)
  const store = await factory.getStorage()?.getStore('workflows')
  if (found) await store?.deleteWorkflowRunById({ workflowName: found.name, runId })
}

export async function list(factory: Factory): Promise<RunView[]> {
  const ids = (await Promise.all(WORKFLOWS.map(async ([key]) => (await factory.getWorkflow(key).listWorkflowRuns()).runs as Array<{ runId: string }>))).flat()
  const views = await Promise.all(ids.map(run => view(factory, run.runId)))
  return views.filter((v): v is RunView => v !== null)
}

/** Runs until the lane waits for someone or finishes. */
export async function start(factory: Factory, issue: number, base = 'staging'): Promise<RunView> {
  const runId = runIdFor(issue)
  if (await view(factory, runId)) throw new Error(`Issue #${issue} already has a run (${runId})`)
  const run = await factory.getWorkflow('fastLane').createRun({ runId })
  await run.start({ inputData: { issue, base }, initialState: initialState() })
  return (await view(factory, runId))!
}

/** Starts a stack for a Factory stack issue; runs until it waits for the design. */
export async function startStack(factory: Factory, issue: number): Promise<RunView> {
  const runId = runIdFor(issue)
  if (await view(factory, runId)) throw new Error(`Issue #${issue} already has a run (${runId})`)
  const run = await factory.getWorkflow('stack').createRun({ runId })
  await run.start({ inputData: { issue }, initialState: initialStackState() })
  return (await view(factory, runId))!
}

export type ResumeData = { retry?: boolean; note?: string; proceed?: boolean; baseline?: string; plan?: { summary: string; tests: string }; approve?: boolean; reject?: string; findings?: unknown[]; design?: string; split?: string[]; useProposed?: boolean }

export async function resume(factory: Factory, runId: string, data: ResumeData): Promise<RunView> {
  const found = await find(factory, runId)
  const current = found && await view(factory, runId)
  if (!found || !current?.waiting) throw new Error(`${runId} is not waiting (status: ${current?.status ?? 'unknown'})`)
  const run = await factory.getWorkflow(found.key).createRun({ runId })
  await run.resume({ step: createWorkflowStateReader(found.run).getSuspendedStep()!.path, resumeData: data as any })
  return (await view(factory, runId))!
}

/** Runs a pause stopped that may go on now: `target` (a run id, or every run for 'all') and no longer paused. */
export async function resumable(factory: Factory, target: string, paused: (runId: string) => Promise<boolean>): Promise<string[]> {
  const ids: string[] = []
  for (const v of await list(factory))
    if (v.waiting?.kind === 'paused' && (target === 'all' || v.runId === target) && !await paused(v.runId)) ids.push(v.runId)
  return ids
}

/** Continues a run whose process died mid-step (status stays 'running'). */
export async function restart(factory: Factory, runId: string): Promise<RunView> {
  const found = await find(factory, runId)
  if (!found) throw new Error(`No run ${runId}`)
  const run = await factory.getWorkflow(found.key).createRun({ runId })
  await run.restart()
  return (await view(factory, runId))!
}
