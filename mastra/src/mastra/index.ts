// Entry point for `mastra dev`: Studio and the board (http://localhost:4111/board), with the same factory the `fx` CLI uses.
import { DuckDBStore } from "@mastra/duckdb";
import { boardRoutes } from "../board.ts";
import { databaseUrl, observabilityPath } from "../database.ts";
import { realOps, realStackOps } from "../ops.ts";
import { createFactory } from "../runs.ts";

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
