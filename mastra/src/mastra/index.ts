// Entry point for `mastra dev`: Studio and the board (http://localhost:4111/board), with the same factory the `fx` CLI uses.
import { DuckDBStore } from "@mastra/duckdb";
import { boardRoutes } from "../board.ts";
import { databaseUrl, observabilityPath } from "../database.ts";
import { realOps, realStackOps } from "../ops.ts";
import { createFactory, runIdFor, view } from "../runs.ts";
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

// Query by issue, not a paginated board list. Never remove another install's VMs.
try {
  for (const box of await sandbox.list()) {
    const m = /^fx-(uat-)?(([A-Za-z0-9._-]+?)(?:-[a-z0-9-]+)?)$/.exec(box.name);
    if (!m) continue;
    const mount = box.workspaces?.[0];
    if (!(m[1] ? mount?.startsWith(`${factoryRoot}/.cache/run-`) && mount.endsWith('/scratch') : mount === `${config.worktrees}${m[2]}`)) continue;
    if (!await view(mastra,runIdFor(m[3]))) await sandbox.remove(m[2],!!m[1]);
  }
} catch (err) { console.warn('Sandbox reconciliation unavailable:', (err as Error).message); }
