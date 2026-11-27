import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const cli = resolve(import.meta.dirname, '../src/cli.ts');

test('setup ignores only local assets and claims, without overwriting existing ignore rules', async t => {
  const root = await mkdtemp(join(tmpdir(), 'factory-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-qb', 'main');
  await writeFile(join(root, '.gitignore'), '# project rules\n');
  const bin = join(root, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'sbx'), '#!/bin/sh\nexit 1\n');
  await chmod(join(bin, 'sbx'), 0o755);
  const setup = () => execFileSync(process.execPath, [cli, 'setup'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.match(setup(), /Next \(examples and explanations: .*docs\/config\.md\)/);
  const ignore = join(root, '.factory/.gitignore');
  const original = await readFile(ignore, 'utf8');
  assert.match(original, /^assets\/$/m);
  assert.match(original, /^claims\/$/m);
  const ignored = (path: string) => {
    try { git('check-ignore', '-q', '--no-index', path); return true; } catch { return false; }
  };
  for (const path of ['.factory/assets/archive.tar.gz', '.factory/claims/item'])
    assert.equal(ignored(path), true, `${path} should be ignored`);
  for (const path of ['.factory/config.json', '.factory/acceptance/run.sh', '.factory/delivered/note.md', '.factory/items/item.closed'])
    assert.equal(ignored(path), false, `${path} should be versioned`);
  assert.equal(await readFile(join(root, '.gitignore'), 'utf8'), '# project rules\n');
  await writeFile(ignore, '# custom rules\nassets/\nclaims/\n');
  assert.match(setup(), /leaving it alone/);
  assert.equal(await readFile(ignore, 'utf8'), '# custom rules\nassets/\nclaims/\n');
});
