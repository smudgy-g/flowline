// The project this factory works on: factory.config.json at the factory root. `workspace`, skill packs and the
// acceptance assets are relative to the factory root; the other paths are relative to `workspace`.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** The factory checkout this code runs from (FACTORY_ROOT when bundled by `mastra dev`). */
export const factoryRoot =
  process.env.FACTORY_ROOT ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SkillName = z.string().regex(/^[a-z0-9-]+$/);
/** An executable and its literal arguments; never a shell string. */
const Command = z.tuple([z.string().trim().min(1)]).rest(z.string());
/** A path inside the factory checkout, with no parent-directory escape. */
const FactoryPath = z.string().regex(/^(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_.][a-zA-Z0-9_./-]*$/);

const Config = z.strictObject({
  /** GitHub `owner/name` the issues and PRs live in. */
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  /** The branch every task builds on and its draft PR targets. */
  base: z.string().regex(/^[\w.-]+(\/[\w.-]+)*$/),
  workspace: z.string(),
  /** A read-only checkout of `base`, which owns the worktrees. */
  checkout: z.string(),
  /** Where the factory creates each task's worktree. */
  worktrees: z.string(),
  /** Outside the worktree, what agents may read (e.g. a schema repository). */
  readable: z.array(z.string()).default([]),
  paths: z.strictObject({
    /** Where the tester role may write. */
    tests: z.array(z.string().min(1)).min(1),
    /** A task may never change these. */
    protected: z.array(z.string().min(1)).default([]),
    /** Changes here are flagged for the human at the outcome gate. */
    sensitive: z.array(z.string().min(1)).default([]),
  }),
  /** The microVM each work item gets; every project command runs inside it. */
  sandbox: z.strictObject({
    /** The sandbox kit or image with the project's toolchain. */
    kit: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/),
    cpus: z.number().int().positive(),
    memory: z.string().regex(/^[1-9]\d*[mg]$/).refine(v => v.endsWith('g') || parseInt(v) >= 512, 'minimum 512m'),
    /** Hosts a build sandbox may reach, e.g. package registries. Acceptance always runs with none. */
    allowlist: z.array(z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/)).default([]),
    maxConcurrent: z.number().int().positive(),
  }),
  /** What the factory runs in a work item's sandbox, in order. */
  commands: z.strictObject({
    /** Files `{changedCode}` expands to, as globs. */
    changedCode: z.array(z.string().min(1)).min(1),
    /** Prepares a fresh worktree (install, codegen). */
    setup: z.array(Command).default([]),
    /** Formatters and fixers run before the checks judge the code. */
    autofix: z.array(Command).default([]),
    /** The coder's `check` tool: the fast checks, also run before the gates. */
    check: z.array(Command).default([]),
    /** Acceptance checks for a round, in order; must include the test suite. */
    gates: z.array(Command).min(1),
    /** Public test configuration for all of the above. Never credentials. */
    env: z.record(z.string(), z.string()).default({}),
    /** Optional: what `scripts/preview.sh` runs in the item's sandbox. */
    preview: Command.optional(),
  }),
  /** Black-box acceptance of the pushed commit, in a fresh sandbox with no network. */
  acceptance: z.strictObject({
    /** Factory paths archived from the approved commit; the adapter and its fixtures. */
    inputs: z.array(FactoryPath).min(1),
    /** Run from the pinned inputs; prints the verdict as JSON on stdout. */
    command: Command,
    /** Optional operator-owned directory (images, fixtures) mounted read-only. */
    assets: FactoryPath.optional(),
    env: z.record(z.string(), z.string()).default({}),
  }),
  skills: z.strictObject({
    /** Folders of skills (e.g. skills/core), all copied into each worktree's .agents/skills. */
    packs: z.array(z.string()).min(1),
    coder: z.strictObject({
      /** Given to every coder call. */
      always: z.array(SkillName),
      /** Parts of the codebase: a coder call touching (or planned to touch) a matching path gets its skills. */
      areas: z
        .record(z.string(), z.strictObject({ paths: z.array(z.string()).min(1), skills: z.array(SkillName) }))
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
  paths: raw.paths,
  sandbox: raw.sandbox,
  commands: raw.commands,
  acceptance: {
    ...raw.acceptance,
    assets: raw.acceptance.assets && resolve(factoryRoot, raw.acceptance.assets),
  },
  skills: {
    ...raw.skills,
    packs: raw.skills.packs.map((pack) => resolve(factoryRoot, pack)),
  },
  readable: raw.readable.map(at),
};
