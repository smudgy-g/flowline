// Per-project background board. A token returned by the local server proves ownership before we signal a PID;
// a stale PID file must never kill another process (or a different project's board).
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config, projectRoot, stateRoot } from './config.ts';
import { startBoard } from './server.ts';

const recordFile = join(stateRoot, 'board.json');
type Record = { pid: number; port: number; identity: string };
const url = (port: number) => `http://localhost:${port}/board`;

async function owned(): Promise<Record | null> {
  const record = await readFile(recordFile, 'utf8').then(s => JSON.parse(s) as Record, () => null);
  if (!record || !Number.isInteger(record.port) || !Number.isInteger(record.pid) || !record.identity) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/board/_identity`, { signal: AbortSignal.timeout(1500) });
    const actual = await response.json() as { identity: string; pid: number };
    return actual.identity === record.identity && actual.pid === record.pid ? record : null;
  } catch { return null; }
}

export async function boardStart() {
  // shortcut: simultaneous starts for the same repo may race; add an interprocess lock if operators need that.
  const running = await owned();
  if (running) return console.log(`Already running: ${url(running.port)} (${projectRoot})`);
  await mkdir(stateRoot, { recursive: true });
  const log = openSync(join(stateRoot, 'board.log'), 'a');
  const child = spawn(process.execPath, [process.argv[1], 'board', '_serve'], {
    cwd: projectRoot, detached: true, env: { ...process.env, FACTORY_PROJECT: projectRoot, FACTORY_STATE: stateRoot },
    stdio: ['ignore', log, log, 'ipc'],
  });
  closeSync(log);
  const result = await new Promise<{ port?: number; error?: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Board startup timed out; see ${stateRoot}/board.log`));
    }, 30_000);
    const finish = (value: { port?: number; error?: string }) => { clearTimeout(timer); resolve(value); };
    child.once('message', message => finish(message as { port?: number; error?: string }));
    child.once('exit', () => finish({ error: `Board exited on startup; see ${stateRoot}/board.log` }));
    child.once('error', reject);
  });
  if (result.error || !result.port) {
    child.disconnect(); child.unref();
    throw new Error(result.error || 'Board did not report a port');
  }
  child.disconnect(); child.unref();
  console.log(`${config.repo} · ${projectRoot}\n${url(result.port)}`);
}

export async function boardServe() {
  const identity = randomUUID();
  try {
    const preferred = Number(process.env.PORT);
    if (process.env.PORT && (!Number.isInteger(preferred) || preferred < 1 || preferred > 65535)) throw new Error('PORT must be a port number (1–65535)');
    for (const port of process.env.PORT ? [preferred] : Array.from({ length: 20 }, (_, i) => 4111 + i)) {
      try {
        await startBoard(port, identity);
        await mkdir(stateRoot, { recursive: true });
        await writeFile(recordFile, JSON.stringify({ pid: process.pid, port, identity }));
        process.send?.({ port });
        return;
      } catch (error) {
        if ((error as Error).message.includes(`Port ${port} is already in use`) && !process.env.PORT) continue;
        throw error;
      }
    }
    throw new Error('All board ports 4111–4130 are occupied; set PORT to choose another');
  } catch (error) {
    process.send?.({ error: (error as Error).message });
    throw error;
  }
}

export async function boardStop() {
  const record = await owned();
  if (!record) return console.log(`No board started for ${projectRoot} (manual boards use Ctrl-C).`);
  process.kill(record.pid, 'SIGTERM');
  await rm(recordFile, { force: true });
  console.log(`Stopped ${url(record.port)} (${projectRoot})`);
}
