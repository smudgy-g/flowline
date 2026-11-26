// The project this factory works on: factory.config.json at the factory root. Paths are relative to `workspace`,
// which is relative to the factory root.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** The factory checkout this code runs from (FACTORY_ROOT when bundled by `mastra dev`). */
export const factoryRoot =
  process.env.FACTORY_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const Config = z.object({
  /** GitHub `owner/name` the issues and PRs live in. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  /** The branch every task builds on and its draft PR targets. */
  base: z.string().regex(/^[\w.-]+(\/[\w.-]+)*$/),
  workspace: z.string(),
  /** A read-only checkout of `base`, which owns the worktrees. */
  checkout: z.string(),
  /** Where the factory creates each task's worktree. */
  worktrees: z.string(),
  /** Copied into each worktree as .agents/skills. */
  skills: z.string(),
  /** Outside the worktree, what agents may read (e.g. the schema repo). */
  readable: z.array(z.string()).default([]),
});

const raw = Config.parse(
  JSON.parse(readFileSync(`${factoryRoot}/factory.config.json`, "utf8")),
);
const workspace = resolve(factoryRoot, raw.workspace);
const at = (path: string) => resolve(workspace, path);

export const config = {
  repo: raw.repo,
  base: raw.base,
  workspace,
  checkout: at(raw.checkout),
  /** Ends in `/`, so a prefix check can't match a sibling directory. */
  worktrees: `${at(raw.worktrees)}/`,
  skills: at(raw.skills),
  readable: raw.readable.map(at),
};
