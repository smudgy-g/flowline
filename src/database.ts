import { stateRoot } from "./config.ts";

/** Run state lives beside the code, outside git (.data/ is ignored). */
export const databaseUrl = `file:${stateRoot}/factory.db`;


