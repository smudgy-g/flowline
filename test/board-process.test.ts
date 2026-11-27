import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const cli = resolve(import.meta.dirname, '../src/cli.ts');

test('background boards are per-project; stopping one never stops another or an unowned PID', async t => {
  const roots: string[] = [];

  const create = async () => {
    const root = await mkdtemp(join(tmpdir(), 'factory-board-'));
    roots.push(root);
    await mkdir(join(root, '.factory'), { recursive: true });
    await writeFile(join(root, '.factory/config.json'), JSON.stringify({
      base: 'main', paths: { tests: ['**/*.test.ts'] },
      sandbox: { kit: 'shell', cpus: 1, memory: '2g', maxConcurrent: 1 },
      commands: { changedCode: ['**/*.ts'], gates: [['node', '--test']] },
    }));
    return root;
  };

  const a = await create();
  const b = await create();

  const run = async (cwd: string, action: string) =>
    (await exec(process.execPath, [cli, 'board', action], { cwd, env: { ...process.env, FACTORY_PROJECT: cwd, FACTORY_STATE: join(cwd, 'state') }, timeout: 45000 })).stdout;

  t.after(async () => {
    for (const root of roots) {
      await run(root, 'stop').catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  });
  const first = await run(a, 'start');
  const second = await run(b, 'start');
  const firstPort = Number(first.match(/localhost:(\d+)\/board/)?.[1]);
  const secondPort = Number(second.match(/localhost:(\d+)\/board/)?.[1]);
  assert.ok(firstPort && secondPort && firstPort !== secondPort, `${first}\n${second}`);
  assert.match(await run(a, 'start'), /Already running/);
  await run(a, 'stop');
  assert.equal((await fetch(`http://127.0.0.1:${secondPort}/board/_identity`)).status, 200);
  // A stale/forged record cannot signal a PID it doesn't own.
  const record = join(a, 'state/board.json');
  const owner = JSON.parse(await readFile(join(b, 'state/board.json'), 'utf8'));
  await writeFile(record, JSON.stringify({ ...owner, identity: 'not-the-board-token' }));
  assert.match(await run(a, 'stop'), /No board started/);
  assert.equal((await fetch(`http://127.0.0.1:${secondPort}/board/_identity`)).status, 200);
});
