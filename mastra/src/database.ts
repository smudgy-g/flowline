import { factoryRoot } from "./ops.ts";

/** Run state lives beside the code, outside git (.data/ is ignored). */
export const databaseUrl = `file:${factoryRoot}/mastra/.data/factory.db`;

/** Studio's traces and logs (the board server only). */
export const observabilityPath = `${factoryRoot}/mastra/.data/observability.duckdb`;
