import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('UAT dispatch pins inputs and source, receives verdict on stdout and removes the offline VM even on mismatch', async t=>{
  const dir = await mkdtemp(join(tmpdir(),'sbx-offline-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const profile=JSON.parse(await readFile(new URL('../../factory.config.json',import.meta.url),'utf8'));
  const checkout=join(dir,'target'); Object.assign(profile,{workspace:dir,checkout,worktrees:'trees'});
  profile.uat={assets:'kit',inputs:['probe'],command:['probe'],env:{}};
  await mkdir(join(dir,'kit'));await mkdir(checkout);await writeFile(join(dir,'factory.config.json'),JSON.stringify(profile));
  const git=(cwd:string,...args:string[])=>execFileSync('git',['-c','user.name=test','-c','user.email=test@example.org',...args],{cwd,encoding:'utf8'}).trim();
  git(dir,'init','-q');await writeFile(join(dir,'probe'),'pinned');git(dir,'add','probe');git(dir,'commit','-qm','inputs'); const pinned=git(dir,'rev-parse','HEAD');await writeFile(join(dir,'probe'),'not pinned');
  git(checkout,'init','-qb','41-test');await writeFile(join(checkout,'hello'),'approved');git(checkout,'add','hello');git(checkout,'commit','-qm','target');git(checkout,'remote','add','origin',checkout);const commit=git(checkout,'rev-parse','HEAD');
  const file=join(dir,'sbx');await writeFile(file,`#!/bin/bash
set -eu
cd "${dir}"; shift
case "$1" in
list) if test -e created; then echo '[{"name":"fx-uat-41-test","status":"running"}]'; else echo '[]'; fi;;
policy) echo '{"rules":[{"id":"default-deny-all","decision":"deny","scope":"global","resource_type":"network"}]}' ;;
create) [[ " $* " == *' --deny-network ** '* ]]; touch created;;
rm) rm created;;
exec) for arg; do case "$arg" in INPUTS=*|PROJECT_ARCHIVE=*|UAT_COMMIT=*|UAT_REF=*) export "$arg";; esac; done
[[ $(<"$INPUTS/probe") == pinned && $(tar -xOf "$PROJECT_ARCHIVE" hello) == approved ]]
if test -e wrong; then UAT_COMMIT=stale; fi; printf '{"commit":"%s","ref":"%s","pass":false,"failure":"build"}' "$UAT_COMMIT" "$UAT_REF";;
esac\n`,{mode:0o755});
  const path=process.env.PATH,root=process.env.FACTORY_ROOT;process.env.PATH=dir+':'+path;process.env.FACTORY_ROOT=dir;t.after(()=>{process.env.PATH=path;if(root===undefined) delete process.env.FACTORY_ROOT;else process.env.FACTORY_ROOT=root});
  const {realOps}=await import('../src/ops.ts');const result=await realOps.runUat('41-test',pinned);assert.equal(result.report.commit,commit);assert.equal(JSON.parse(await readFile(join(result.run,'report.json'),'utf8')).pass,false);await assert.rejects(readFile(join(dir,'created')),{code:'ENOENT'});
  await writeFile(join(dir,'wrong'),'');await assert.rejects(realOps.runUat('41-test',pinned),/Invalid acceptance report/);await assert.rejects(readFile(join(dir,'created')),{code:'ENOENT'});
});
