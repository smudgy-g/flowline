// The tracker adapter (docs/tracker.md): where work items come from, and where a finished change goes.
// Trusted factory code on the host, never in a sandbox and never reachable by an agent.
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { config, factoryRoot } from './config.ts';

const Item = z.strictObject({
  id: z.number().int().positive(), title: z.string().min(1), body: z.string(),
  url: z.string(), author: z.string(), comments: z.array(z.string()).default([]),
});
const Listed = z.array(z.strictObject({
  id: z.number().int().positive(), title: z.string().min(1), url: z.string(), stack: z.boolean().default(false),
}));
const Ok = z.strictObject({ ok: z.literal(true) });
const Created = z.strictObject({ id: z.number().int().positive() });
const Delivered = z.strictObject({ url: z.string().min(1) });
const State = z.strictObject({ open: z.boolean() });
const Acceptance = z.strictObject({ state: z.enum(['open', 'accepted', 'rejected']) });

type Call = (argv: string[], stdin: string) => Promise<string>;
const call: Call = (argv, stdin) => new Promise((done, fail) => {
  const [bin, ...rest] = config.tracker.command;
  const child = execFile(bin, [...rest, ...argv], {
    cwd: factoryRoot, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, ...config.tracker.env, FACTORY_REPO: config.repo, FACTORY_BASE: config.base, FACTORY_CHECKOUT: config.checkout },
  }, (error, stdout, stderr) => error
    ? fail(new Error(`tracker ${argv[0]} failed: ${(stderr || error.message).slice(-2000)}`))
    : done(stdout));
  child.stdin?.end(stdin);
});

/** The adapter, each verb parsed into the shape the lane expects. */
export function trackerClient(run: Call = call) {
  const verb = async <T>(shape: z.ZodType<T>, argv: (string | number)[], stdin = ''): Promise<T> => {
    const out = await run(argv.map(String), stdin);
    try { return shape.parse(JSON.parse(out)); }
    catch (error) { throw new Error(`tracker ${argv[0]} returned an unusable reply: ${(error as Error).message}`); }
  };
  return {
    list: () => verb(Listed, ['list']),
    read: (id: number) => verb(Item, ['read', id]),
    claim: (id: number, owner: string) => verb(Ok, ['claim', id, owner]),
    release: (id: number) => verb(Ok, ['release', id]),
    comment: (id: number, text: string) => verb(Ok, ['comment', id], text),
    create: (kind: 'task' | 'child', body: { title: string; body: string; parent?: number; after?: number }) =>
      verb(Created, ['create', kind], JSON.stringify(body)),
    retitle: (id: number, title: string) => verb(Ok, ['retitle', id], title),
    section: (id: number, name: string, text: string) => verb(Ok, ['section', id, name], text),
    state: (id: number) => verb(State, ['state', id]),
    close: (id: number, text: string) => verb(Ok, ['close', id], text),
    deliver: (branch: string, base: string, title: string, body: string) =>
      verb(Delivered, ['deliver', branch, base], JSON.stringify({ title, body })),
    delivered: (url: string) => verb(Acceptance, ['delivered', url]),
  };
}

export const tracker = trackerClient();
