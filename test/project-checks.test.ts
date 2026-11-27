import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The documented Go profile, with its commands stood in for by short ones, all dispatched to a fake sbx.
test("checks and gates run in the item's sandbox, in order, stopping at the first failure", async t => {
  const root = await mkdtemp(join(tmpdir(), "factory-checks-"));
  const previous = { path: process.env.PATH };
  t.after(async () => {
    process.env.PATH = previous.path;
    delete process.env.FACTORY_PROJECT;
    delete process.env.FACTORY_STATE;
    await rm(root, { recursive: true, force: true });
  });
  const profile = JSON.parse(await readFile(new URL("../examples/go.factory.json", import.meta.url), "utf8"));
  profile.worktrees = "../trees";
  Object.assign(profile.commands, { autofix: [["fix", "{changedCode}"]], check: [["vet"]], gates: [["suite"], ["never"]] });
  const base = join(root, "base");
  const worktree = join(root, "trees", "42-item");
  await mkdir(base);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: base });
  git("init", "-qb", "main");
  git("commit", "-qm", "base", "--allow-empty");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("worktree", "add", "-qb", "42-item", worktree);
  await writeFile(join(worktree, "main.go"), "package main\n");
  await mkdir(join(base, ".factory"), { recursive: true });
  await writeFile(join(base, ".factory/config.json"), JSON.stringify(profile));
  await writeFile(join(root, "sbx"), `#!/bin/bash
cd ${root}; shift
case "$1" in
list) echo '[{"name":"fx-42-item","status":"running"}]';;
exec) shift; while [[ $1 == --env || $1 == --workdir ]]; do shift 2; done; shift 6; echo "ran $*" >>dispatched; [[ $1 != suite ]];;
stop) echo stopped >>dispatched;;
esac\n`, { mode: 0o755 });
  process.env.FACTORY_PROJECT = base;
  process.env.FACTORY_STATE = join(root, "state");
  process.env.PATH = `${root}:${previous.path}`;
  const { realOps, removeTask } = await import("../src/ops.ts");
  const result = await realOps.runGates(worktree);
  assert.deepEqual(result, { ok: false, gate: "suite", output: "" });
  const dispatched = await readFile(join(root, "dispatched"), "utf8");
  assert.equal(dispatched, "ran fix main.go\nstopped\nran vet\nran suite\nstopped\n", "autofix, then check, then the failing gate; never past it, and the sandbox stops after each batch");
  assert.ok(!dispatched.includes("never"));

  await writeFile(join(worktree, " leading.go"), "package main\n");
  assert.ok((await realOps.inspect(worktree)).files.includes(" leading.go"), "NUL-separated git paths retain leading whitespace");
  await assert.rejects(removeTask(worktree, "42-item", false), /Uncommitted changes/);
  await symlink("main.go", join(worktree, "link"));
  await assert.rejects(realOps.inspect(worktree), /Unsafe task path/);
  await removeTask(worktree, "42-item", true);
});
