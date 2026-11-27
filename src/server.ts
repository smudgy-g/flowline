// The board server: the same factory the CLI builds, with the board's routes on a plain HTTP server bound to
// loopback. `frankenstein board` runs this.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { mkdir } from "node:fs/promises";
import { boardRoutes } from "./board.ts";
import { config, projectRoot, stateRoot } from "./config.ts";
import { databaseUrl } from "./database.ts";
import { realOps, realStackOps } from "./ops.ts";
import { BOARD_ORIGINS, createFactory, laneState, list } from "./runs.ts";
import { sandbox } from "./sandbox.ts";

export async function startBoard(port = Number(process.env.PORT) || 4111, identity?: string) {
  await mkdir(stateRoot, { recursive: true });

  const factory: ReturnType<typeof createFactory> = createFactory(
    realOps,
    databaseUrl,
    boardRoutes(() => factory),
    realStackOps,
  );

  const app = new Hono();
  app.use("*", cors({ origin: BOARD_ORIGINS }));

  if (identity) app.get('/board/_identity', c => c.json({ identity, pid: process.pid }));

  // Mastra's ApiRoute union hides `handler` from the type, but a registered route always carries one.
  for (const route of (factory.getServer()?.apiRoutes ?? []) as Array<{ method: string; path: string; handler?: any }>)
    if (route.handler) app.on(route.method, route.path, route.handler);

  // Bound before anything is reported, and a busy port is a sentence, not a stack trace.
  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => resolve(s));
    s.on("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE"
        ? new Error(`Port ${port} is already in use (another board, or an SSH tunnel). Free it, or run with PORT=<other>.`)
        : err));
  });

  await pruneSandboxes(factory);
  return { factory, server, url: `http://localhost:${port}/board` };
}

/**
 * A sandbox is named after a work item, which a tracker id alone can't be read back out of: ask the runs which work
 * items are live, and prune the rest. Never remove another project's VMs.
 */
async function pruneSandboxes(factory: ReturnType<typeof createFactory>) {
  try {
    const live = new Set<string>();

    for (const run of await list(factory)) {
      const item = (await laneState(factory, run.runId))?.workItem;

      if (item) live.add(item);
    }

    for (const box of await sandbox.list()) {
      const m = /^fx-(uat-)?(.+)$/.exec(box.name);

      if (!m || live.has(m[2])) continue;

      const mount = box.workspaces?.[0];

      const mine = m[1]
        ? mount?.startsWith(`${stateRoot}/cache/run-`) && mount.endsWith("/scratch")
        : mount === `${config.worktrees}${m[2]}`;

      if (mine) await sandbox.remove(m[2], !!m[1]);
    }
  } catch (err) {
    console.warn("Sandbox reconciliation unavailable:", (err as Error).message);
  }
}

if (import.meta.filename === process.argv[1]) {
  const { url } = await startBoard();
  console.log(`${config.repo} · ${projectRoot}\n${url}`);
}
