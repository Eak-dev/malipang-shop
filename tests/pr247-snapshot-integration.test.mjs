import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, copyFileSync, appendFileSync } from 'node:fs';
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

function run(mode, d1Override, epochOverride, receiptOverride, zeroFault) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'mp248-snapshot-test-'));
  try {
    mkdirSync(path.join(dir, 'node_modules/.bin'), {recursive: true});
    mkdirSync(path.join(dir, 'bin'));
    mkdirSync(path.join(dir, 'scripts'));
    copyFileSync(path.join(root, 'scripts/pr247-stage-guard.mjs'), path.join(dir, 'scripts/pr247-stage-guard.mjs'));
    copyFileSync(path.join(root, 'scripts/pr247-g7-zero-proof.mjs'), path.join(dir, 'scripts/pr247-g7-zero-proof.mjs'));
    if (process.env.MP248_JQ_PATH) symlinkSync(process.env.MP248_JQ_PATH, path.join(dir, 'bin/jq'));
    const isA=mode.startsWith('A_'), post=mode.endsWith('_POST');
    const data = {
      migration: '0023_stable_recovery_admission.sql', recovery_tables: 4,
      review: isA?1:0, review_all: isA?1:0, held: 0, inflight: 0,
      epoch_total: isA?0:1, epoch_active: 0, epoch_complete: isA?0:1,
      unverified_ops: 0, verified_ops: isA?0:3, completed: 3296, open_failed: 32, review_jobs: 0,
      stale_held:0, unleased_inflight:0,
      canary_jobs_completed:isA?0:1, canary_daily:isA?0:1, canary_raw:isA?0:1, canary_detail:isA?0:1
    };
    const epoch={epoch_found:1,epoch_state:'COMPLETE',epoch_created_at:'2020-01-01T00:01:10.000Z',epoch_updated_at:'2020-01-01T00:01:50.000Z',unverified_ops:0,verified_ops:3,job_completed:1,daily:1,raw:1,detail:1};
    let ownerReceipt={schema:'MP248_G7_RECEIPT_V1',state:'OWNER_VERIFIED',epoch_id:'syntheticEpoch01',
      g5_sha:sha,g6a_worker_version:g5,expected_detail_count:1,g7_canary_verified:true,
      provider_readback_verified:true,no_duplicate_stable_ids:true,no_new_429_observed:true,
      gcp_quotas_checked:true,gcp_429_delta:0,owner_approved_g8:true};
    if(receiptOverride)ownerReceipt=receiptOverride(ownerReceipt);
    if(ownerReceipt.schema==='MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED'){
      const nonce='c'.repeat(48),epochId='g7_'+nonce,source='b'.repeat(40),target='exp_synthetic',trace='trace_synthetic';
      const hash=x=>createHash('sha256').update(x).digest('hex');ownerReceipt.epoch_id=epochId;
      const intent={schema:'MP248_G7_ARM_INTENT_ZERO_LOCAL_V1',epoch:epochId,workbookHash:'b8df793b7aafbedea3b9eb42c3bf4d4a8098bef8b91a8a6d5ea6d50fc6e5602f',targetKeyHash:hash(target),traceHash:hash(trace),sourceVersion:1,sourceSnapshotDigest:ownerReceipt.source_snapshot_digest,sourceRevision:ownerReceipt.source_revision,targetCreatedAt:'2020-01-01T00:01:00.000Z',selectionSince:'2020-01-01T00:00:00.000Z',itemCount:0,providerHash:'e'.repeat(64),issuedAt:'2020-01-01T00:02:00.000Z',legacyScan:'NO_EXACT_CANDIDATE_RESIDUAL_UNKNOWN',gcp429Coverage:'PARTIAL_UNKNOWN',gcp429Delta:null,ownerAccepted429ObservabilityRisk:true,auditMode:'R2_SINGLE_WRITER_NONCONDITIONAL_OWNER_RISK_ACCEPTED'},intentRaw=JSON.stringify(intent),outcomeRaw=JSON.stringify({schema:'MP248_G7_ARM_OUTCOME_LOCAL_V1',epoch:epochId,intentHash:hash(intentRaw),status:'ARM_ACKNOWLEDGED',classification:'PRESENT_MATCHING'});
      Object.assign(ownerReceipt,{arm_audit_nonce:nonce,arm_intent_sha256:hash(intentRaw),arm_outcome_sha256:hash(outcomeRaw),arm_intent_run_id:'123',arm_outcome_run_id:'456',arm_workflow_source_sha:source});
      writeFileSync(path.join(dir,'g7-intent.json'),intentRaw);writeFileSync(path.join(dir,'g7-outcome.json'),outcomeRaw);
      const setupRun=(id,phase,dig)=>{const job=Number(id)+1,run={id:Number(id),run_attempt:1,status:'completed',conclusion:'success',head_sha:source,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/issue248-g7-audit-writer.yml'},jobs={total_count:1,jobs:[{id:job,run_id:Number(id),name:'audit-write',status:'completed',conclusion:'success',steps:[{name:'Register workflow without provider access',status:'completed',conclusion:'skipped',number:2},{name:'Pin reviewed source',status:'completed',conclusion:'success',number:5},{name:'Write one scoped audit object and verify',status:'completed',conclusion:'success',number:6}]}]};writeFileSync(path.join(dir,'run'+id+'.json'),JSON.stringify(run));writeFileSync(path.join(dir,'jobs'+id+'.json'),JSON.stringify(jobs));writeFileSync(path.join(dir,'log'+job+'.txt'),`MP248_G7_AUDIT_SHA256=${dig}\nMP248_G7_AUDIT_KEY=release-control/pr247/g7/arm-audit/${nonce}-${phase}.json\n`);};setupRun('123','intent',hash(intentRaw));setupRun('456','outcome',hash(outcomeRaw));if(zeroFault==='bad-marker')writeFileSync(path.join(dir,'log124.txt'),'MP248_G7_AUDIT_SHA256='+('0'.repeat(64))+'\nMP248_G7_AUDIT_KEY=release-control/pr247/g7/arm-audit/'+nonce+'-intent.json\n');
      copyFileSync(process.env.MP248_G7_ZERO_REVIEWED_SCRIPT||path.join(root,'scripts/issue248-g7-audit.mjs'),path.join(dir,'g7-reviewed-writer.mjs'));copyFileSync(path.join(root,'.github/workflows/issue248-g7-audit-writer.yml'),path.join(dir,'g7-reviewed-workflow.yml'));if(zeroFault==='log-error')writeFileSync(path.join(dir,'force-log-fail'),'1');if(zeroFault==='source-drift')appendFileSync(path.join(dir,'g7-reviewed-writer.mjs'),'\n// changed');if(zeroFault==='gh-run'){const p=path.join(dir,'run123.json'),v=JSON.parse(readFileSync(p));v.head_sha='0'.repeat(40);writeFileSync(p,JSON.stringify(v));}
      writeFileSync(path.join(dir,'bin/git'),`#!/bin/bash\nset -euo pipefail\nif [[ "$1" == merge-base ]]; then exit 0; fi\nif [[ "$1" == show && "$2" == *:scripts/issue248-g7-audit.mjs ]]; then cat "$FIXTURE_DIR/g7-reviewed-writer.mjs"; exit 0; fi\nif [[ "$1" == show && "$2" == *:.github/workflows/issue248-g7-audit-writer.yml ]]; then cat "$FIXTURE_DIR/g7-reviewed-workflow.yml"; exit 0; fi\nexit 2\n`,{mode:0o755});
      writeFileSync(path.join(dir,'bin/gh'),`#!/bin/bash\nset -euo pipefail\nif [[ "$4" == "--allow-escape-sequences" ]]; then [[ "$5" == */logs ]] || exit 3; shift; elif [[ "$4" == */logs ]]; then exit 4; fi\nif [[ "$4" == */logs && -f "$FIXTURE_DIR/force-log-fail" ]]; then printf "private sensitive fixture" >&2; exit 4; fi\ncase "$4" in\n */runs/123/attempts/1) cat "$FIXTURE_DIR/run123.json";;\n */runs/456/attempts/1) cat "$FIXTURE_DIR/run456.json";;\n */runs/123/attempts/1/jobs*) cat "$FIXTURE_DIR/jobs123.json";;\n */runs/456/attempts/1/jobs*) cat "$FIXTURE_DIR/jobs456.json";;\n */jobs/124/steps/6/logs) cat "$FIXTURE_DIR/log124.txt";;\n */jobs/457/steps/6/logs) cat "$FIXTURE_DIR/log457.txt";;\n *) exit 2;; esac\n`,{mode:0o755});
    }
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
  fixture=receipt; [[ "$4" == */g7/* ]] && fixture=owner; [[ "$4" == */arm-audit/*-intent.json ]] && fixture=g7-intent; [[ "$4" == */arm-audit/*-outcome.json ]] && fixture=g7-outcome
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == --file=* ]]; then target="$(printf '%s' "$1" | cut -c8-)"; cp "$FIXTURE_DIR/$fixture.json" "$target"; exit 0; fi
    if [[ "$1" == --file ]]; then cp "$FIXTURE_DIR/$fixture.json" "$2"; exit 0; fi
    shift
  done
  exit 12
fi
if [[ "$1" == d1 && "$2" == execute ]]; then
  found=false
  for arg in "$@"; do
    if [[ "$arg" == 'WITH target AS ('* ]]; then cat "$FIXTURE_DIR/epoch.json"; exit 0; fi
    [[ "$arg" == *"FROM sync_jobs WHERE status='REVIEW') review_jobs"* ]] && found=true
  done
  [[ "$found" == true ]] || exit 21
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
  assert.deepEqual(result.snapshot.epoch,mode.startsWith('A_')?null:{epoch_found:1,epoch_state:'COMPLETE',epoch_created_at:'2020-01-01T00:01:10.000Z',epoch_updated_at:'2020-01-01T00:01:50.000Z',unverified_ops:0,verified_ops:3,job_completed:1,daily:1,raw:1,detail:1});
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

const acceptedRisk = r => {const x={...r,schema:'MP248_G7_RECEIPT_V2_RISK_ACCEPTED',monitoring_coverage:'PARTIAL_PROJECT_UNBOUND',monitoring_project:'malipang-backend',gcp_quotas_checked:false,gcp_429_delta:null,gcp_ingestion_lag_ms:null,owner_accepted_429_observability_risk:true,limited_observed_429:false,observation_source:'GCP_UI_UNBOUND_AND_WORKER_LOGS_PARTIAL',monitoring_window_start:'2020-01-01T00:00:00.000Z',canary_started_at:'2020-01-01T00:01:00.000Z',canary_completed_at:'2020-01-01T00:02:00.000Z',monitoring_window_end:'2020-01-01T00:03:00.000Z',observed_at:'2020-01-01T00:05:00.000Z'};delete x.no_new_429_observed;return x};
test('B_PRE real snapshot shell emits explicit partial-monitoring marker',jqTestOptions,()=>{const r=run('B_PRE',undefined,undefined,acceptedRisk);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/MONITORING_PARTIAL_OWNER_RISK_ACCEPTED_NOT_429_ZERO/);assert.equal(r.snapshot.receipt.gcp_429_delta,null)});
test('B_PRE risk exception rejects epoch outside receipt canary window',jqTestOptions,()=>{const r=run('B_PRE',undefined,e=>[{success:true,results:[{...e,epoch_updated_at:'2020-01-01T00:02:30.000Z'}]}],acceptedRisk);assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout,/STAGE_GUARD_B_PRE_PASS/)});

for (const mode of ['B_PRE','B_POST']) for(const [name,change] of [['review job',d=>({...d,review_jobs:1})],['missing review count',d=>{const v={...d};delete v.review_jobs;return v;}]]) test(mode+' snapshot rejects '+name,jqTestOptions,()=>{const r=run(mode,d=>[{success:true,results:[change(d)]}]);assert.notEqual(r.status,0,r.stdout);assert.match(r.stderr,/NO_GO_SYNC_JOBS_REVIEW/);});
const zeroRisk=r=>({...acceptedRisk(r),schema:'MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED',expected_detail_count:0,detail_coverage:'NOT_EXERCISED_ZERO_ITEMS',owner_accepted_detail_coverage_risk:true,no_detail_rows_verified:true,source_snapshot_digest:'a'.repeat(64),source_revision:42});
const zeroEpoch=e=>[{success:true,results:[{...e,target_key:'exp_synthetic',target_trace:'trace_synthetic',target_version:1,verified_ops:2,detail:0,source_matches:1,source_revision:42,cutover_active:1,pre_cutover_count:0,integrity_triggers:27,epoch_immutability_triggers:2,epoch_active_unique:1,source_item_count:0,source_document_count:0,source_link_count:0,journal_total:2,detail_any:0}]}];
for(const mode of ['B_PRE','B_POST'])test(mode+' shell permits explicit zero-item risk and labels DETAIL unexercised',jqTestOptions,()=>{const r=run(mode,undefined,zeroEpoch,zeroRisk);assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/ZERO_ITEM_OWNER_RISK_ACCEPTED_DETAIL_NOT_EXERCISED/);assert.match(r.stdout,/MONITORING_PARTIAL_OWNER_RISK_ACCEPTED_NOT_429_ZERO/);assert.equal(r.snapshot.epoch.target_key,undefined);assert.equal(r.snapshot.epoch.target_trace,undefined);});
test('zero-item snapshot rejects digest injection before D1 epoch query',jqTestOptions,()=>{const r=run('B_PRE',undefined,zeroEpoch,x=>({...zeroRisk(x),source_snapshot_digest:"'; DROP TABLE sync_jobs;--"}));assert.notEqual(r.status,0);assert.doesNotMatch(r.stdout,/STAGE_GUARD_B_PRE_PASS/);});

test('zero-item snapshot rejects G7 intent target hash mismatch before PASS',jqTestOptions,()=>{const wrong=e=>{const x=zeroEpoch(e);x[0].results[0].target_key='exp_other';return x;};const r=run('B_PRE',undefined,wrong,zeroRisk);assert.notEqual(r.status,0);assert.match(r.stderr,/NO_GO_G7_ZERO_D1_BINDING/);assert.doesNotMatch(r.stdout,/STAGE_GUARD_B_PRE_PASS/)});

test('zero-item snapshot rejects G7 writer source drift',jqTestOptions,()=>{const r=run('B_PRE',undefined,zeroEpoch,zeroRisk,'source-drift');assert.notEqual(r.status,0);assert.match(r.stderr,/NO_GO_G7_ZERO_SOURCE_PIN/);});
test('zero-item snapshot rejects unrelated GitHub run',jqTestOptions,()=>{const r=run('B_PRE',undefined,zeroEpoch,zeroRisk,'gh-run');assert.notEqual(r.status,0);assert.match(r.stderr,/NO_GO_G7_ZERO_GH_RUN/);});

test('zero-item audit log read failure stops safely without echoing private stderr',jqTestOptions,()=>{const r=run('B_PRE',undefined,zeroEpoch,zeroRisk,'log-error');assert.notEqual(r.status,0);assert.match(r.stderr,/NO_GO_G7_ZERO_GH_LOG_READ_UNKNOWN/);assert.doesNotMatch(r.stderr,/private sensitive fixture/);assert.doesNotMatch(r.stdout,/STAGE_GUARD_B_PRE_PASS/)});

test('zero-item audit log with wrong marker is rejected',jqTestOptions,()=>{const r=run('B_PRE',undefined,zeroEpoch,zeroRisk,'bad-marker');assert.notEqual(r.status,0);assert.match(r.stderr,/NO_GO_G7_ZERO_GH_MARKER/);assert.doesNotMatch(r.stdout,/STAGE_GUARD_B_PRE_PASS/)});
