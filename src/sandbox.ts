import { execFile } from 'node:child_process';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { config, stateRoot } from './config.ts';

type Result = { code: number; output: string; stdout?: string };
type Cli = (argv: string[]) => Promise<Result>;

const cli: Cli = argv => new Promise((done, fail) => {
  execFile('sbx', ['--no-input', ...argv], { cwd: stateRoot, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err && typeof err.code !== 'number') return fail(err);

    done({ code: Number(err?.code ?? 0), output: stdout + stderr, stdout });
  });
});

const rows = z.array(z.object({ name: z.string(), status: z.string(), workspaces: z.array(z.string()).optional() }));

const id = (item: string, offline = false) => {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(item) || item.length > 54) throw Error('Invalid sandbox work item');

  return (offline ? 'fx-uat-' : 'fx-') + item;
};

// The CLI and board are separate processes. SQLite releases this short admission lock even if its owner dies.
async function admit<T>(file: string, op: () => Promise<T>) {
  await mkdir(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);

  try { db.exec('BEGIN IMMEDIATE'); return await op(); } finally { db.close(); }
}

export function sandboxClient(call: Cli = cli, settings = config.sandbox,
  lock = `${stateRoot}/sandbox-admission.sqlite`) {
  const must = async (args: string[]) => {
    const r = await call(args);

    if (r.code) throw Error(`sbx ${args[0]} (${r.code}): ${r.output.slice(-3000)}`);

    return r.stdout ?? r.output;
  };

  const list = async () => rows.parse(JSON.parse(await must(['list', '--json'])));

  const capacity = (all: Awaited<ReturnType<typeof list>>) => {
    if (all.filter(s => s.status !== 'stopped').length >= settings.maxConcurrent) throw Error('Sandbox capacity reached; stop an idle sandbox and retry');
  };

  return {
    list,
    async create(item: string, worktree: string, offline = false, readOnly: string[] = []) {
      const name = id(item, offline);

      for (const path of [worktree, ...readOnly]) {
        if (await realpath(path) !== path || path.includes(':') || path === resolve('/')) throw Error('Invalid sandbox mount');
      }

      await admit(lock, async () => {
        const all = await list();

        if (all.some(s => s.name === name)) throw Error(`Sandbox already exists: ${name}`);

        capacity(all);
        const { rules } = z.object({ rules: z.array(z.object({ id: z.string(), scope: z.string(), resource_type: z.string(), decision: z.string() })) }).parse(JSON.parse(await must(['policy','ls','--json'])));

        if (!rules.some(r => r.id === 'default-deny-all' && r.decision === 'deny') || rules.some(r => r.scope === 'global' && /^(network|http)/.test(r.resource_type) && r.decision !== 'deny')) throw Error('Worker needs an exclusive deny-all network policy');

        await must(['create','--name',name,'--cpus',String(settings.cpus),'--memory',settings.memory,'--skills','off','--static-mcp','none', ...(offline ? ['--deny-network','**'] : []), settings.kit,worktree,...readOnly.map(p=>`${p}:ro`)]);

        try {
          if (!offline && settings.allowlist.length) await must(['policy','allow','network','--sandbox',name,settings.allowlist.join(',')]);
        } catch (err) { await must(['rm','--force',name]); throw err; }
      });
    },
    async exec(item: string, argv: string[], options: {env?: Record<string,string>; timeoutMinutes: number; offline?: boolean; workdir?: string}) {
      const name = id(item, options.offline);

      if (!argv[0] || !Number.isSafeInteger(options.timeoutMinutes) || options.timeoutMinutes < 1) throw Error('Invalid sandbox command');

      const env = Object.entries(options.env ?? {}).flatMap(([k,v]) => {
        if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(k)) throw Error('Invalid environment name');

        return ['--env',`${k}=${v}`];
      });

      // exec implicitly starts a stopped VM. Reserve that start before releasing the admission lock.
      await admit(lock, async () => {
        const all = await list(), row = all.find(s => s.name === name);

        if (!row) throw Error(`Missing sandbox ${name}`);

        if (row.status !== 'running') { capacity(all.filter(s=>s.name !== name)); await must(['exec',name,'true']); }
      });
      return call(['exec',...env,...(options.workdir ? ['--workdir',options.workdir] : []),name,'timeout','-k','30s','--',`${options.timeoutMinutes}m`,...argv]);
    },
    stop: (item: string, offline = false) => admit(lock, () => must(['stop',id(item, offline)])),
    remove: (item: string, offline = false) => admit(lock, async () => {
      const name = id(item, offline);

      if ((await list()).some(s=>s.name === name)) await must(['rm','--force',name]);
    }),
  };
}

export const sandbox = sandboxClient();
