// The fast lane's real side effects, ported from extensions/behaviors/agent_task.ts, uat.ts and uat_integrity.ts.
// Pi gets no shell: everything that touches git, the network or approvals happens here.
import { execFile, spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname } from "node:path";
import { promisify } from "node:util";
import { config, factoryRoot } from "./config.ts";
import type { Ops } from "./fast-lane.ts";
import type { StackOps } from "./stack.ts";
import {
  isMigrationPath,
  isSensitivePath,
  isTestPath,
  journeySource,
  replaceSection,
  sha256,
  type Issue,
  type UatReport,
} from "./rules.ts";

export { factoryRoot } from "./config.ts";

const workspace = config.workspace;
const client = config.checkout;
const worktrees = config.worktrees;
export const issueRepo = config.repo;

/**
 * This factory's name, when more than one runs (the laptop's VM, the M1's): `~/.config/factory/name` in its VM,
 * which no sync touches. Starting an issue labels it `factory:<name>`, so another factory won't start it too.
 */
export const factoryName = (() => {
  try {
    const name = readFileSync(`${homedir()}/.config/factory/name`, "utf8").trim();
    if (/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) return name;
  } catch {}
  return "factory";
})();
const claimLabel = `factory:${factoryName}`;

async function claim(number: number): Promise<void> {
  const labels = (
    await run(workspace, "gh", [
      "issue",
      "view",
      String(number),
      "--repo",
      issueRepo,
      "--json",
      "labels",
      "--jq",
      ".labels[].name",
    ])
  )
    .split("\n")
    .filter(Boolean);
  const other = labels.find((l) => l.startsWith("factory:") && l !== claimLabel);
  if (other)
    throw new Error(`#${number} is already running on ${other.slice("factory:".length)}`);
  if (labels.includes(claimLabel)) return;
  // --force: creates the label the first time, and is a no-op after.
  await run(workspace, "gh", [
    "label",
    "create",
    claimLabel,
    "--repo",
    issueRepo,
    "--color",
    "5319e7",
    "--description",
    `Running on the ${factoryName} factory`,
    "--force",
  ]);
  await run(workspace, "gh", [
    "issue",
    "edit",
    String(number),
    "--repo",
    issueRepo,
    "--add-label",
    claimLabel,
  ]);
}

/** An abandoned issue goes back to the Issues column of every factory. */
export async function releaseIssue(number: number): Promise<void> {
  await run(workspace, "gh", [
    "issue",
    "edit",
    String(number),
    "--repo",
    issueRepo,
    "--remove-label",
    claimLabel,
  ]);
}

/** Everything a UAT run reads from the factory repo; run-uat.sh extracts exactly these from one commit. */
const uatInputs = [
  "specs",
  "seeds",
  "lighthouse-baseline.json",
  "playwright.config.mjs",
  "scripts/summarize.mjs",
];

const testEnv = {
  CI: "true",
  NUXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321",
  NUXT_PUBLIC_SUPABASE_KEY: "test-key",
  STUDIO_GITHUB_TOKEN: "test-token",
};

const nuxtEnv = { CI: "true", NUXT_TELEMETRY_DISABLED: "1" };

/**
 * The environment for everything the factory runs. `mastra dev` runs with NODE_ENV=production, which made the client's
 * tests render Vue in production mode and fail their snapshots, so it is never passed on.
 */
const { NODE_ENV: _serverMode, ...inherited } = process.env;
const exec = promisify(execFile);

/**
 * Commands in the client run with that checkout's own toolchain (its mise.toml), not the Node this server started
 * with: a worktree installed and tested with another Node lost better-sqlite3's native build, and every test failed
 * to start. Each worktree follows its own pin, so a Node bump on staging needs nothing here.
 */
async function toolchain(cwd: string): Promise<Record<string, string>> {
  if (cwd !== client && !cwd.startsWith(worktrees)) return {};
  const { stdout } = await exec("mise", ["bin-paths"], { cwd, env: inherited });
  return {
    PATH: [...stdout.trim().split("\n").filter(Boolean), inherited.PATH].join(
      ":",
    ),
  };
}

