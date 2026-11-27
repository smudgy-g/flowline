import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const exec = promisify(execFile);

// Read registration from the checkout's private gitdir. Never discover it from mounted files.
export async function taskGitEnv(checkout: string, worktree: string) {
  if (await realpath(worktree) !== worktree) throw Error('Unexpected worktree path');

  const safe = { GIT_CONFIG_COUNT:'3', GIT_CONFIG_KEY_0:'core.hooksPath', GIT_CONFIG_VALUE_0:'/dev/null',
    GIT_CONFIG_KEY_1:'core.fsmonitor', GIT_CONFIG_VALUE_1:'false', GIT_CONFIG_KEY_2:'submodule.recurse', GIT_CONFIG_VALUE_2:'false' };

  const common = (await exec('git',['rev-parse','--path-format=absolute','--git-common-dir'],{cwd:checkout,env:{...process.env,...safe}})).stdout.trim();
  const entries = join(common,'worktrees');

  for (const entry of await readdir(entries,{withFileTypes:true})) {
    if (!entry.isDirectory()) continue;

    const dir = join(entries,entry.name);
    const owner = (await readFile(join(dir,'gitdir'),'utf8')).trim();

    if (resolve(dir,owner) === join(worktree,'.git')) return {...safe, GIT_DIR:dir,GIT_WORK_TREE:worktree};
  }

  throw Error(`No trusted Git registration for ${worktree}`);
}
