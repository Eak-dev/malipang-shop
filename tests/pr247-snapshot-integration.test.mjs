import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Runs the real candidate shell script, real jq, and the real stage guard.
// All network/Cloudflare/Wrangler interactions are synthetic fixtures.
const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(testDir);
const jqProbe = spawnSync(process.env.MP248_JQ_PATH || 'jq', ['--version'], {encoding:'utf8'});
const jqAvailable = jqProbe.status === 0 && /^jq-/.test(jqProbe.stdout);
if (!jqAvailable && (process.env.CI || process.env.MP248_JQ_PATH)) {
  throw new Error('A working jq is required on CI and when MP248_JQ_PATH is set');
}
const jqTestOptions = {skip: jqAvailable ? false : 'jq is not installed locally'};
const sha = 'a'.repeat(40);
const g5 = '11111111-1111-4111-8111-111111111111';
const g6 = '22222222-2222-4222-8222-222222222222';
const prior = '310192aa-8a04-4b61-8a72-4455231b3339';
const queue = 'synthetic-queue';

function run(mode, d1Override, epochOverride) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mp248-snapshot-test-'));
  try {
    mkdirSync(path.join(dir, 'node_modules/.bin'), {recursive: true});
    mkdirSync(path.join(dir, 'bin'));
    mkdirSync(path.join(dir, 'scripts'));
    copyFileSync(path.join(root, 'scripts/pr247-stage-guard.mjs'), path.join(dir, 'scripts/pr247-stage-guard.mjs'));
    if (process.env.MP248_JQ_PATH) symlinkSync(process.env.MP248_JQ_PATH, path.join(dir, 'bin/jq'));
    const isA=mode.startsWith('A_'), post=mode.endsWith('_POST');
    const data = {
      migration: '0023_stable_recovery_admission.sql', recovery_tables: 4,
      review: isA?1:0, review_all: isA?1:0, held: 0, inflight: 0,
      epoch_total: isA?0:1, epoch_active: 0, epoch_complete: isA?0:1,
      unverified_ops: 0, verified_ops: isA?0:3, completed: 3296, open_failed: 32,
      stale_held:0, unleased_inflight:0,
      canary_jobs_completed:isA?0:1, canary_daily:isA?0:1, canary_raw:isA?0:1, canary_detail:isA?0:1
    };
    const epoch={epoch_found:1,epoch_state:'COMPLETE',unverified_ops:0,verified_ops:3,job_completed:1,daily:1,raw:1,detail:1};
    const ownerReceipt={schema:'MP248_G7_RECEIPT_V1',state:'OWNER_VERIFIED',epoch_id:'syntheticEpoch01',
      g5_sha:sha,g6a_worker_version:g5,expected_detail_count:1,g7_canary_verified:true,
      provider_readback_verified:true,no_duplicate_stable_ids:true,no_new_429_observed:true,
      gcp_quotas_checked:true,gcp_429_delta:0,owner_approved_g8:true};
    const fixture = {
      receipt: {release:'PR247', state:'VERIFIED_COMPLETED', expected_sha:sha,
        prior_worker_version:prior, queue_was_active:true, queue_id:queue},
      cron: {success:true,result:{schedules:[{cron:'*/5 * * * *'}]}},
      queues: {success:true,result:[{queue_name:'malipang-jobs',queue_id:queue,settings:{delivery_paused:false}}]},
      deploy: {success:true,result:{deployments:[{versions:[{version_id:post?g6:g5,percentage:100}]}]}},
      status: {ok:true,inFlightProjections:0,claim:isA?{state:'REVIEW',notice_stamp:'2026-11-05 21:26:00'}:null,
        recoveryGate:{mode:isA?(post?'UNARMED':'DISABLED'):(post?'DISABLED':'OPT_IN'),...(!isA&&!post?{state:'COMPLETE'}:{})},
        sheetPacing:{mode:isA?(post?'UNARMED':'DISABLED'):'OPT_IN'}},
      d1: d1Override === undefined ? [{results:[data],success:true,meta:{changed_db:false,rows_written:0}}] : d1Override(data),
      epoch:epochOverride===undefined?[{results:[epoch],success:true}]:epochOverride(epoch),
      owner:ownerReceipt
    };
    for (const [key, value] of Object.entries(fixture))
      writeFileSync(path.join(dir, key+'.json'), JSON.stringify(value));
    writeFileSync(path.join(dir, 'node_modules/.bin/wrangler'), `#!/bin/bash
set -euo pipefail
if [[ "$1" == r2 && "$2" == object && "$3" == get ]]; then
  fixture=receipt; [[ "$4" == */g7/* ]] && fixture=owner
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == --file=* ]]; then target="$(printf '%s' "$1" | cut -c8-)"; cp "$FIXTURE_DIR/$fixture.json" "$target"; exit 0; fi
    if [[ "$1" == --file ]]; then cp "$FIXTURE_DIR/$fixture.json" "$2"; exit 0; fi
    shift
  done
  exit 12
fi
if [[ "$1" == d1 && "$2" == execute ]]; then
  for arg in "$@"; do if [[ "$arg" == 'WITH target AS ('* ]]; then cat "$FIXTURE_DIR/epoch.json"; exit 0; fi; done
  cat "$FIXTURE_DIR/d1.json"; exit 0
fi
exit 13
`, {mode:0o755});
    writeFileSync(path.join(dir, 'bin/curl'), `#!/bin/bash
set -euo pipefail
for arg in "$@"; do
  case "$arg" in
    */schedules) cat "$FIXTURE_DIR/cron.json"; exit 0;;
    */queues) cat "$FIXTURE_DIR/queues.json"; exit 0;;
    */deployments) cat "$FIXTURE_DIR/deploy.json"; exit 0;;
    */admin/stable-sync/status) cat "$FIXTURE_DIR/status.json"; exit 0;;
  esac
done
exit 14
`, {mode:0o755});
    // macOS may not ship sha256sum; its synthetic fixture equivalent uses Node crypto.
    if (spawnSync('sha256sum',['--version'],{encoding:'utf8'}).status!==0)
      writeFileSync(path.join(dir,'bin/sha256sum'),`#!/usr/bin/env node\nconst fs=require('fs'),crypto=require('crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex')+'  '+process.argv[2]);\n`,{mode:0o755});
    const out = path.join(dir, 'snapshot.json');
    const result = spawnSync('bash', [path.join(root,'scripts/pr247-readonly-snapshot.sh'), mode, out], {
      cwd: dir, encoding:'utf8', timeout: 15000,
      env: {...process.env, PATH:path.join(dir,'bin')+':'+process.env.PATH, FIXTURE_DIR:dir,
        CLOUDFLARE_ACCOUNT_ID:'synthetic', CLOUDFLARE_API_TOKEN:'synthetic',
        MALIPANG_ADMIN_TOKEN:'synthetic', MALIPANG_WORKER_URL:'https://synthetic.invalid',
        G5_RUN_ID:'123', G5_RUN_ATTEMPT:'1', G5_SHA:sha,
        EXPECTED_WORKER_VERSION:post?g6:g5,
        PRIOR_WORKER_VERSION:g5, COMPLETED_BEFORE:'3296', OPEN_FAILED_BEFORE:'32',
        G7_RECEIPT_KEY:'release-control/pr247/g7/synthetic.json',
        G7_RECEIPT_SHA256:createHash('sha256').update(JSON.stringify(ownerReceipt)).digest('hex')}
    });
    return {status:result.status,stdout:result.stdout,stderr:result.stderr,
      snapshot:result.status===0?JSON.parse(readFileSync(out,'utf8')):null};
  } finally { rmSync(dir,{recursive:true,force:true}); }
}

