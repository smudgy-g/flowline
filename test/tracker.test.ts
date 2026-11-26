import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import './workflow-profile.ts';
import { trackerClient } from '../src/tracker.ts';

test('the client rejects a reply the lane could not trust', async () => {
  const t = (out: string) => trackerClient(async () => out);
  await assert.rejects(t('not json').list(), /unusable/);
  await assert.rejects(t('{"id":"../escape","title":"x","body":"","url":"","author":"a"}').read('7'), /unusable/);
  await assert.rejects(t('{"ok":false}').claim('7', 'factory'), /unusable/);
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
  await writeFile(join(root, '.factory/items/health.md'), '# Add a health endpoint\n\n### Outcome\n\nIt answers 200.\n\n### Lane\n\nfast lane\n');
  const adapter = join(import.meta.dirname, '../trackers/local.mjs');
  const local = trackerClient(async (argv, stdin) =>
    execFileSync('node', [adapter, ...argv], { input: stdin, encoding: 'utf8', env: { ...process.env, FACTORY_CHECKOUT: root, FACTORY_BASE: 'main' } }));

  assert.deepEqual(await local.list(), [{ id: 'health', title: 'Add a health endpoint', url: `file://${root}/.factory/items/health.md`, stack: false }]);
  await local.comment('health', 'Use /healthz.');
  const item = await local.read('health');
  assert.match(item.body, /It answers 200\.[\s\S]*---[\s\S]*Use \/healthz\./);
  assert.deepEqual(item.comments, ['Use /healthz.']);

  assert.deepEqual(await local.claim('health', 'factory'), { ok: true });
  assert.deepEqual(await local.claim('health', 'factory'), { ok: true }, 'claiming twice is safe');
  await assert.rejects(local.claim('health', 'other'), /already running on factory/);
  assert.deepEqual(await local.list(), [], 'a claimed item is nobody else\'s to start');
  await local.release('health');
  assert.equal((await local.list()).length, 1);

  await local.section('health', 'Lane', 'standard');
  assert.match(await readFile(join(root, '.factory/items/health.md'), 'utf8'), /### Lane\n\nstandard\n/);
  await local.retitle('health', 'Add /healthz');
  assert.equal((await local.read('health')).title, 'Add /healthz');

  const child = await local.create('child', { title: 'Member one', body: 'First PR.', parent: 'health' });
  assert.equal(child.id, 'member-one');
  assert.deepEqual((await local.list()).map(i => i.id), ['health'], 'a stack member is not startable on its own');

  const { url } = await local.deliver('health-endpoint', 'main', 'Add /healthz', 'The change.');
  assert.deepEqual(await local.delivered(url), { state: 'open' });
  git('checkout', '-qb', 'health-endpoint');
  git('commit', '-qm', 'work', '--allow-empty');
  git('checkout', '-q', 'main');
  assert.deepEqual(await local.delivered(url), { state: 'open' }, 'unmerged work is not accepted');
  git('merge', '-q', 'health-endpoint');
  assert.deepEqual(await local.delivered(url), { state: 'accepted' });

  assert.deepEqual(await local.state('health'), { open: true });
  await local.close('health', 'Merged.');
  assert.deepEqual(await local.state('health'), { open: false });
  assert.equal(existsSync(join(root, '.factory/claims/health')), false, 'closing releases the claim');
  await assert.rejects(local.read('health'), /closed/);
  await assert.rejects(local.read('nope'), /No work item nope/);
});

test('state belongs to one repo and one tracker', async t => {
  // config is a module singleton, so this checks the real checkout's owner file and puts it back.
  const { stateRoot, config } = await import('../src/config.ts');
  const { checkOwner } = await import('../src/runs.ts');
  const file = join(stateRoot, 'owner.json');
  const before = await readFile(file, 'utf8').catch(() => null);
  t.after(async () => { before === null ? await rm(file, { force: true }) : await writeFile(file, before); });

  await rm(file, { force: true });
  await checkOwner();
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { repo: config.repo, tracker: config.tracker.command.join(' ') });
  await checkOwner();

  await writeFile(file, JSON.stringify({ repo: 'other/repo', tracker: 'node trackers/github.mjs' }));
  await assert.rejects(checkOwner(), /belongs to other\/repo via node trackers\/github\.mjs/);
});

test('model switches are read from the project at each call without restarting the board', async t => {
  const { projectRoot, config, currentModels, setModel } = await import('../src/config.ts');
  const file = join(projectRoot, '.factory/config.json');
  const original = await readFile(file, 'utf8');
  t.after(() => writeFile(file, original));
  assert.equal(currentModels().planner, undefined);
  await setModel('planner', 'anthropic/claude-sonnet-5-5');
  assert.equal(currentModels().planner, 'anthropic/claude-sonnet-5-5');
  assert.equal(config.base, 'main', 'other settings remain pinned for the board lifetime');
  await writeFile(file, JSON.stringify({ ...JSON.parse(original), models: { planner: 'openai-codex/gpt-6.2-sol' } }));
  assert.equal(currentModels().planner, 'openai-codex/gpt-6.2-sol');
  await assert.rejects(setModel('other' as 'planner', 'x'));
});

test('only "all" and item run ids can be paused', async () => {
  const { setPaused, paused } = await import('../src/ops.ts');
  const { runIdFor } = await import('../src/runs.ts');
  const id = runIdFor('basket-discount');
  await setPaused(id, true);
  assert.equal(await paused(id), true);
  await setPaused(id, false);
  assert.equal(await paused(id), false);
  await assert.rejects(setPaused('../escape', true), /Can't pause/);
});
