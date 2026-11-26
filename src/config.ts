// Three roots, never one: the installed package (code, skills, trackers), the project (its repo, holding
// `.factory/config.json` and the acceptance adapter), and this machine's state for that project.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** Where the factory's own code, skills and trackers live. */
export const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The project this factory works on: the nearest ancestor of the working directory holding `.factory/config.json`. */
export const projectRoot = (() => {
  const asked = process.env.FACTORY_PROJECT;
  if (asked) return resolve(asked);
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".factory/config.json"))) return dir;
    if (dirname(dir) === dir)
      throw new Error("No .factory/config.json here or above. Run `frankenstein setup` in your repository.");
  }
})();

/**
 * Run state for this project on this machine: never in the repository, and keyed by its path so two checkouts of
 * the same repo cannot share a database.
 */
export const stateRoot =
  process.env.FACTORY_STATE ??
  join(
    process.env.XDG_STATE_HOME || join(homedir(), ".local/state"),
    "frankenstein",
    `${basename(projectRoot)}-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 8)}`,
  );

const SkillName = z.string().regex(/^[a-z0-9-]+$/);
/** An executable and its literal arguments; never a shell string. */
const Command = z.tuple([z.string().trim().min(1)]).rest(z.string());
/** A path inside the project, with no parent-directory escape. */
const ProjectPath = z.string().regex(/^(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_.][a-zA-Z0-9_./-]*$/);

const Config = z.strictObject({
  /** What the tracker calls this project, e.g. a GitHub `owner/name`. Defaults to the `origin` remote. */
  repo: z.string().min(1).optional(),
  /** The branch every task builds on and a finished change is aimed at. */
  base: z.string().regex(/^[\w.-]+(\/[\w.-]+)*$/).default("main"),
  /** Where the factory creates each task's worktree, relative to the project. */
  worktrees: z.string().default("../{repo}-worktrees"),
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
  /** Where work items come from and where a finished change goes (docs/tracker.md); files in the repo by default. */
  tracker: z.strictObject({ command: Command.optional(), env: z.record(z.string(), z.string()).default({}) }).prefault({}),
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
    /** Project paths archived from the base branch; the adapter and its fixtures. A task branch cannot change them. */
    inputs: z.array(ProjectPath).min(1).default([".factory/acceptance"]),
    /** Run from the pinned inputs; prints the verdict as JSON on stdout. */
    command: Command.default(["bash", ".factory/acceptance/run.sh"]),
    /** Optional operator-owned directory (images, fixtures) mounted read-only; absolute, or relative to the project. */
    assets: z.string().optional(),
    env: z.record(z.string(), z.string()).default({}),
  }).prefault({}),
  skills: z.strictObject({
    /** Skill packs copied into each worktree's .agents/skills: a bare name ships with the factory, a path is yours. */
    packs: z.array(z.string()).min(1).default(["core"]),
    coder: z.strictObject({
      /** Given to every coder call. */
      always: z.array(SkillName).default([]),
      /** Parts of the codebase: a coder call touching (or planned to touch) a matching path gets its skills. */
      areas: z
        .record(z.string(), z.strictObject({ paths: z.array(z.string()).min(1), skills: z.array(SkillName) }))
        .default({}),
    }).prefault({}),
    /** The standard lane's extra code reviewers, beside the usual one. */
    codeReviewers: z.array(SkillName).default([]),
  }).prefault({}),
});

const raw = Config.parse(JSON.parse(readFileSync(join(projectRoot, ".factory/config.json"), "utf8")));

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: projectRoot, encoding: "utf8" }).trim();

/** `owner/name` from the `origin` remote, so a GitHub tracker needs no configuration of its own. */
const fromOrigin = () => {
  try {
    return /([^/:]+\/[^/]+?)(?:\.git)?$/.exec(git("remote", "get-url", "origin"))?.[1];
  } catch { return undefined; }
};
const repo = raw.repo ?? fromOrigin() ?? basename(projectRoot);
const at = (path: string) => resolve(projectRoot, path.replaceAll("{repo}", basename(projectRoot)));

export const config = {
  repo,
  base: raw.base,
  /** The project checkout itself: the branch every worktree starts from. */
  checkout: projectRoot,
  /** Ends in `/`, so a prefix check can't match a sibling directory. */
  worktrees: `${at(raw.worktrees)}/`,
  paths: raw.paths,
  sandbox: raw.sandbox,
  tracker: {
    ...raw.tracker,
    command: raw.tracker.command ?? (["node", join(installRoot, "trackers/local.mjs")] as [string, ...string[]]),
  },
  commands: raw.commands,
  acceptance: { ...raw.acceptance, assets: raw.acceptance.assets && at(raw.acceptance.assets) },
  skills: {
    ...raw.skills,
    // A bare name is one of the factory's own packs; anything with a separator is the project's.
    packs: raw.skills.packs.map((pack) => (/[/.]/.test(pack) ? at(pack) : join(installRoot, "skills", pack))),
  },
  readable: raw.readable.map(at),
};
