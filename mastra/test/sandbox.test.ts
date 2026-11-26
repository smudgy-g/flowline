import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sandboxClient } from '../src/sandbox.ts';

test('offline lifecycle; preserve argv and status; invalid ids, absent VMs and full workers fail closed', async t => {
  const dir = await mkdtemp(join(tmpdir(),'factory-sbx-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const calls: string[][] = []; let active = false;
  const s = sandboxClient(async a=>{
    calls.push(a);
    if(a[0]==='list') return {code:0, output:JSON.stringify(active ? [{name:'fx-uat-42-test',status:'running'}] : [])};
    if(a[0]==='policy') return {code:0,output:JSON.stringify({rules:[{id:'default-deny-all',scope:'global',resource_type:'network',decision:'deny'}]})};
    if(a[0]==='exec') return {code:17,output:'not green'};
    if(a[0]==='create') active=true;
    return {code:0,output:''};
  },{kit:'shell',cpus:2,memory:'2g',allowlist:['registry.npmjs.org'],maxConcurrent:1},join(dir,'lock'));
  await assert.rejects(s.create('../escape',dir),/Invalid/);
  await assert.rejects(s.create('-flag',dir),/Invalid/);
  await assert.rejects(s.exec('42-test',['true'],{timeoutMinutes:1}),/Missing/);
  await s.create('42-test',dir,true);
  assert.ok(calls.some(a=>a.includes('--deny-network') && a.includes('**')));
  assert.ok(!calls.some(a=>a.includes('allow')));
  await assert.rejects(s.create('43-test',dir),/capacity/);
  assert.deepEqual(await s.exec('42-test',['echo','a; b'],{env:{CI:'true'},timeoutMinutes:2,offline:true}),{code:17,output:'not green'});
  assert.deepEqual(calls.at(-1),['exec','--env','CI=true','fx-uat-42-test','timeout','-k','30s','--','2m','echo','a; b']);
  await s.stop('42-test',true); await s.remove('42-test',true);
  assert.deepEqual(calls.at(-1),['rm','--force','fx-uat-42-test']);
});

