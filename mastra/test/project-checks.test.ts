import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Use the documented profile, but stand in for Go with short, offline commands.
test("a project's gates run in order in the worktree and stop on failure", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "factory-checks-"));
  const previous = process.env.FACTORY_ROOT;
  process.env.FACTORY_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const profile = JSON.parse(await readFile(new URL("../../examples/go.factory.json", import.meta.url), "utf8"));
  const worktree = join(root, profile.worktrees, "task");
  profile.workspace = ".";
  profile.checks.gates = [["pwd"], ["false"], ["echo", "must-not-run"]];
  await writeFile(join(root, "factory.config.json"), JSON.stringify(profile));
  await mkdir(worktree, { recursive: true });
  await mkdir(join(root, ".cache"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree });
  git("init", "-q", "-b", "main");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base", "--allow-empty");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const { ProjectChecks } = await import("../src/config.ts");
  assert.equal(ProjectChecks.safeParse({ gates: [] }).success, false);
  assert.equal(ProjectChecks.safeParse({ gates: [[]] }).success, false);
  const { realOps, checksLog } = await import("../src/ops.ts");
  const result = await realOps.runGates(worktree);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.gate, "false");
  const log = await readFile(checksLog(worktree), "utf8");
  assert.ok(log.includes(`\n${worktree}\n`));
  assert.ok(!log.includes("must-not-run"));
});
