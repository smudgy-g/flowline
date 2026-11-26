import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import './workflow-profile.ts';
import { taskGitEnv } from '../src/worktree-git.ts';

test('host git uses registered gitdir, not a planted .git, hook or fsmonitor',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'task-git-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const checkout=join(dir,'base'), worktree=join(dir,'42-item'), other=join(dir,'other');
  await mkdir(checkout);const git=(cwd:string,...a:string[])=>execFileSync('git',a,{cwd,encoding:'utf8'});
  git(checkout,'init','-q');git(checkout,'-c','user.email=test@example.com','-c','user.name=test','commit','-qm','base','--allow-empty');
  git(checkout,'worktree','add','-qb','42-item',worktree);git(checkout,'init','-q',other);
  const hook=join(dir,'pre-commit'), marker=join(dir,'ran'); await writeFile(hook,`#!/bin/sh\ntouch '${marker}'\n`,{mode:0o755});
  git(checkout,'config','core.fsmonitor',hook);git(checkout,'config','core.hooksPath',dir);
  await writeFile(join(worktree,'.git'),`gitdir: ${other}/.git\n`);
  const opts={cwd:worktree,env:{...process.env,...await taskGitEnv(checkout,worktree)},encoding:'utf8' as const};
  assert.equal(execFileSync('git',['branch','--show-current'],opts).trim(),'42-item');
  execFileSync('git',['status','--porcelain'],opts);
  execFileSync('git',['-c','user.name=test','-c','user.email=test@example.com','commit','-qm','checked','--allow-empty'],opts);
  await assert.rejects(readFile(marker),{code:'ENOENT'});
});
