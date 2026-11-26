// The fast lane's real side effects, ported from extensions/behaviors/agent_task.ts, uat.ts and uat_integrity.ts.
// Pi gets no shell: everything that touches git, the network or approvals happens here.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  appendFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { z } from "zod";
import { basename, dirname, join, matchesGlob } from "node:path";
import { promisify } from "node:util";
import { config, installRoot, projectRoot, stateRoot } from "./config.ts";
import { sandbox } from './sandbox.ts';
import { projectCommands } from './project-commands.ts';
import { taskGitEnv } from './worktree-git.ts';
import { tracker } from './tracker.ts';
import type { Ops } from "./fast-lane.ts";
import type { StackOps } from "./stack.ts";
import {
  sha256,
  type Issue,
} from "./rules.ts";

export { installRoot, projectRoot, stateRoot } from "./config.ts";

const client = config.checkout;
const worktrees = config.worktrees;
export const issueRepo = config.repo;

/** A distinct worker name prevents two workers claiming the same issue. */
export const factoryName = (() => {
  try {
    const name = readFileSync(`${homedir()}/.config/factory/name`, "utf8").trim();
    if (/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) return name;
  } catch {}
  return "factory";
})();
const claimLabel = `factory:${factoryName}`;

async function claim(number: string): Promise<void> {
  await tracker.claim(number, factoryName);
}

/** An abandoned issue goes back to the Issues column of every factory. */
export async function releaseIssue(number: string): Promise<void> {
  await tracker.release(number);
}

/** Everything an acceptance run reads from the factory repo, extracted from one approved commit. */
const acceptanceInputs = config.acceptance.inputs;


/**
 * The environment for everything the factory runs. the board server once ran with NODE_ENV=production, which made a project's
 * tests render Vue in production mode and fail their snapshots, so it is never passed on.
 */
const { NODE_ENV: _serverMode, ...inherited } = process.env;
const exec = promisify(execFile);


