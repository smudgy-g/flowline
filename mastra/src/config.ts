// The project this factory works on: factory.config.json at the factory root. `workspace` and skill packs are
// relative to the factory root; the other paths are relative to `workspace`.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** The factory checkout this code runs from (FACTORY_ROOT when bundled by `mastra dev`). */
export const factoryRoot =
  process.env.FACTORY_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SkillName = z.string().regex(/^[a-z0-9-]+$/);

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
  /** Outside the worktree, what agents may read (e.g. the schema repo). */
  readable: z.array(z.string()).default([]),
  skills: z.object({
    /** Folders of skills (e.g. skills/core, skills/nuxt), all copied into each worktree's .agents/skills. */
    packs: z.array(z.string()).min(1),
    coder: z.object({
      /** Given to every coder call. */
      always: z.array(SkillName),
      /** Parts of the codebase: a coder call touching (or planned to touch) a matching path gets its skills. */
      areas: z
        .record(
          z.string(),
          z.object({ paths: z.array(z.string()).min(1), skills: z.array(SkillName) }),
        )
        .default({}),
    }),
    /** The standard lane's extra code reviewers, beside the usual one. */
    codeReviewers: z.array(SkillName).default([]),
  }),
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
  skills: {
    ...raw.skills,
    packs: raw.skills.packs.map((pack) => resolve(factoryRoot, pack)),
  },
  readable: raw.readable.map(at),
};
