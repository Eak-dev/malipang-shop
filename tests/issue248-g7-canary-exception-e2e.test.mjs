// End-to-end synthetic test of the Issue 248 hotfix-only G7 canary-digest exception:
// the real snapshot shell (final guard line stripped exactly as the release workflow
// does), real jq, real digest module, real zero-proof and the real stage/release
// guards. Wrangler/GitHub/Cloudflare are fakes; no provider is contacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,readFileSync,readdirSync,copyFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {verifyStage} from '../scripts/pr247-stage-guard.mjs';
import {verifyReleasePre,verifyReleasePost,ATTENDANCE_ACCEPT} from '../scripts/issue248-nonfinancial-release-guard.mjs';
import {canarySourceSql,RESULT_COLUMNS} from '../scripts/issue248-canary-source-digest.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const jqProbe=spawnSync(process.env.MP248_JQ_PATH||'jq',['--version'],{encoding:'utf8'});
const jqAvailable=jqProbe.status===0&&/^jq-/.test(jqProbe.stdout);
if(!jqAvailable&&(process.env.CI||process.env.MP248_JQ_PATH))throw new Error('A working jq is required on CI and when MP248_JQ_PATH is set');
const jq={skip:jqAvailable?false:'jq is not installed locally'};
const h=x=>createHash('sha256').update(x).digest('hex');
const PHRASE='OWNER ACCEPTS G7 SOURCE REVISION ADVANCED HISTORICAL INTEGRITY UNKNOWN';
const GUARD_LINE='node scripts/pr247-stage-guard.mjs "$mode" "$out"';
const sha='a'.repeat(40),g5='11111111-1111-4111-8111-111111111111',g6='22222222-2222-4222-8222-222222222222',prior='310192aa-8a04-4b61-8a72-4455231b3339',queue='synthetic-queue';
const nonce='c'.repeat(48),epochId='g7_'+nonce,source='b'.repeat(40),TARGET='exp_synthetic',TRACE='trace_synthetic';
// Sensitive-looking synthetic values: they must never reach stdout, stderr, the snapshot or the canary read output.
const PII=['U_SYNTHETIC_PRIVATE_LINE_ID','SYNTHETIC_PRIVATE_DESCRIPTION','emp_SYNTHETIC_PRIVATE','m_SYNTHETIC_PRIVATE_MESSAGE'];
const canaryRow={expense_id:TARGET,message_id:PII[3],line_user_id:PII[0],description:PII[1]+' ทิป',amount_satang:500,payment_key:'CASH',source_wallet:'SHOP_BANK',category:'synthetic',transaction_date:'2026-11-10',status:'CONFIRMED',trace_id:TRACE,created_at:'2026-11-10T00:00:00.000Z',version:1,submitted_by_employee_id:PII[2]};
const ok=results=>({success:true,meta:{changed_db:false,rows_written:0},results});
const revisionOf=db=>db.prepare('SELECT revision AS r FROM stable_source_revision WHERE singleton=1').get().r;
function migratedCanary(file){
 const db=new DatabaseSync(file);
 for(const name of readdirSync(path.join(root,'migrations')).filter(n=>n.endsWith('.sql')).sort())db.exec(readFileSync(path.join(root,'migrations',name),'utf8'));
 const cols=Object.keys(canaryRow);db.prepare(`INSERT INTO expense_events(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...Object.values(canaryRow));
 return db;
}
// Source state seen by the canary read: optional writes, then no-op updates (they still fire the
// revision trigger) up to the requested revision; the epoch fixture reads revision 86.
function sourceDb(file,{mutate=()=>{},revision=86}={}){
 const db=migratedCanary(file);try{mutate(db);const bump=db.prepare('UPDATE expense_events SET updated_at=updated_at WHERE expense_id=?');while(revisionOf(db)<revision)bump.run(TARGET);return revisionOf(db);}finally{db.close()}
}
// G7 digest = Worker formula on the stored row (tests/issue248-g7-canary-worker-parity.test.mjs pins the SQL to the compiled Worker).
const G7_DIGEST=(()=>{const db=migratedCanary(':memory:');try{return h(JSON.stringify({expense:db.prepare(`SELECT e.* FROM expense_events e WHERE expense_id='${TARGET}'`).get(),links:[],documents:[],items:[]}))}finally{db.close()}})();
const linkedDocument=db=>db.exec(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,expense_id) VALUES('doc_synthetic','m_doc_synthetic','U_doc_synthetic','RECEIPT','CONFIRMED','2026-11-10T00:00:00.000Z','${TARGET}')`);

function runSnapshot({mode='B_POST',stripped=true,exception=true,canaryRaw=null,db={},epochPatch={}}={}){
 const dir=mkdtempSync(path.join(os.tmpdir(),'mp248-canary-e2e-'));
 try{
  for(const d of ['node_modules/.bin','bin','scripts'])mkdirSync(path.join(dir,d),{recursive:true});
  for(const f of ['pr247-stage-guard.mjs','pr247-g7-zero-proof.mjs','issue248-canary-source-digest.mjs'])copyFileSync(path.join(root,'scripts',f),path.join(dir,'scripts',f));
  if(process.env.MP248_JQ_PATH)symlinkSync(process.env.MP248_JQ_PATH,path.join(dir,'bin/jq'));
  const post=mode==='B_POST';
  const d1={migration:'0023_stable_recovery_admission.sql',recovery_tables:4,review:0,review_all:0,held:0,inflight:0,epoch_total:1,epoch_active:0,epoch_complete:1,unverified_ops:0,verified_ops:2,completed:3296,open_failed:32,review_jobs:1,stale_held:0,unleased_inflight:0,canary_jobs_completed:1,canary_daily:1,canary_raw:1,canary_detail:0};
  const epoch={epoch_found:1,epoch_state:'COMPLETE',epoch_created_at:'2020-01-01T00:01:10.000Z',epoch_updated_at:'2020-01-01T00:01:50.000Z',unverified_ops:0,verified_ops:2,job_completed:1,daily:1,raw:1,detail:0,target_key:TARGET,target_trace:TRACE,target_version:1,source_matches:1,source_revision:86,cutover_active:1,pre_cutover_count:0,integrity_triggers:27,epoch_immutability_triggers:2,epoch_active_unique:1,source_item_count:0,source_document_count:0,source_link_count:0,journal_total:2,detail_any:0,...epochPatch};
  const intent={schema:'MP248_G7_ARM_INTENT_ZERO_LOCAL_V1',epoch:epochId,workbookHash:'b8df793b7aafbedea3b9eb42c3bf4d4a8098bef8b91a8a6d5ea6d50fc6e5602f',targetKeyHash:h(TARGET),traceHash:h(TRACE),sourceVersion:1,sourceSnapshotDigest:G7_DIGEST,sourceRevision:67,targetCreatedAt:'2020-01-01T00:01:00.000Z',selectionSince:'2020-01-01T00:00:00.000Z',itemCount:0,providerHash:'e'.repeat(64),issuedAt:'2020-01-01T00:02:00.000Z',legacyScan:'NO_EXACT_CANDIDATE_RESIDUAL_UNKNOWN',gcp429Coverage:'PARTIAL_UNKNOWN',gcp429Delta:null,ownerAccepted429ObservabilityRisk:true,auditMode:'R2_SINGLE_WRITER_NONCONDITIONAL_OWNER_RISK_ACCEPTED'};
  const intentRaw=JSON.stringify(intent),outcomeRaw=JSON.stringify({schema:'MP248_G7_ARM_OUTCOME_LOCAL_V1',epoch:epochId,intentHash:h(intentRaw),status:'ARM_ACKNOWLEDGED',classification:'PRESENT_MATCHING'});
  const receipt={schema:'MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED',state:'OWNER_VERIFIED',epoch_id:epochId,g5_sha:sha,g6a_worker_version:g5,expected_detail_count:0,detail_coverage:'NOT_EXERCISED_ZERO_ITEMS',owner_accepted_detail_coverage_risk:true,no_detail_rows_verified:true,g7_canary_verified:true,provider_readback_verified:true,no_duplicate_stable_ids:true,owner_approved_g8:true,source_snapshot_digest:G7_DIGEST,source_revision:67,
   monitoring_coverage:'PARTIAL_PROJECT_UNBOUND',monitoring_project:'malipang-backend',gcp_quotas_checked:false,gcp_429_delta:null,gcp_ingestion_lag_ms:null,owner_accepted_429_observability_risk:true,limited_observed_429:false,observation_source:'GCP_UI_UNBOUND_AND_WORKER_LOGS_PARTIAL',monitoring_window_start:'2020-01-01T00:00:00.000Z',canary_started_at:'2020-01-01T00:01:00.000Z',canary_completed_at:'2020-01-01T00:02:00.000Z',monitoring_window_end:'2020-01-01T00:03:00.000Z',observed_at:'2020-01-01T00:05:00.000Z',
   arm_audit_nonce:nonce,arm_intent_sha256:h(intentRaw),arm_outcome_sha256:h(outcomeRaw),arm_intent_run_id:'123',arm_outcome_run_id:'456',arm_workflow_source_sha:source};
  const files={receipt:{release:'PR247',state:'VERIFIED_COMPLETED',expected_sha:sha,prior_worker_version:prior,queue_was_active:true,queue_id:queue},
   cron:{success:true,result:{schedules:[{cron:'*/5 * * * *'}]}},queues:{success:true,result:[{queue_name:'malipang-jobs',queue_id:queue,settings:{delivery_paused:false}}]},
   deploy:{success:true,result:{deployments:[{versions:[{version_id:post?g6:g5,percentage:100}]}]}},
   status:{ok:true,inFlightProjections:0,claim:null,recoveryGate:post?{mode:'DISABLED'}:{mode:'OPT_IN',state:'COMPLETE'},sheetPacing:{mode:'OPT_IN'}},
   d1:[{results:[d1],success:true,meta:{changed_db:false,rows_written:0}}],epoch:[{success:true,results:[epoch]}],owner:receipt};
  for(const [k,v] of Object.entries(files))writeFileSync(path.join(dir,k+'.json'),JSON.stringify(v));
  writeFileSync(path.join(dir,'g7-intent.json'),intentRaw);writeFileSync(path.join(dir,'g7-outcome.json'),outcomeRaw);
  const sourceRevision=sourceDb(path.join(dir,'source.db'),db);if(!db.revision)assert.equal(sourceRevision,86);
  writeFileSync(path.join(dir,'d1.mjs'),"import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[2],{readOnly:true});process.stdout.write(JSON.stringify([{results:db.prepare(process.argv[3]).all(),success:true,meta:{changed_db:false,rows_written:0}}]));\n");
  if(canaryRaw!==null)writeFileSync(path.join(dir,'canary-raw.txt'),typeof canaryRaw==='string'?canaryRaw:JSON.stringify(canaryRaw));
  for(const [id,phase,dig] of [['123','intent',h(intentRaw)],['456','outcome',h(outcomeRaw)]]){const job=Number(id)+1;
   writeFileSync(path.join(dir,'run'+id+'.json'),JSON.stringify({id:Number(id),run_attempt:1,status:'completed',conclusion:'success',head_sha:source,head_branch:'main',event:'workflow_dispatch',path:'.github/workflows/issue248-g7-audit-writer.yml'}));
   writeFileSync(path.join(dir,'jobs'+id+'.json'),JSON.stringify({total_count:1,jobs:[{id:job,run_id:Number(id),name:'audit-write',status:'completed',conclusion:'success',steps:[{name:'Pin reviewed source',status:'completed',conclusion:'success',number:5},{name:'Write one scoped audit object and verify',status:'completed',conclusion:'success',number:6}]}]}));
   writeFileSync(path.join(dir,'log'+job+'.txt'),`MP248_G7_AUDIT_SHA256=${dig}\nMP248_G7_AUDIT_KEY=release-control/pr247/g7/arm-audit/${nonce}-${phase}.json\n`);}
  copyFileSync(path.join(root,'scripts/issue248-g7-audit.mjs'),path.join(dir,'g7-reviewed-writer.mjs'));copyFileSync(path.join(root,'.github/workflows/issue248-g7-audit-writer.yml'),path.join(dir,'g7-reviewed-workflow.yml'));
  writeFileSync(path.join(dir,'bin/git'),`#!/bin/bash\nset -euo pipefail\nif [[ "$1" == merge-base ]]; then exit 0; fi\nif [[ "$1" == show && "$2" == *:scripts/issue248-g7-audit.mjs ]]; then cat "$FIXTURE_DIR/g7-reviewed-writer.mjs"; exit 0; fi\nif [[ "$1" == show && "$2" == *:.github/workflows/issue248-g7-audit-writer.yml ]]; then cat "$FIXTURE_DIR/g7-reviewed-workflow.yml"; exit 0; fi\nexit 2\n`,{mode:0o755});
  writeFileSync(path.join(dir,'bin/gh'),`#!/bin/bash\nset -euo pipefail\nif [[ "$4" == "--allow-escape-sequences" ]]; then [[ "$5" == */logs ]] || exit 3; shift; elif [[ "$4" == */logs ]]; then exit 4; fi\ncase "$4" in\n */runs/123/attempts/1) cat "$FIXTURE_DIR/run123.json";;\n */runs/456/attempts/1) cat "$FIXTURE_DIR/run456.json";;\n */runs/123/attempts/1/jobs*) cat "$FIXTURE_DIR/jobs123.json";;\n */runs/456/attempts/1/jobs*) cat "$FIXTURE_DIR/jobs456.json";;\n */jobs/124/steps/6/logs) cat "$FIXTURE_DIR/log124.txt";;\n */jobs/457/steps/6/logs) cat "$FIXTURE_DIR/log457.txt";;\n *) exit 2;; esac\n`,{mode:0o755});
  writeFileSync(path.join(dir,'node_modules/.bin/wrangler'),`#!/bin/bash
set -euo pipefail
if [[ "$1" == r2 && "$2" == object && "$3" == get ]]; then
  fixture=receipt; [[ "$4" == */g7/* ]] && fixture=owner; [[ "$4" == */arm-audit/*-intent.json ]] && fixture=g7-intent; [[ "$4" == */arm-audit/*-outcome.json ]] && fixture=g7-outcome
  for a in "$@"; do if [[ "$a" == --file=* ]]; then cp "$FIXTURE_DIR/$fixture.json" "\${a#--file=}"; exit 0; fi; done
  exit 12
fi
if [[ "$1" == d1 && "$2" == execute ]]; then
  for a in "$@"; do
    if [[ "$a" == 'WITH target AS ('* ]]; then cat "$FIXTURE_DIR/epoch.json"; exit 0; fi
    if [[ "$a" == 'WITH RECURSIVE src AS ('* ]]; then printf '%s\\n' "$a" >> "$FIXTURE_DIR/canary-commands.log"
      if [[ -f "$FIXTURE_DIR/canary-raw.txt" ]]; then if [[ "$(cat "$FIXTURE_DIR/canary-raw.txt")" == WRANGLER_FAIL ]]; then printf 'synthetic provider error for %s\\n' "$a" >&2; exit 7; fi; cat "$FIXTURE_DIR/canary-raw.txt"; exit 0; fi
      node "$FIXTURE_DIR/d1.mjs" "$FIXTURE_DIR/source.db" "$a" 2>/dev/null | tee -a "$FIXTURE_DIR/canary-output.log"; exit 0; fi
    if [[ "$a" == *"FROM sync_jobs WHERE status='REVIEW') review_jobs"* ]]; then cat "$FIXTURE_DIR/d1.json"; exit 0; fi
  done
  exit 21
fi
exit 13
`,{mode:0o755});
  writeFileSync(path.join(dir,'bin/curl'),`#!/bin/bash\nset -euo pipefail\nfor a in "$@"; do case "$a" in */schedules) cat "$FIXTURE_DIR/cron.json"; exit 0;; */queues) cat "$FIXTURE_DIR/queues.json"; exit 0;; */deployments) cat "$FIXTURE_DIR/deploy.json"; exit 0;; */admin/stable-sync/status) cat "$FIXTURE_DIR/status.json"; exit 0;; esac; done\nexit 14\n`,{mode:0o755});
  if(spawnSync('sha256sum',['--version'],{encoding:'utf8'}).status!==0)writeFileSync(path.join(dir,'bin/sha256sum'),`#!/usr/bin/env node\nconst fs=require('fs'),crypto=require('crypto');console.log(crypto.createHash('sha256').update(fs.readFileSync(process.argv[2])).digest('hex')+'  '+process.argv[2]);\n`,{mode:0o755});
  // Same transformation as the release workflow: drop only the final strict guard line.
  const original=readFileSync(path.join(root,'scripts/pr247-readonly-snapshot.sh'),'utf8');
  assert.equal(original.split('\n').filter(l=>l===GUARD_LINE).length,1);
  const script=path.join(dir,'release-snapshot.sh');writeFileSync(script,stripped?original.split('\n').filter(l=>l!==GUARD_LINE).join('\n'):original);
  const out=path.join(dir,'snapshot.json');
  const env={...process.env,PATH:path.join(dir,'bin')+':'+process.env.PATH,FIXTURE_DIR:dir,CLOUDFLARE_ACCOUNT_ID:'synthetic',CLOUDFLARE_API_TOKEN:'synthetic',MALIPANG_ADMIN_TOKEN:'synthetic',MALIPANG_WORKER_URL:'https://synthetic.invalid',
   G5_RUN_ID:'123',G5_RUN_ATTEMPT:'1',G5_SHA:sha,EXPECTED_WORKER_VERSION:post?g6:g5,PRIOR_WORKER_VERSION:g5,COMPLETED_BEFORE:'3296',OPEN_FAILED_BEFORE:'32',
   G7_RECEIPT_KEY:'release-control/pr247/g7/synthetic.json',G7_RECEIPT_SHA256:h(JSON.stringify(receipt))};
  delete env.MP248_G7_CANARY_DIGEST_EXCEPTION;if(exception)env.MP248_G7_CANARY_DIGEST_EXCEPTION=PHRASE;
  const r=spawnSync('bash',[script,mode,out],{cwd:dir,encoding:'utf8',timeout:20000,env});
  const raw=r.status===0&&existsSync(out)?readFileSync(out,'utf8'):null;
  const commands=existsSync(path.join(dir,'canary-commands.log'))?readFileSync(path.join(dir,'canary-commands.log'),'utf8').trim().split('\n'):[];
  const canaryOutput=existsSync(path.join(dir,'canary-output.log'))?readFileSync(path.join(dir,'canary-output.log'),'utf8'):'';
  return {status:r.status,stdout:r.stdout,stderr:r.stderr,raw,snapshot:raw?JSON.parse(raw):null,commands,canaryOutput};
 }finally{rmSync(dir,{recursive:true,force:true})}
}
const noPii=(r,label)=>{for(const p of PII){for(const s of [r.stdout,r.stderr,r.raw??'',r.canaryOutput??''])assert.ok(!s.includes(p),label+': private value leaked')}};
// Release-guard evidence as the provider-side statements return it: counts only (scripts/issue248-nonfinancial-release-guard.mjs).
const review=[{success:true,meta:{changed_db:false,rows_written:0},results:[{review_total:1,candidates:1,known_job_rows:1,known_exact:1}]}];
const writers=[{success:true,meta:{changed_db:false,rows_written:0},results:[{claims:0,inflight:0,active_or_unbounded_leases:0,staff_processing:0,expired_processing:0,expired_known:0,expired_known_state:0}]}];

test('exception path: one provider-side read -> digest -> zero-proof -> release guard pre/post pass; evidence preserved; no PII',jq,()=>{
 const r=runSnapshot();assert.equal(r.status,0,r.stderr);noPii(r,'happy');
 assert.deepEqual(r.commands,[canarySourceSql(TARGET,1)]);
 const read=JSON.parse(r.canaryOutput);assert.equal(read.length,1);assert.deepEqual(Object.keys(read[0].results[0]),RESULT_COLUMNS); // only revision, counts and digests left the statement
 const s=r.snapshot;
 assert.equal(s.epoch.source_current_digest,G7_DIGEST);assert.equal(s.epoch.source_bracket_revision,86);assert.equal(s.epoch.source_revision,86);
 assert.deepEqual([s.epoch.source_current_items,s.epoch.source_current_documents,s.epoch.source_current_links],[0,0,0]);
 assert.equal(s.receipt.source_revision,67);assert.equal(s.receipt.source_snapshot_digest,G7_DIGEST); // historical evidence untouched
 assert.equal(s.epoch.target_key,undefined);assert.equal(s.epoch.target_trace,undefined);
 assert.equal(verifyReleasePost({snapshot:s,review,attendanceException:ATTENDANCE_ACCEPT}).ok,true);
 assert.equal(verifyReleasePre({snapshot:s,writers,review,attendanceException:ATTENDANCE_ACCEPT,expiredException:'NONE'}).ok,true);
 const masked=structuredClone(s);masked.d1.review_jobs=0;
 assert.deepEqual(verifyStage('B_POST',masked,{canaryDigestException:true}),{ok:true,mode:'B_POST'});
 assert.throws(()=>verifyStage('B_POST',masked),/NO_GO_CANARY_JOURNAL/); // strict default still rejects 86 vs 67
});
test('strict default: without the exception, or outside B_POST, zero-proof rejects the advanced revision and no canary read happens',jq,()=>{
 for(const [label,opts] of [['no exception',{exception:false}],['unstripped default script',{exception:false,stripped:false}],['B_PRE with exception env',{mode:'B_PRE'}]]){
  const r=runSnapshot(opts);assert.notEqual(r.status,0,label);assert.match(r.stderr,/NO_GO_G7_ZERO_D1_BINDING/,label);assert.deepEqual(r.commands,[],label);noPii(r,label);
 }
});
test('race: any source write after the epoch query (row edit, document insert, no-op update) moves the revision and blocks',jq,()=>{
 for(const [label,db] of [['revision only',{revision:87}],['canary edit',{mutate:x=>x.exec(`UPDATE expense_events SET amount_satang=501 WHERE expense_id='${TARGET}'`),revision:87}],['document insert',{mutate:linkedDocument,revision:87}]]){
  const r=runSnapshot({db});assert.notEqual(r.status,0,label);assert.match(r.stderr,/NO_GO_CANARY_SOURCE_REVISION_MOVED/,label);assert.match(r.stderr,/NO_GO_G7_CANARY_SOURCE/,label);noPii(r,label);
 }
});
test('at the epoch revision a linked document, a cancelled canary or a canary edit blocks',jq,()=>{
 const doc=runSnapshot({db:{mutate:linkedDocument}});assert.notEqual(doc.status,0);assert.match(doc.stderr,/NO_GO_CANARY_SOURCE_SHAPE/);noPii(doc,'document');
 const cancelled=runSnapshot({db:{mutate:x=>x.exec(`UPDATE expense_events SET status='CANCELLED' WHERE expense_id='${TARGET}'`)}});assert.notEqual(cancelled.status,0);assert.match(cancelled.stderr,/NO_GO_CANARY_SOURCE_ROW_COUNT/);noPii(cancelled,'cancelled');
 const edited=runSnapshot({db:{mutate:x=>x.exec(`UPDATE expense_events SET amount_satang=501 WHERE expense_id='${TARGET}'`)}});assert.notEqual(edited.status,0);assert.match(edited.stderr,/NO_GO_G7_ZERO_D1_BINDING/);noPii(edited,'edited');
});
test('provider format mismatches and unsafe targets fail closed before PASS',jq,()=>{
 const good=runSnapshot();assert.equal(good.status,0,good.stderr);const row=JSON.parse(good.canaryOutput)[0].results[0];
 const cases=[['legacy six envelopes',[ok([{rev:86}]),ok([]),ok([]),ok([]),ok([]),ok([{rev:86}])],'EVIDENCE'],['write-shaped',[{...ok([row]),meta:{changed_db:true,rows_written:1}}],'EVIDENCE'],['non-JSON','not json','UNKNOWN'],
  ['extra private column',[ok([{...row,line_user_id:PII[0]}])],'EVIDENCE'],['self-test differs',[ok([{...row,selftest:'0'.repeat(64)}])],'PROVIDER_SELFTEST'],['missing digest',[ok([{...row,digest:null}])],'DIGEST']];
 for(const [label,canaryRaw,code] of cases){const r=runSnapshot({canaryRaw});assert.notEqual(r.status,0,label);assert.match(r.stderr,new RegExp('NO_GO_CANARY_SOURCE_'+code),label);assert.match(r.stderr,/NO_GO_G7_CANARY_SOURCE/,label);assert.ok(!r.stderr.includes(PII[0])&&!r.stdout.includes(PII[0]),label);}
 const bad=runSnapshot({epochPatch:{target_key:"exp_x' OR 1=1"}});assert.notEqual(bad.status,0);assert.match(bad.stderr,/NO_GO_G7_CANARY_TARGET/);assert.deepEqual(bad.commands,[]);
});
test('canary read failure is UNKNOWN and never echoes the query or target key',jq,()=>{
 const r=runSnapshot({canaryRaw:'WRANGLER_FAIL'});assert.notEqual(r.status,0);assert.match(r.stderr,/NO_GO_G7_CANARY_SOURCE_READ/);
 assert.equal(r.commands.length,1);assert.ok(!r.stderr.includes(TARGET)&&!r.stdout.includes(TARGET),'target key leaked');noPii(r,'read failure');
});