async function run(
  cwd: string,
  bin: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  try {
    const { stdout } = await exec(bin, args, {
      cwd,
      env: { ...inherited,
        ...(cwd.startsWith(worktrees) && (bin === 'git' || bin === 'bash') ? await taskGitEnv(client,cwd) : {}), ...env },
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
/**
 * Pause requests, one empty file each: `all`, or a run's id. They outlive server restarts, so a sync can come between
 * pausing and resuming.
 */
const pausedDir = `${stateRoot}/paused`;
const pauseTarget = (target: string) => {
  if (!/^(all|item-[A-Za-z0-9._-]{1,64})$/.test(target))
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
 * A work item's written history and check output live on the host, outside the sandbox mount, so code running in a
 * check cannot rewrite them. Agents get them read-only.
 */
export const historyDir = (worktree: string) => {
  const item = basename(worktree);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(item)) throw Error('Invalid work item');
  return `${stateRoot}/items/${item}`;
};

export const historyFile = (worktree: string) =>
  `${historyDir(worktree)}/history.md`;

/** Every round's check output, each under its own heading; the board shows its end. */
export const checksLog = (worktree: string) =>
  `${historyDir(worktree)}/checks.log`;

const archiveDir = (workItem: string) =>
  `${stateRoot}/history/${workItem}`;

/**
 * A stack has no worktree (nobody edits its branch directly), so its record lives in the factory's data: the
 * approved design and its history. Each member gets a read copy in its worktree's `.agents/artefacts/stack/`.
 */
export const stackDir = (branch: string) =>
  `${stateRoot}/stacks/${branch.replace(/^stack\//, "")}`;

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


const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** A task worktree must be a real directory under the configured worktrees directory with no .env (agents never see real secrets). */
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
  const files = await changedFiles(worktree);
  const matches = (file: string, patterns: string[]) => patterns.some(p => matchesGlob(file, p));
  const blocked = files.filter(file => matches(file, config.paths.protected));
  if (blocked.length) throw new Error(`Protected paths changed: ${blocked.join(", ")}`);
  return { files, sensitive: files.filter(file => matches(file, config.paths.sensitive)) };
}

/** Project formatters and fixers, so a fixable rule never costs the coder a round. */
async function autofix(worktree: string): Promise<void> {
  const files = (await Promise.all((await changedFiles(worktree)).map(async f => await exists(`${worktree}/${f}`) ? f : ''))).filter(Boolean);
  const fixed = await projectCommands(worktree,config.commands.autofix,files);
  if (!fixed.ok) throw Error(`${fixed.gate}: ${fixed.output}`);
}

/**
 * True when the coder's `check` (factory-pi.mjs) passed on the worktree exactly as it is now. Agents cannot write
 * the record: it lives in the factory's own data, outside the sandbox mount.
 */
async function coderChecked(worktree: string): Promise<boolean> {
  const recorded = await readFile(`${historyDir(worktree)}/checked-tree`, "utf8").catch(() => "");
  if (!recorded) return false;
  const now = await run(worktree, "bash", [`${installRoot}/scripts/content-tree.sh`]);
  return recorded.trim() === now;
}

/**
 * Everything a sandbox runs — the acceptance adapter, any setup script — comes from a fresh worktree of the base
 * branch, so files that live only in the local checkout would silently not be there. Say so before a run starts.
 */
async function onBase(base: string, path: string): Promise<void> {
  const found = await run(projectRoot, "git", ["ls-tree", "--name-only", `origin/${base}`, "--", path]);
  if (!found)
    throw new Error(
      `${path} is not on origin/${base}. Commit it and push: each work item is built in a fresh worktree of that branch.`,
    );
}

async function remoteHead(worktree: string, branch: string): Promise<string> {
  return (
    await run(worktree, "git", ["ls-remote", "--heads", "origin", branch])
  ).split("\t")[0];
}

/** The whole task change against its base, for a person to read; untracked files show as added. */
/** Acceptance inputs that changed between `baseline` and the base branch's tip, with that tip; null when none did. */
export async function newerUatInputs(
  baseline: string,
): Promise<{ head: string; files: string[] } | null> {
  await run(projectRoot, "git", ["fetch", "origin", config.base]).catch(() => "");
  const head = await run(projectRoot, "git", ["rev-parse", `origin/${config.base}`]);
  if (head === baseline) return null;
  const files = (
    await run(projectRoot, "git", [
      "diff",
      "--name-only",
      baseline,
      head,
      "--",
      ...acceptanceInputs,
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
  const gitEnv = { ...inherited, ...await taskGitEnv(client,worktree) };
  const added = await Promise.all(
    untracked.map((file) =>
      exec("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "/dev/null", file], {
        cwd: worktree, env: gitEnv,
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
  Array<{ number: string; title: string; url: string; stack: boolean }>
> {
  return (await tracker.list()).map((i) => ({ number: i.id, title: i.title, url: i.url, stack: i.stack }));
}

/** The board's words for a delivered change: OPEN, MERGED or CLOSED. */
export async function prState(url: string): Promise<string> {
  const { state } = await tracker.delivered(url);
  return state === 'accepted' ? 'MERGED' : state === 'rejected' ? 'CLOSED' : 'OPEN';
}

/**
 * Removes a finished or abandoned task: its sandboxes, worktree and local branch. Uncommitted
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
  await sandbox.remove(workItem,true);
  await sandbox.remove(workItem);
  if (await exists(worktree)) {
    // Remove by the trusted registration, not a .git pointer supplied by the project.
    await taskGitEnv(client,worktree);
    await rm(worktree,{recursive:true});
    await run(client,'git',['worktree','prune']);
  }
  if (await run(client,'git',['branch','--list',workItem])) await run(client,'git',['branch','-D',workItem]);
  await rm(`${historyDir(worktree)}/worktree`,{force:true});
}

/** Closes the issue with a comment, unless it is closed already. */
export async function closeIssue(
  number: string,
  comment: string,
): Promise<void> {
  if ((await tracker.state(number)).open) await tracker.close(number, comment);
}


export async function ownsWorktree(worktree: string): Promise<boolean> {
  return (await readFile(`${historyDir(worktree)}/worktree`,'utf8').catch(()=>'')) === worktree;
}
export async function prepareSandbox(item: string, worktree: string) {
  if (!await ownsWorktree(worktree)) throw Error('Worktree is not registered to this factory');
  await checkWorktree(worktree);
  const existing = (await sandbox.list()).find(s=>s.name === `fx-${item}`);
  if (!existing) await sandbox.create(item,worktree);
  else if (existing.workspaces?.length !== 1 || existing.workspaces[0] !== worktree) throw Error('Unexpected sandbox workspace');
  const setup = await projectCommands(worktree,config.commands.setup);
  if (!setup.ok) throw Error(`${setup.gate}: ${setup.output}`);
}

export const realOps: Ops = {
  paused,
  claim,
  async readIssue(number) {
    const item = await tracker.read(number);
    const issue: Issue = { ...item, number: item.id };
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

  /**
   * Pins the acceptance inputs to a commit on the base branch. A task branch can edit `.factory/acceptance` in its
   * own worktree all it likes: acceptance runs what a human merged into the base branch, and nothing else.
   */
  async uatBaseline(at = `origin/${config.base}`, after) {
    await run(projectRoot, "git", ["fetch", "origin", config.base]).catch(() => "");
    const commit = await run(projectRoot, "git", ["rev-parse", "--verify", `${at}^{commit}`]);
    await run(projectRoot, "git", ["merge-base", "--is-ancestor", commit, `origin/${config.base}`]).catch(() => {
      throw new Error(`Acceptance inputs must be on ${config.base}: ${commit} is not`);
    });
    // Forward only along the base branch, so a run can't be pointed back at inputs it already failed.
    if (after)
      await run(projectRoot, "git", [
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
      await run(projectRoot, "git", [
        "ls-tree",
        "-r",
        "--full-tree",
        commit,
        "--",
        ...acceptanceInputs,
      ])
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const match = /^100(?:644|755) blob [a-f0-9]+\t(.+)$/.exec(line);
        if (!match)
          throw new Error(`Unsupported acceptance input at ${commit}: ${line}`);
        return match[1];
      });
    for (const input of acceptanceInputs)
      if (!paths.some((p) => p === input || p.startsWith(`${input}/`)))
        throw new Error(
          `${input} is not on ${config.base} (at ${commit.slice(0, 8)}). Commit it and push: acceptance runs what ` +
            `is on the base branch, never what a task branch carries.`,
        );
    return commit;
  },

  async provision(branch, base) {
    // Always branch from the remote tip; the local base checkout is never kept current.
    await run(client, "git", ["fetch", "origin", base]);
    await onBase(base, ".factory");
    // The tracker's id leads the name, so accept any safe ref: no option-like or traversing names.
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(branch) || branch.includes('..')) throw Error('Invalid task branch');
    const worktree = `${worktrees}${branch}`;
    if (await exists(worktree)) {
      await checkWorktree(worktree);
      if (await run(worktree,'git',['branch','--show-current']) !== branch || await baseOf(worktree) !== base) throw Error('Unexpected task registration');
      await prepareSandbox(branch,worktree);
      return worktree;
    }
    await run(client, 'git', ['-c','core.hooksPath=/dev/null','worktree','add','-b',branch,worktree,`origin/${base}`]);
    await mkdir(historyDir(worktree),{recursive:true});
    await writeFile(`${historyDir(worktree)}/worktree`,worktree);
    await run(client, "git", ["config", `branch.${branch}.factoryBase`, base]);
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

    await prepareSandbox(branch,worktree);
    return worktree;
  },

  checkWorktree,

  async runPi(worktree, role, prompt) {
    await checkWorktree(worktree);
    return run(
      installRoot,
      "node",
      [`${installRoot}/scripts/factory-pi.mjs`, worktree, role, prompt],
      {
        FACTORY_TASK_GIT: JSON.stringify(await taskGitEnv(client,worktree)),
        FACTORY_ITEM_RECORDS: historyDir(worktree),
        FACTORY_BASE: `origin/${await baseOf(worktree)}`,
        FACTORY_READABLE: JSON.stringify([...config.readable, historyDir(worktree)]),
        FACTORY_TEST_PATHS: JSON.stringify(config.paths.tests),
        FACTORY_CODER_SKILLS: JSON.stringify(config.skills.coder),
        FACTORY_STATE_ROOT: stateRoot,
        FACTORY_PROJECT: projectRoot,
      },
    );
  },

  inspect,
  fingerprint,
  record,

  async checkSkills(worktree, skills) {
    await checkWorktree(worktree);
    await run(installRoot, "node", [
      `${installRoot}/scripts/factory-pi.mjs`,
      worktree,
      "check",
      JSON.stringify(skills),
    ]);
  },

  async createIssue(title, body) {
    return (await tracker.create('task', { title, body })).id;
  },

  async recordSplit(base, member, parts) {
    await mkdir(`${stackDir(base)}/splits`, { recursive: true });
    await writeFile(splitFile(base, member), JSON.stringify(parts, null, 2));
  },

  async runGates(worktree) {
    await checkWorktree(worktree);
    await mkdir(historyDir(worktree), { recursive: true });
    const log = (text:string) => appendFile(checksLog(worktree),text);
    await autofix(worktree);
    const checked = await coderChecked(worktree);
    if (checked) await log('\nCoder checks passed on this exact tree.\n');
    const result = await projectCommands(worktree,[...(checked ? [] : config.commands.check),...config.commands.gates],[],log);
    await inspect(worktree);
    return result;
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
    const commit = await remoteHead(client,branch);
    if (!/^[a-f0-9]{40,64}$/.test(commit) || await run(client,'git',['rev-parse',`refs/heads/${branch}`]) !== commit) throw Error('Local task commit does not match remote');
    await realOps.uatBaseline(baseline);
    const root = `${stateRoot}/cache`;
    await mkdir(root,{recursive:true});
    const dir = await mkdtemp(`${root}/run-`), inputs = `${dir}/inputs`, scratch = `${dir}/scratch`, source = `${dir}/source`;
    for (const sub of [inputs,scratch,source]) await mkdir(sub);
    // The adapter and its fixtures come from the base branch, never from the task branch under test.
    await run(projectRoot,'git',['archive','-o',`${dir}/inputs.tar`,baseline,'--',...config.acceptance.inputs]);
    await run(projectRoot,'tar',['-xf',`${dir}/inputs.tar`,'-C',inputs]);
    await run(client,'git',['archive','-o',`${source}/project.tar`,commit]);
    // Never reuse an offline sandbox, even after an infrastructure failure.
    await sandbox.remove(branch,true);
    await sandbox.create(branch,scratch,true,[inputs,source,...(config.acceptance.assets ? [config.acceptance.assets] : [])]);
    try {
      const result = await sandbox.exec(branch,config.acceptance.command,{offline:true,workdir:inputs,timeoutMinutes:60,
        env:{...config.acceptance.env,FACTORY_ACCEPTANCE:'1',INPUTS:inputs,PROJECT_ARCHIVE:`${source}/project.tar`,
          ...(config.acceptance.assets ? {ASSETS:config.acceptance.assets} : {}),REPO:config.repo,REF:branch,COMMIT:commit}});
      if (result.code !== 0) throw Error(`Acceptance adapter failed (${result.code}): ${result.output.slice(-3000)}`);
      const verdict = z.strictObject({ commit: z.literal(commit), pass: z.boolean(), detail: z.string().min(1) }).parse(JSON.parse(result.stdout ?? result.output));
      const report = { ref: branch, ...verdict };
      await writeFile(join(dir,'report.json'),JSON.stringify(report));
      return { run: dir, report };
    } finally {
      await sandbox.remove(branch,true);
      await rm(scratch,{recursive:true,force:true});
      await rm(source,{recursive:true,force:true});
    }
  },

  async openDraftPr(worktree, title, body) {
    const branch = await run(worktree, "git", ["branch", "--show-current"]);
    return (await tracker.deliver(branch, await baseOf(worktree), title, body)).url;
  },

  async commentOnIssue(number, text) {
    await tracker.comment(number, text);
  },

};


const splitFile = (branch: string, member: string) =>
  `${stackDir(branch)}/splits/${member}.json`;


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
    return (await tracker.create('child', { title, body, parent, ...(after ? { after } : {}) })).id;
  },

  async retitleIssue(number, title) {
    await tracker.retitle(number, title);
  },

  async updateIssueSection(number, name, text) {
    await tracker.section(number, name, text);
  },

  async withReviewCheckout(work) {
    // Never use the read-only base checkout for an agent session.
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
    return (await tracker.state(number)).open;
  },

  closeIssue,

  async openStackPr(branch, title, body) {
    return (await tracker.deliver(branch, config.base, title, body)).url;
  },

};
