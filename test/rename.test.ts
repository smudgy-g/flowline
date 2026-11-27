import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';

const config = resolve(import.meta.dirname, '../src/config.ts');

test('Flowline uses new state for new projects and preserves existing Frankenstein runs', async t => {
  const home = await mkdtemp(join(tmpdir(), 'flowline-rename-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, 'project');
  await mkdir(join(project, '.factory'), { recursive: true });
  await writeFile(join(project, '.factory/config.json'), JSON.stringify({
    paths: { tests: ['test/**'] }, sandbox: { kit: 'shell', cpus: 2, memory: '2g', maxConcurrent: 1 },
    commands: { changedCode: ['**/*'], gates: [['true']] },
  }));
  const env: NodeJS.ProcessEnv = { ...process.env, FACTORY_PROJECT: project, XDG_STATE_HOME: home };
  delete env.FACTORY_STATE;
  const state = () => execFileSync(process.execPath, ['--input-type=module', '-e', `import { stateRoot } from ${JSON.stringify(config)}; console.log(stateRoot)`], { env, encoding: 'utf8' }).trim();
  const fresh = state();
  assert.equal(fresh, join(home, 'flowline', basename(fresh)));
  const legacy = join(home, 'frankenstein', basename(fresh));
  await mkdir(legacy, { recursive: true });
  assert.equal(state(), legacy);
});

test('new task worktrees live in state; registered legacy worktrees keep their path', async t => {
  const home = await mkdtemp(join(tmpdir(), 'flowline-trees-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const project = join(home, 'project');
  await mkdir(join(project, '.factory'), { recursive: true });
  const profile = { paths: { tests: ['test/**'] }, sandbox: { kit: 'shell', cpus: 2, memory: '2g', maxConcurrent: 1 }, commands: { changedCode: ['**/*'], gates: [['true']] } };
  await writeFile(join(project, '.factory/config.json'), JSON.stringify(profile));
  const env: NodeJS.ProcessEnv = { ...process.env, FACTORY_PROJECT: project, XDG_STATE_HOME: home };
  delete env.FACTORY_STATE;
  const worktrees = () => execFileSync(process.execPath, ['--input-type=module', '-e', `import { config } from ${JSON.stringify(config)}; console.log(config.worktrees)`], { env, encoding: 'utf8' }).trim();
  const git = (...args: string[]) => execFileSync('git', args, { cwd: project, encoding: 'utf8' }).trim();
  git('init', '-qb', 'main');
  assert.match(worktrees(), /\/flowline\/project-[a-f0-9]{8}\/worktrees\/$/);
  const old = join(home, 'project-worktrees');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-qm', 'base');
  git('worktree', 'add', '--detach', join(old, 'task'));
  assert.equal(worktrees(), `${old}/`);
  git('worktree', 'remove', join(old, 'task'));
  assert.match(worktrees(), /\/flowline\/project-[a-f0-9]{8}\/worktrees\/$/);
  await writeFile(join(project, '.factory/config.json'), JSON.stringify({ ...profile, worktrees: '../custom' }));
  assert.equal(worktrees(), `${join(home, 'custom')}/`);
});
