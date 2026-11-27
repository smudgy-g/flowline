import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('UAT pins inputs to the base branch and the source to the pushed commit, and removes the offline VM even on mismatch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'sbx-offline-')); t.after(() => rm(dir, { recursive: true, force: true }));

  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.org', ...args], { cwd, encoding: 'utf8' }).trim();

  // One repository: the project. Its base branch owns the acceptance inputs; the task branch owns the code.
  await mkdir(join(dir, '.factory'), { recursive: true });
  await mkdir(join(dir, 'kit'));
  await writeFile(join(dir, '.factory/config.json'), JSON.stringify({
    repo: 'example/target', base: 'main',
    paths: { tests: ['t/**'] },
    sandbox: { kit: 'shell', cpus: 2, memory: '2g', maxConcurrent: 1 },
    commands: { changedCode: ['**/*'], gates: [['true']] },
    acceptance: { assets: 'kit', inputs: ['probe'], command: ['probe'] },
  }));
  git(dir, 'init', '-qb', 'main');
  await writeFile(join(dir, 'probe'), 'pinned');
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'inputs');
  const pinned = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'remote', 'add', 'origin', dir);

  git(dir, 'checkout', '-qb', '41-test');
  await writeFile(join(dir, 'hello'), 'approved');
  git(dir, 'add', 'hello'); git(dir, 'commit', '-qm', 'the change');
  const commit = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  await writeFile(join(dir, 'probe'), 'not pinned'); // the working tree is never what acceptance runs

  const file = join(dir, 'sbx'); await writeFile(file, `#!/bin/bash
set -eu
cd "${dir}"; shift
case "$1" in
list) if test -e created; then echo '[{"name":"fx-uat-41-test","status":"running"}]'; else echo '[]'; fi;;
policy) echo '{"rules":[{"id":"default-deny-all","decision":"deny","scope":"global","resource_type":"network"}]}' ;;
create) [[ " $* " == *' --deny-network ** '* ]]; if test -e create-fails; then exit 7; fi; touch created;;
rm) rm created;;
exec) for arg; do case "$arg" in INPUTS=*|PROJECT_ARCHIVE=*|COMMIT=*|REF=*) export "$arg";; esac; done
[[ $(<"$INPUTS/probe") == pinned && $(tar -xOf "$PROJECT_ARCHIVE" hello) == approved ]]
if test -e wrong; then COMMIT=stale; fi; printf '{"commit":"%s","pass":false,"detail":"build failed"}' "$COMMIT";;
esac\n`, { mode: 0o755 });

  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  process.env.FACTORY_PROJECT = dir;
  process.env.FACTORY_STATE = join(dir, 'state');
  t.after(() => { process.env.PATH = path; delete process.env.FACTORY_PROJECT; delete process.env.FACTORY_STATE; });

  const { realOps } = await import('../src/ops.ts');
  const result = await realOps.runUat('41-test', pinned);
  assert.deepEqual(result.report, { ref: '41-test', commit, pass: false, detail: 'build failed' });
  assert.equal(JSON.parse(await readFile(join(result.run, 'report.json'), 'utf8')).pass, false);
  await assert.rejects(readFile(join(dir, 'created')), { code: 'ENOENT' });

  const cache = join(dir, 'state/cache');
  const before = await readdir(cache);
  await writeFile(join(dir, 'wrong'), '');
  await assert.rejects(realOps.runUat('41-test', pinned), /commit/);
  await assert.rejects(readFile(join(dir, 'created')), { code: 'ENOENT' });
  assert.deepEqual(await readdir(cache), before, 'failed verdicts leave no temporary archives');

  await rm(join(dir, 'wrong'));
  await writeFile(join(dir, 'create-fails'), '');
  await assert.rejects(realOps.runUat('41-test', pinned), /sbx create/);
  assert.deepEqual(await readdir(cache), before, 'sandbox creation failures leave no temporary archives');
});
