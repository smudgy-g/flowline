import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { trackerClient } from '../src/tracker.ts';

test('the client rejects a reply the lane could not trust', async () => {
  const t = (out: string) => trackerClient(async () => out);
  await assert.rejects(t('not json').list(), /unusable/);
  await assert.rejects(t('{"id":"42","title":"x","body":"","url":"","author":"a"}').read(42), /unusable/);
  await assert.rejects(t('{"ok":false}').claim(42, 'factory'), /unusable/);
  await assert.rejects(t('{"state":"merged"}').delivered('u'), /unusable/);
  assert.deepEqual(await t('{"state":"accepted"}').delivered('u'), { state: 'accepted' });
});

test('the local adapter keeps items in the repo, claims exclusively and accepts on merge', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tracker-local-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-qb', 'main');
  git('commit', '-qm', 'base', '--allow-empty');
  await mkdir(join(root, '.factory/items'), { recursive: true });
  await writeFile(join(root, '.factory/items/7.md'), '# Add a health endpoint\n\n### Outcome\n\nIt answers 200.\n\n### Lane\n\nfast lane\n');
  const adapter = join(import.meta.dirname, '../../trackers/local.mjs');
  const local = trackerClient(async (argv, stdin) =>
    execFileSync('node', [adapter, ...argv], { input: stdin, encoding: 'utf8', env: { ...process.env, FACTORY_CHECKOUT: root, FACTORY_BASE: 'main' } }));

  assert.deepEqual(await local.list(), [{ id: 7, title: 'Add a health endpoint', url: `file://${root}/.factory/items/7.md`, stack: false }]);
  await local.comment(7, 'Use /healthz.');
  const item = await local.read(7);
  assert.match(item.body, /It answers 200\.[\s\S]*---[\s\S]*Use \/healthz\./);
  assert.deepEqual(item.comments, ['Use /healthz.']);

  assert.deepEqual(await local.claim(7, 'factory'), { ok: true });
  assert.deepEqual(await local.claim(7, 'factory'), { ok: true }, 'claiming twice is safe');
  await assert.rejects(local.claim(7, 'other'), /already running on factory/);
  assert.deepEqual(await local.list(), [], 'a claimed item is nobody else\'s to start');
  await local.release(7);
  assert.equal((await local.list()).length, 1);

  await local.section(7, 'Lane', 'standard');
  assert.match(await readFile(join(root, '.factory/items/7.md'), 'utf8'), /### Lane\n\nstandard\n/);
  await local.retitle(7, 'Add /healthz');
  assert.equal((await local.read(7)).title, 'Add /healthz');

  const child = await local.create('child', { title: 'Member one', body: 'First PR.', parent: 7 });
  assert.equal(child.id, 8);
  assert.deepEqual((await local.list()).map(i => i.id), [7], 'a stack member is not startable on its own');

  const { url } = await local.deliver('7-add-healthz', 'main', 'Add /healthz', 'The change.');
  assert.deepEqual(await local.delivered(url), { state: 'open' });
  git('checkout', '-qb', '7-add-healthz');
  git('commit', '-qm', 'work', '--allow-empty');
  git('checkout', '-q', 'main');
  assert.deepEqual(await local.delivered(url), { state: 'open' }, 'unmerged work is not accepted');
  git('merge', '-q', '7-add-healthz');
  assert.deepEqual(await local.delivered(url), { state: 'accepted' });

  assert.deepEqual(await local.state(7), { open: true });
  await local.close(7, 'Merged.');
  assert.deepEqual(await local.state(7), { open: false });
  await assert.rejects(local.read(7), /closed/);
  await assert.rejects(local.read(99), /No work item 99/);
});