for (const mode of ['A_PRE','A_POST','B_PRE','B_POST']) test(mode+' realistic Wrangler arrays reach actual guard',jqTestOptions,()=>{
  const result=run(mode);
  assert.equal(result.status,0, result.stderr);
  assert.match(result.stdout, new RegExp('STAGE_GUARD_'+mode+'_PASS'));
  assert.equal(result.snapshot.d1.migration, '0023_stable_recovery_admission.sql');
  assert.equal(result.snapshot.d1.review,mode.startsWith('A_')?1:0);
  assert.deepEqual(result.snapshot.epoch,mode.startsWith('A_')?null:{epoch_found:1,epoch_state:'COMPLETE',unverified_ops:0,verified_ops:3,job_completed:1,daily:1,raw:1,detail:1});
});
for (const [name,make] of [
  ['top-level object',d=>({success:true,results:[d]})],
  ['empty array',()=>[]],
  ['multiple statements',d=>[{success:true,results:[d]},{success:true,results:[d]}]],
  ['missing result list',()=>[{success:true}]],
  ['non-array results',d=>[{success:true,results:d}]],
  ['empty results',()=>[{success:true,results:[]}]],
  ['multiple result rows',d=>[{success:true,results:[d,d]}]],
  ['failed query',d=>[{success:false,results:[d]}]],
  ['null row',()=>[{success:true,results:[null]}]],
  ['wrong count type',d=>[{success:true,results:[{...d,completed:'3296'}]}]],
  ['held claim',d=>[{success:true,results:[{...d,held:1}]}]]
]) test('reject '+name+' without producing a PASS',jqTestOptions,()=>{
  const result=run('A_PRE',make);
  assert.notEqual(result.status,0, result.stdout);
  assert.doesNotMatch(result.stdout,/STAGE_GUARD_A_PRE_PASS/);
});
for(const [name,make] of [
  ['top-level object',e=>({success:true,results:[e]})],['empty array',()=>[]],
  ['multiple statements',e=>[{success:true,results:[e]},{success:true,results:[e]}]],
  ['no rows',()=>[{success:true,results:[]}]],['multiple rows',e=>[{success:true,results:[e,e]}]],
  ['failed',e=>[{success:false,results:[e]}]],['null row',()=>[{success:true,results:[null]}]]
]) test('reject malformed epoch '+name,jqTestOptions,()=>{
 const result=run('B_PRE',undefined,make);
 assert.notEqual(result.status,0,result.stdout);assert.doesNotMatch(result.stdout,/STAGE_GUARD_B_PRE_PASS/);
});
for(const [label,change] of [
 ['stale or invalid HELD',d=>({...d,held:1,stale_held:1})],
 ['unleased or invalid journal owner',d=>({...d,inflight:1,unleased_inflight:1})]
]) test('B_POST shell rejects '+label,jqTestOptions,()=>{
 const result=run('B_POST',d=>[{success:true,results:[change(d)]}]);
 assert.notEqual(result.status,0,result.stdout);assert.match(result.stderr,/NO_GO_STALE_WRITER_AFTER_GATE_EXIT/);
});
