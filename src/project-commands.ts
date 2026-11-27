import { basename, matchesGlob } from 'node:path';
import { config } from './config.ts';
import { sandbox } from './sandbox.ts';

// Quiesce the writable mount before the host reads it, including on a failed install/check.
export async function projectCommands(worktree: string, commands: string[][], changed: string[] = [], log?: (text: string)=>Promise<unknown>) {
  const item = basename(worktree);
  const codeFiles = changed.filter(f=>config.commands.changedCode.some(g=>matchesGlob(f,g)));
  let started = false;

  try {
    for (const command of commands) {
      if (command.includes('{changedCode}') && !codeFiles.length) continue;

      const argv = command.flatMap(a=>a === '{changedCode}' ? codeFiles : [a]);
      await log?.(`\n=== ${new Date().toISOString()} · ${JSON.stringify(argv)}\n`);
      started = true;
      const result = await sandbox.exec(item, argv, {env:config.commands.env,timeoutMinutes:40});
      await log?.(result.output);

      if (result.code === 124 || result.code === 137) throw Error(`${argv[0]} timed out or was killed`);

      if (result.code !== 0) return {ok:false as const,gate:command.join(' '),output:result.output.slice(-6000)};
    }

    return {ok:true as const};
  } finally {
    if (started && (await sandbox.list()).some(s=>s.name === `fx-${item}` && s.status !== 'stopped')) await sandbox.stop(item);
  }
}