async function run(
  cwd: string,
  bin: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  try {
    const { stdout } = await exec(bin, args, {
      cwd,
      env: { ...inherited, ...(await toolchain(cwd)), ...env },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (error) {
    const e = error as { stderr?: string; stdout?: string; message: string };
    throw new Error(
      `${bin} ${args[0]} failed: ${(e.stderr || e.message).slice(-3000)}\n${(e.stdout ?? "").slice(-3000)}`,
    );
  }
}
/** Runs vm/sync-in-vm.sh on its own, since it may restart this server; it writes its progress to syncLog. */
const heavyLock = `${factoryRoot}/.cache/heavy.lock`;
export const syncLog = `${factoryRoot}/mastra/.data/logs/sync.log`;
export function syncVm() {
  const child = spawn("bash", ["-l", `${factoryRoot}/vm/sync-in-vm.sh`], {
    detached: true,
    stdio: "ignore",
    env: inherited,
  });
  child.unref();
  return child;
}
/**
 * Pause requests, one empty file each: `all`, or a run's id. They outlive server restarts, so a sync can come between
 * pausing and resuming.
 */
const pausedDir = `${factoryRoot}/mastra/.data/paused`;
const pauseTarget = (target: string) => {
  if (!/^(all|issue-\d+)$/.test(target))
    throw new Error(`Can't pause ${target}`);
  return `${pausedDir}/${target}`;
};
export async function paused(runId: string): Promise<boolean> {
  return (
    (await exists(pauseTarget("all"))) || (await exists(pauseTarget(runId)))
  );
}
export async function setPaused(target: string, on: boolean): Promise<void> {
  if (!on) return rm(pauseTarget(target), { force: true });
  await mkdir(pausedDir, { recursive: true });
  await writeFile(pauseTarget(target), "");
}
/** What is paused: `all`, and the run ids asked for one by one. */
export const pauseRequests = (): Promise<string[]> =>
  readdir(pausedDir).catch(() => []);

/** A gate that runs longer than this is a hang: a normal full suite takes about 15 minutes. */
const GATE_MINUTES = 40;
/**
 * A work item's written history and full check output live in its worktree's `.agents/artefacts/factory/`
 * (gitignored), next to the work they describe. Agents may read them but never write them (factory-pi.mjs).
 * Clean up archives history.md to .data/history/ before the worktree goes; checks.log goes with it.
 */
export const historyDir = (worktree: string) =>
  `${worktree}/.agents/artefacts/factory`;

export const historyFile = (worktree: string) =>
  `${historyDir(worktree)}/history.md`;

/** Every round's check output, each under its own heading; the board shows its end. */
export const checksLog = (worktree: string) =>
  `${historyDir(worktree)}/checks.log`;

const archiveDir = (workItem: string) =>
  `${factoryRoot}/mastra/.data/history/${workItem}`;

/**
 * A stack has no worktree (nobody edits its branch directly), so its record lives in the factory's data: the
 * approved design and its history. Each member gets a read copy in its worktree's `.agents/artefacts/stack/`.
 */
export const stackDir = (branch: string) =>
  `${factoryRoot}/mastra/.data/stacks/${branch.replace(/^stack\//, "")}`;

/** Adds one entry to the history.md in `dir`: a heading with the time, then the detail. */
async function addEntry(dir: string, title: string, body = ""): Promise<void> {
  await mkdir(dir, { recursive: true });

  const time = new Date().toISOString().slice(0, 16).replace("T", " ");
  const detail = body.replace(/\x1b\[[0-9;]*m/g, "").trim();

  await appendFile(
    `${dir}/history.md`,
    `## ${time} UTC · ${title}\n\n${detail ? `${detail}\n\n` : ""}`,
  );
}

/** Adds one entry to the work item's history. */
const record = (worktree: string, title: string, body?: string) =>
  addEntry(historyDir(worktree), title, body);

/** One gate command, stopped with all its test workers after GATE_MINUTES, its output streamed to the work item's log. */
async function gate(
  worktree: string,
  name: string,
  args: string[],
): Promise<void> {
  const log = checksLog(worktree);

  await appendFile(
    log,
    `\n=== ${name} · ${new Date().toISOString()} · pnpm ${args.join(" ")}\n`,
  );
  const out = createWriteStream(log, { flags: "a" });
  let tail = "";
  const tools = await toolchain(worktree);
  // `timeout` signals its whole process group, so vitest's workers stop too; -k kills what ignores SIGTERM.
  const code = await new Promise<number | null>((done, fail) => {
    // Gates and the UAT build take turns (scripts/run-uat.sh): together they run the VM out of memory.
    const child = spawn(
      "flock",
      [heavyLock, "timeout", "-k", "30s", `${GATE_MINUTES}m`, "pnpm", ...args],
      { cwd: worktree, env: { ...inherited, ...tools, ...testEnv } },
    );
    const take = (chunk: Buffer) => {
      out.write(chunk);
      tail = (tail + chunk.toString()).slice(-4000);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", fail);
    child.on("close", done);
  });
  out.end();
  if (code === 124 || code === 137)
    throw new Error(
      `${name} hung: stopped after ${GATE_MINUTES} min. Either a test hung, or the laptop slept while it ran (the VM pauses with it, and the clock jumps on waking); Retry runs it again. The output ends:\n${tail}`,
    );
  if (code !== 0) throw new Error(`pnpm ${args[0]} failed:\n${tail}`);
}

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** A task worktree must be a real directory under client/worktrees/ with no .env (agents never see real secrets). */
async function checkWorktree(worktree: string): Promise<void> {
  if (
    !worktree.startsWith(worktrees) ||
    (await realpath(worktree)) !== worktree
  )
    throw new Error(`Unexpected task worktree ${worktree}`);
  if (await exists(`${worktree}/.env`))
    throw new Error("Worktree .env is present");
}

/**
 * The branch a task builds on and its draft PR targets: the configured base, or a stack's `stack/<name>`. provision records
 * it on the task branch, so everything that compares against it (gates, digests, the board's diff, Pi) agrees.
 */
async function baseOf(worktree: string): Promise<string> {
  const branch = await run(worktree, "git", ["branch", "--show-current"]);
  return run(worktree, "git", ["config", `branch.${branch}.factoryBase`]).catch(
    () => config.base,
  );
}
const forkPoint = async (worktree: string) =>
  run(worktree, "git", [
    "merge-base",
    "HEAD",
    `origin/${await baseOf(worktree)}`,
  ]);

/**
 * The task's change: files that differ from where the branch left its base, committed or not, so a second
 * delivery after a UAT failure still shows, tests and fingerprints the whole change. `since: 'HEAD'` gives
 * only what is not yet committed.
 */
/**
 * Copies every skill pack (factory.config.json) into `dir`'s .agents/skills, beside any skills the project has, and
 * keeps what the factory adds out of git (the repo's info/exclude, shared by its worktrees): a task never commits it.
 */
async function addSkills(dir: string, extra: string[] = []): Promise<void> {
  const names: string[] = [];
  for (const pack of config.skills.packs) {
    await cp(pack, `${dir}/.agents/skills`, { recursive: true, dereference: true });
    names.push(...(await readdir(pack)));
  }
  const exclude = `${await run(dir, "git", ["rev-parse", "--path-format=absolute", "--git-common-dir"])}/info/exclude`;
  const current = await readFile(exclude, "utf8").catch(() => "");
  const have = new Set(current.split("\n"));
  const missing = [
    "/.agents/artefacts/",
    ...names.map((name) => `/.agents/skills/${name}/`),
    ...extra,
  ].filter((line) => !have.has(line));
  if (!missing.length) return;
  await mkdir(dirname(exclude), { recursive: true });
  await appendFile(
    exclude,
    `${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`,
  );
}

async function changedFiles(
  worktree: string,
  since?: string,
): Promise<string[]> {
  since ??= await forkPoint(worktree);
  const tracked = await run(worktree, "git", [
    "diff",
    "--name-only",
    "-z",
    since,
  ]);
  const untracked = await run(worktree, "git", [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const files = [
    ...new Set(`${tracked}\0${untracked}`.split("\0").filter(Boolean)),
  ].sort();
  for (const file of files) {
    const stat = await lstat(`${worktree}/${file}`).catch(() => null);
    if (
      stat?.isSymbolicLink() ||
      file.startsWith("/") ||
      file.split("/").includes("..")
    )
      throw new Error(`Unsafe task path: ${file}`);
  }
  return files;
}

/** sha256 over each changed file's path and blob hash: the exact content tests ran on and the human approved. */
async function fingerprint(worktree: string): Promise<string> {
  const files = await changedFiles(worktree);
  const entries = await Promise.all(
    files.map(
      async (file) =>
        `${file}\0${await run(worktree, "git", ["hash-object", "--", file]).catch(() => "deleted")}`,
    ),
  );
  return sha256(entries.join("\0"));
}

async function inspect(worktree: string) {
  await checkWorktree(worktree);
  const before = await changedFiles(worktree);
  const migrations = before.filter(isMigrationPath);
  if (migrations.length)
    throw new Error(
      `Migration/schema change stopped: ${migrations.join(", ")}. Migrations are not made by a task${config.readable.length ? `; they belong in ${config.readable.join(" or ")}` : ""}`,
    );
  const present = [];

  for (const file of before) {
    const stat = await lstat(`${worktree}/${file}`).catch(() => null);

    if (!stat) continue;

    // The coder has no delete tool: emptying a file is how it deletes one.
    if (stat.isFile() && stat.size === 0 && basename(file) !== ".gitkeep") {
      await rm(`${worktree}/${file}`);
      continue;
    }

    present.push(file);
  }

  // Format before fingerprinting, so formatting never changes approved content (FEEDBACK: e958dab).
  if (present.length)
    await run(worktree, `${worktree}/node_modules/.bin/prettier`, [
      "--write",
      "--ignore-unknown",
      "--",
      ...present,
    ]);
  const files = await changedFiles(worktree);
  return { files, sensitive: files.filter(isSensitivePath) };
}

/**
 * ESLint's own fixes (such as blank lines around multi-line statements) on the task's files, before the lint gate
 * judges them, so a fixable rule never costs the coder a round. Prettier runs again after it, as the gate checks
 * both. What ESLint can't fix, it leaves for the lint gate to report; so does a crash, hence the ignored exit code.
 */
async function autofix(worktree: string): Promise<void> {
  const files: string[] = [];

  for (const file of await changedFiles(worktree)) {
    if (
      /\.([cm]?[jt]sx?|vue)$/.test(file) &&
      (await exists(`${worktree}/${file}`))
    ) {
      files.push(file);
    }
  }

  if (!files.length) return;

  await run(
    worktree,
    "pnpm",
    ["exec", "eslint", "--fix", "--no-warn-ignored", "--", ...files],
    nuxtEnv,
  ).catch(() => undefined);

  await inspect(worktree);
}

/**
 * True when the coder's `check` (factory-pi.mjs) passed on the worktree exactly as it is now: the tree it recorded
 * matches the current one. Agents cannot write the record (it is in the factory's history folder).
 */
async function coderChecked(worktree: string): Promise<boolean> {
  const recorded = await readFile(
    `${historyDir(worktree)}/checked-tree`,
    "utf8",
  ).catch(() => "");
  if (!recorded) return false;
  const now = await run(worktree, "bash", [
    `${factoryRoot}/scripts/content-tree.sh`,
  ]);
  return recorded.trim() === now;
}

async function remoteHead(worktree: string, branch: string): Promise<string> {
  return (
    await run(worktree, "git", ["ls-remote", "--heads", "origin", branch])
  ).split("\t")[0];
}

/** The whole task change against its base, for a person to read; untracked files show as added. */
/** UAT input files that changed between `baseline` and the factory's HEAD, with HEAD; null when none did. */
export async function newerUatInputs(
  baseline: string,
): Promise<{ head: string; files: string[] } | null> {
  const head = await run(factoryRoot, "git", ["rev-parse", "HEAD"]);
  if (head === baseline) return null;
  const files = (
    await run(factoryRoot, "git", [
      "diff",
      "--name-only",
      baseline,
      head,
      "--",
      ...uatInputs,
    ])
  )
    .split("\n")
    .filter(Boolean);
  return files.length ? { head, files } : null;
}

export async function branchDiff(worktree: string): Promise<string> {
  await checkWorktree(worktree);
  const base = await forkPoint(worktree);
  const untracked = (
    await run(worktree, "git", [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ])
  )
    .split("\0")
    .filter(Boolean);
  // `git diff --no-index` exits 1 when the files differ, which is always here.
  const added = await Promise.all(
    untracked.map((file) =>
      exec("git", ["diff", "--no-index", "--", "/dev/null", file], {
        cwd: worktree,
      }).then(
        (r) => r.stdout,
        (e: { stdout?: string }) => e.stdout ?? "",
      ),
    ),
  );
  return [await run(worktree, "git", ["diff", base]), ...added].join("\n");
}

/** Open issues from the Factory task form (`factory`) and the Factory stack form (`factory-stack`) in the client repo. */
export async function factoryIssues(): Promise<
  Array<{ number: number; title: string; url: string; stack: boolean }>
> {
  const labelled = async (label: string) =>
    JSON.parse(
      await run(workspace, "gh", [
        "issue",
        "list",
        "-R",
        issueRepo,
        "--label",
        label,
        "--state",
        "open",
        "--limit",
        "50",
        "--json",
        "number,title,url,labels",
      ]),
    ) as Array<{ number: number; title: string; url: string; labels: Array<{ name: string }> }>;
  const [tasks, stacks] = await Promise.all([
    labelled("factory"),
    labelled("factory-stack"),
  ]);
  // Claimed by a factory: it shows as that factory's card, not as an issue to start.
  const free = (i: { labels: Array<{ name: string }> }) =>
    !i.labels.some((l) => l.name.startsWith("factory:"));
  const item = (i: { number: number; title: string; url: string }, stack: boolean) => ({
    number: i.number,
    title: i.title,
    url: i.url,
    stack,
  });
  return [
    ...stacks.filter(free).map((i) => item(i, true)),
    ...tasks.filter(free).map((i) => item(i, false)),
  ];
}

/** OPEN, MERGED or CLOSED, for a pull request URL. */
export async function prState(url: string): Promise<string> {
  return run(workspace, "gh", [
    "pr",
    "view",
    url,
    "--json",
    "state",
    "--jq",
    ".state",
  ]);
}

/**
 * Removes a finished or abandoned task: its worktree, tmux window and local branch (`workmux remove`). Uncommitted
 * changes stop it unless `discard` is set, since they exist nowhere else. The pushed branch and PR stay on GitHub.
 */
export async function removeTask(
  worktree: string,
  workItem: string,
  discard: boolean,
): Promise<void> {
  if (await exists(worktree)) {
    await checkWorktree(worktree);

    // The history outlives the worktree. Only history.md: it is small and keeps each failure's end, while
    // checks.log (about 500 KB of test output per round) only serves a live run.
    if (await exists(historyFile(worktree))) {
      await mkdir(archiveDir(workItem), { recursive: true });
      await cp(historyFile(worktree), `${archiveDir(workItem)}/history.md`);
    }

    const uncommitted = await changedFiles(worktree, "HEAD");
    if (uncommitted.length && !discard)
      throw new Error(
        `Uncommitted changes in ${workItem}: ${uncommitted.join(", ")}`,
      );
  }
  await run(client, "workmux", ["remove", "--force", workItem]).catch(
    (error) => {
      if (!/not found|no such|does not exist/i.test((error as Error).message))
        throw error; // already gone is fine
    },
  );
}

/** Closes the issue with a comment, unless it is closed already. */
export async function closeIssue(
  number: number,
  comment: string,
): Promise<void> {
  const state = await run(workspace, "gh", [
    "issue",
    "view",
    String(number),
    "--repo",
    issueRepo,
    "--json",
    "state",
    "--jq",
    ".state",
  ]);
  if (state === "OPEN")
    await run(workspace, "gh", [
      "issue",
      "close",
      String(number),
      "--repo",
      issueRepo,
      "--comment",
      comment,
    ]);
}

/** Issue authors (and commenters) whose text may reach an agent: the GitHub token's owner, plus FACTORY_ISSUE_AUTHORS. */
async function trustedAuthors(): Promise<string[]> {
  const owner = await run(workspace, "gh", ["api", "user", "--jq", ".login"]);
  return [
    owner,
    ...(process.env.FACTORY_ISSUE_AUTHORS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ];
}

export const realOps: Ops = {
  paused,
  claim,
  async readIssue(number) {
    const raw = JSON.parse(
      await run(workspace, "gh", [
        "issue",
        "view",
        String(number),
        "--repo",
        issueRepo,
        "--json",
        "number,title,body,url,state,author,comments",
      ]),
    );
    const trusted = await trustedAuthors();
    if (raw.state !== "OPEN")
      throw new Error(`Issue #${number} is ${raw.state}`);
    if (!trusted.includes(raw.author.login))
      throw new Error(
        `Issue #${number} is by ${raw.author.login}, who is not a trusted author (${trusted.join(", ")})`,
      );
    const comments = raw.comments
      .filter((c: { author: { login: string } }) =>
        trusted.includes(c.author.login),
      )
      .map((c: { body: string }) => c.body);
    const issue: Issue = {
      number: raw.number,
      title: raw.title,
      body: [raw.body, ...comments].join("\n\n---\n\n"),
      url: raw.url,
      author: raw.author.login,
      comments,
    };
    return issue;
  },

  async branchExists(branch) {
    const local = await run(client, "git", ["branch", "--list", branch]);
    return (
      Boolean(local) ||
      Boolean(
        await run(client, "git", ["ls-remote", "--heads", "origin", branch]),
      )
    );
  },

  async uatBaseline(at = "HEAD", after) {
    const commit = await run(factoryRoot, "git", [
      "rev-parse",
      "--verify",
      `${at}^{commit}`,
    ]);
    // Forward only along factory history, so a run can't be pointed back at inputs it already failed.
    if (after)
      await run(factoryRoot, "git", [
        "merge-base",
        "--is-ancestor",
        after,
        commit,
      ]).catch(() => {
        throw new Error(
          `UAT inputs only move forward: ${commit} does not descend from ${after}`,
        );
      });
    // Only regular files, all present: a symlink in the inputs could point a UAT run outside the tree.
    const paths = (
      await run(factoryRoot, "git", [
        "ls-tree",
        "-r",
        "--full-tree",
        commit,
        "--",
        ...uatInputs,
      ])
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = /^100644 blob [a-f0-9]+\t(.+)$/.exec(line);
        if (!match)
          throw new Error(`Unsupported UAT input at ${commit}: ${line}`);
        return match[1];
      });
    for (const input of uatInputs)
      if (!paths.some((p) => p === input || p.startsWith(`${input}/`)))
        throw new Error(`Missing UAT input at ${commit}: ${input}`);
    return commit;
  },

  async provision(branch, base) {
    // Always branch from GitHub's tip; the local staging checkout is never kept current.
    await run(client, "git", ["fetch", "origin", base]);
    // workmux's settings for a task worktree, from factory.config.json.
    const workmuxConfig = `${factoryRoot}/.cache/workmux.agent-task.yaml`;
    await mkdir(dirname(workmuxConfig), { recursive: true });
    await writeFile(
      workmuxConfig,
      [
        `main_branch: ${JSON.stringify(config.base)}`,
        `base_branch: ${JSON.stringify(config.base)}`,
        `worktree_dir: ${JSON.stringify(worktrees.slice(0, -1))}`,
        "agent: pi",
        "",
      ].join("\n"),
    );
    const receipt = JSON.parse(
      await run(client, "workmux", [
        "add",
        branch,
        "--name",
        branch,
        "--config",
        workmuxConfig,
        "--headless",
        "--json",
        "--base",
        `origin/${base}`,
      ]),
    );
    if (receipt.branch !== branch) throw new Error("Unexpected workmux branch");
    await run(client, "git", ["config", `branch.${branch}.factoryBase`, base]);
    const worktree = receipt.worktree_path as string;
    await checkWorktree(worktree);
    await mkdir(`${worktree}/.agents/artefacts`, { recursive: true });
    // A project that keeps AGENTS.md out of its repo (gitignored in the checkout) still gives every task one.
    const agentsMd =
      !(await exists(`${worktree}/AGENTS.md`)) &&
      (await exists(`${client}/AGENTS.md`));
    if (agentsMd) await cp(`${client}/AGENTS.md`, `${worktree}/AGENTS.md`);
    await addSkills(worktree, agentsMd ? ["/AGENTS.md"] : []);

    // A stack member reads the stack's design and history: what earlier PRs decided.
    if (base.startsWith("stack/") && (await exists(stackDir(base)))) {
      await cp(stackDir(base), `${worktree}/.agents/artefacts/stack`, {
        recursive: true,
      });
    }

    // Staging may have gained packages the VM's store lacks; fetch only downloads (no scripts), then the install stays offline.
    await run(worktree, "pnpm", ["fetch", "--ignore-scripts"]);
    await run(worktree, "pnpm", ["install", "--offline", "--frozen-lockfile"]);
    // pnpm records the builds `fetch --ignore-scripts` skipped as pending, and the offline install never runs them:
    // better-sqlite3 stayed unbuilt and the whole suite failed to start. allowBuilds in pnpm-workspace.yaml still decides.
    await run(worktree, "pnpm", ["rebuild", "--pending"]);
    await run(worktree, "pnpm", ["exec", "nuxt", "prepare"], nuxtEnv);
    return worktree;
  },

  checkWorktree,

  async runPi(worktree, role, prompt) {
    await checkWorktree(worktree);
    return run(
      factoryRoot,
      "node",
      [`${factoryRoot}/scripts/factory-pi.mjs`, worktree, role, prompt],
      {
        FACTORY_BASE: `origin/${await baseOf(worktree)}`,
        FACTORY_READABLE: JSON.stringify(config.readable),
        FACTORY_CODER_SKILLS: JSON.stringify(config.skills.coder),
      },
    );
  },

  inspect,
  fingerprint,
  record,

  async checkSkills(worktree, skills) {
    await checkWorktree(worktree);
    await run(factoryRoot, "node", [
      `${factoryRoot}/scripts/factory-pi.mjs`,
      worktree,
      "check",
      JSON.stringify(skills),
    ]);
  },

  async createIssue(title, body) {
    return issueNumberOf(
      await run(workspace, "gh", [
        "issue",
        "create",
        "--repo",
        issueRepo,
        "--title",
        title,
        "--body",
        body,
        "--label",
        "factory",
      ]),
    );
  },

  async recordSplit(base, member, parts) {
    await mkdir(`${stackDir(base)}/splits`, { recursive: true });
    await writeFile(splitFile(base, member), JSON.stringify(parts, null, 2));
  },

  async runGates(worktree) {
    const changedTests = (await changedFiles(worktree)).filter(isTestPath);
    // tests/e2e runs only under the client's SSR config (a production Nuxt build); `pnpm test` finds no files there.
    const ssrTests = changedTests.filter((f) => f.startsWith("tests/e2e/"));
    const tests = changedTests.filter((f) => !ssrTests.includes(f));
    await mkdir(historyDir(worktree), { recursive: true });

    await appendFile(
      checksLog(worktree),
      `\n######## Checks · ${new Date().toISOString()}\n`,
    );

    const gates: Array<[string, string[]]> = [
      ["install", ["install", "--offline", "--frozen-lockfile"]],
      ["lint", ["lint"]],
      ["typecheck", ["typecheck"]],
      // No `--`: vitest takes the files as filters only when passed straight through; with `--` it runs everything.
      ...(tests.length
        ? [["changed tests", ["test", ...tests]] as [string, string[]]]
        : []),
      ...(ssrTests.length
        ? [["changed SSR tests", ["test:ssr", ...ssrTests]] as [string, string[]]]
        : []),
      ["full suite", ["test"]],
    ];
    // Lint and typecheck both run before any test, and fail together: one coder round fixes both, and tests never
    // run on code that doesn't build.
    const failed: Array<[string, string]> = [];
    const result = () => ({
      ok: false as const,
      gate: failed.map(([name]) => name).join(", "),
      output: failed
        .map(([name, out]) => `${name}:\n${out.slice(-4000 / failed.length)}`)
        .join("\n\n"),
    });
    let checked = false;
    for (const [name, args] of gates) {
      if (failed.length && name !== "typecheck") return result();
      // The coder's check already passed lint and typecheck on exactly this code: don't run them twice.
      if (name === "lint") checked = await coderChecked(worktree);
      if (checked && (name === "lint" || name === "typecheck")) {
        await appendFile(
          checksLog(worktree),
          `\n=== ${name} · skipped: the coder's check passed on this exact code\n`,
        );
        continue;
      }
      try {
        if (name === "lint") {
          if (!(await exists(`${worktree}/.nuxt/eslint.config.mjs`))) {
            await run(worktree, "pnpm", ["exec", "nuxt", "prepare"], nuxtEnv);
          }

          await autofix(worktree);
        }

        await gate(worktree, name, args);
      } catch (error) {
        // A hang says nothing about the code: stop the run (it waits as an error) instead of sending it to the coder.
        if (/hung:/.test((error as Error).message)) throw error;
        failed.push([name, (error as Error).message]);
        if (name !== "lint") return result();
        continue;
      }
      await inspect(worktree); // a gate must not introduce a migration or unformatted files
    }
    return { ok: true };
  },

  async commitAndPush(worktree, message) {
    const branch = await run(worktree, "git", ["branch", "--show-current"]);
    if (!(await changedFiles(worktree)).length)
      throw new Error("No changes to publish");
    // Nothing new since the last push (a redelivery with the same code): publish nothing, UAT the pushed commit.
    const files = await changedFiles(worktree, "HEAD");
    if (files.length) {
      await run(worktree, "git", ["add", "--", ...files]);
      await run(worktree, "git", ["commit", "-m", message]);
    }
    try {
      await run(worktree, "git", ["push", "-u", "origin", branch]);
    } catch (error) {
      // Undo only the commit just made, so the approved files are uncommitted again and a retry starts clean.
      if (files.length)
        await run(worktree, "git", ["reset", "--mixed", "HEAD^"]);
      throw error;
    }
    return run(worktree, "git", ["rev-parse", "HEAD"]);
  },

  async pushedHead(worktree) {
    const branch = await run(worktree, "git", ["branch", "--show-current"]);
    const head = await run(worktree, "git", ["rev-parse", "HEAD"]);
    if (
      (await changedFiles(worktree, "HEAD")).length ||
      (await remoteHead(worktree, branch)) !== head
    )
      return "";
    return head;
  },

  async runUat(branch, baseline) {
    let stdout = "";
    try {
      stdout = await run(
        factoryRoot,
        "bash",
        [`${factoryRoot}/scripts/run-uat.sh`, branch, baseline],
        { UAT_INPUTS: uatInputs.join(" ") },
      );
    } catch (error) {
      // run-uat.sh exits non-zero on a failed verdict too; the error carries its stdout, report path included.
      // Without one, the error's stderr is the only cause there is, so it stays in the message below.
      stdout = (error as Error).message;
    }
    const path = stdout
      .split("\n")
      .find(
        (line) =>
          line.startsWith(`${factoryRoot}/.cache/run-`) &&
          line.endsWith("/report.json"),
      );
    if (!path)
      throw new Error(
        `UAT failed before writing a report: ${stdout.slice(-1000)}`,
      );
    const report = JSON.parse(await readFile(path, "utf8")) as UatReport;
    // The planner and coder can't see the run; give them the failed journeys' code from its pinned specs.
    const specDir = `${dirname(path)}/inputs/specs`;
    const specs = await Promise.all(
      (await readdir(specDir).catch(() => []))
        .filter((f) => f.endsWith(".mjs"))
        .map((f) => readFile(`${specDir}/${f}`, "utf8")),
    );
    for (const journey of report.journeys ?? [])
      if (journey.status === "failed")
        journey.source = specs
          .map((spec) => journeySource(spec, journey.name))
          .find(Boolean);
    return { run: dirname(path), report };
  },

  async openDraftPr(worktree, title, body) {
    const [branch, base] = [
      await run(worktree, "git", ["branch", "--show-current"]),
      await baseOf(worktree),
    ];
    const existing = await run(worktree, "gh", [
      "pr",
      "list",
      "--head",
      branch,
      "--base",
      base,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      '.[0].url // ""',
    ]);
    if (existing) {
      await run(worktree, "gh", [
        "pr",
        "edit",
        existing,
        "--title",
        title,
        "--body",
        body,
      ]);
      return existing;
    }
    return run(worktree, "gh", [
      "pr",
      "create",
      "--draft",
      "--base",
      base,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ]);
  },

  async commentOnIssue(number, text) {
    await run(workspace, "gh", [
      "issue",
      "comment",
      String(number),
      "--repo",
      issueRepo,
      "--body",
      text,
    ]);
  },
};

/** The new issue's number, from the URL `gh issue create` prints. */
function issueNumberOf(url: string): number {
  const number = Number(url.trim().split("/").at(-1));
  if (!Number.isInteger(number)) throw new Error(`Unexpected issue URL: ${url}`);
  return number;
}

const splitFile = (branch: string, member: number) =>
  `${stackDir(branch)}/splits/${member}.json`;

/** GitHub's internal id of an issue, which the sub-issue API takes. */
const issueId = (number: number) =>
  run(workspace, "gh", ["api", `repos/${issueRepo}/issues/${number}`, "--jq", ".id"]);

export const realStackOps: StackOps = {
  paused,
  claim,
  readIssue: realOps.readIssue,

  record: (branch, title, body) => addEntry(stackDir(branch), title, body),

  async saveDesign(branch, design) {
    await mkdir(stackDir(branch), { recursive: true });
    await writeFile(`${stackDir(branch)}/design.md`, `${design.trim()}\n`);
  },

  async createStackBranch(branch) {
    if (await run(client, "git", ["ls-remote", "--heads", "origin", branch]))
      return;
    await run(client, "git", ["fetch", "origin", config.base]);
    await run(client, "git", [
      "push",
      "origin",
      `refs/remotes/origin/${config.base}:refs/heads/${branch}`,
    ]);
  },

  async createSubIssue(parent, title, body, after) {
    // No `factory` label: a member must not show up on the board as a task anyone could start on staging.
    const number = issueNumberOf(
      await run(workspace, "gh", [
        "issue",
        "create",
        "--repo",
        issueRepo,
        "--title",
        title,
        "--body",
        body,
      ]),
    );
    const id = await issueId(number);
    await run(workspace, "gh", [
      "api",
      "-X",
      "POST",
      `repos/${issueRepo}/issues/${parent}/sub_issues`,
      "-F",
      `sub_issue_id=${id}`,
    ]);
    if (after)
      await run(workspace, "gh", [
        "api",
        "-X",
        "PATCH",
        `repos/${issueRepo}/issues/${parent}/sub_issues/priority`,
        "-F",
        `sub_issue_id=${id}`,
        "-F",
        `after_id=${await issueId(after)}`,
      ]);
    return number;
  },

  async retitleIssue(number, title) {
    await run(workspace, "gh", [
      "issue",
      "edit",
      String(number),
      "--repo",
      issueRepo,
      "--title",
      title,
    ]);
  },

  async updateIssueSection(number, name, text) {
    const body = await run(workspace, "gh", [
      "issue",
      "view",
      String(number),
      "--repo",
      issueRepo,
      "--json",
      "body",
      "--jq",
      ".body",
    ]);
    await run(workspace, "gh", [
      "issue",
      "edit",
      String(number),
      "--repo",
      issueRepo,
      "--body",
      replaceSection(body, name, text),
    ]);
  },

  async withReviewCheckout(work) {
    // A detached checkout of GitHub's staging under client/worktrees/, so runPi's worktree checks hold; never
    // client/staging itself.
    await run(client, "git", ["fetch", "origin", config.base]);
    const dir = `${worktrees}review-${Date.now()}`;
    await run(client, "git", ["worktree", "add", "--detach", dir, `origin/${config.base}`]);
    try {
      await addSkills(dir);
      return await work((prompt) => realOps.runPi(dir, "review", prompt));
    } finally {
      await run(client, "git", ["worktree", "remove", "--force", dir]);
    }
  },

  async splitOf(branch, member) {
    const text = await readFile(splitFile(branch, member), "utf8").catch(() => "");
    return text ? (JSON.parse(text) as string[]) : [];
  },

  async issueOpen(number) {
    return (
      (await run(workspace, "gh", [
        "issue",
        "view",
        String(number),
        "--repo",
        issueRepo,
        "--json",
        "state",
        "--jq",
        ".state",
      ])) === "OPEN"
    );
  },

  closeIssue,

  async openStackPr(branch, title, body) {
    const existing = await run(client, "gh", [
      "pr",
      "list",
      "--repo",
      issueRepo,
      "--head",
      branch,
      "--base",
      config.base,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      '.[0].url // ""',
    ]);
    if (existing) return existing;
    return run(client, "gh", [
      "pr",
      "create",
      "--repo",
      issueRepo,
      "--draft",
      "--base",
      config.base,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ]);
  },
};
