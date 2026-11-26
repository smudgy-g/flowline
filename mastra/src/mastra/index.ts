// Entry point for `mastra dev`: Studio and the board (http://localhost:4111/board), with the same factory the `fx` CLI uses.
import { DuckDBStore } from "@mastra/duckdb";
import { boardRoutes } from "../board.ts";
import { databaseUrl, observabilityPath } from "../database.ts";
import { realOps, realStackOps } from "../ops.ts";
import { createFactory, laneState, list } from "../runs.ts";
import { sandbox } from '../sandbox.ts';
import { config,factoryRoot } from '../config.ts';

export const mastra: ReturnType<typeof createFactory> = createFactory(
  realOps,
  databaseUrl,
  boardRoutes(() => mastra),
  realStackOps,
  await new DuckDBStore({
    path: observabilityPath,
    memoryLimit: "512MB",
  }).getStore("observability"),
);

// A sandbox is named after a work item, which a tracker id alone can't be read back out of: ask the runs which
// work items are live, and prune the rest. Never remove another install's VMs.
try {
  const live = new Set<string>();
  for (const run of await list(mastra)) {
    const item = (await laneState(mastra, run.runId))?.workItem;
    if (item) live.add(item);
  }
  for (const box of await sandbox.list()) {
    const m = /^fx-(uat-)?(.+)$/.exec(box.name);
    if (!m || live.has(m[2])) continue;
    const mount = box.workspaces?.[0];
    if (!(m[1] ? mount?.startsWith(`${factoryRoot}/.cache/run-`) && mount.endsWith('/scratch') : mount === `${config.worktrees}${m[2]}`)) continue;
    await sandbox.remove(m[2], !!m[1]);
  }
} catch (err) { console.warn('Sandbox reconciliation unavailable:', (err as Error).message); }
