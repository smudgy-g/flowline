import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("acceptance uses the pinned adapter and refuses an unverified commit", async t => {
  const root = await mkdtemp(join(tmpdir(), "factory-acceptance-"));
  const previous = process.env.FACTORY_ROOT;
  process.env.FACTORY_ROOT = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.FACTORY_ROOT;
    else process.env.FACTORY_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.org", ...args], { cwd, encoding: "utf8" }).trim();
  const target = join(root, "target");
  await mkdir(target);
  git(target, "init", "-qb", "main");
  git(target, "commit", "-qm", "base", "--allow-empty");
  git(target, "remote", "add", "origin", target);
  const sha = git(target, "rev-parse", "HEAD");
  await writeFile(join(root, "factory.config.json"), JSON.stringify({ repo: "test/project", base: "main", workspace: ".", checkout: "target", worktrees: "trees", paths: { tests: ["tests/**"] }, checks: { gates: [["false"]] }, skills: { packs: ["skills/core"], coder: { always: [] } } }));
  await mkdir(join(root, "acceptance"));
  const adapter = join(root, "acceptance/run.sh");
  git(root, "init", "-qb", "main");
  await writeFile(adapter, `test "$1:$2" = test/project:main || exit 2\nprintf '{"commit":"%s","pass":false,"detail":"failed check"}' "$3"\n`);
  git(root, "add", "acceptance");
  git(root, "commit", "-qm", "first adapter");
  const { realOps } = await import("../src/ops.ts");
  const pinned = await realOps.uatBaseline();
  await writeFile(adapter, `echo '{"commit":"wrong","pass":true,"detail":"stale"}'\n`);
  git(root, "commit", "-qam", "different adapter");
  const { report } = await realOps.runUat("main", pinned);
  assert.deepEqual(report, { ref: "main", commit: sha, pass: false, detail: "failed check" });
  await assert.rejects(realOps.runUat("main", await realOps.uatBaseline()), /commit/);
});
