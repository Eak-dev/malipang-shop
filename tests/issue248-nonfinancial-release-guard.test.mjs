import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {G5_PREVIOUS_WORKER,MIGRATION} from '../scripts/pr247-stage-guard.mjs';
import {verifyKnownAttendanceReview,maskKnownReview,verifyReleasePre,verifyReleasePost,reviewSql,writersSql,ATTENDANCE_ACCEPT,REVIEW_COLUMNS,WRITER_COLUMNS} from '../scripts/issue248-nonfinancial-release-guard.mjs';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';

// Real identifiers are never read. Synthetic jobs with their own pins run through
// the same provider-side statements the workflow sends to D1, here on SQLite.
const h=x=>createHash('sha256').update(x,'utf8').digest('hex');
const IDS={entity_key:'synthetic_attendance_event',job_id:'synthetic_job',trace_id:'synthetic_trace',lease_token:'synthetic_lease'};
const PINS={key:h(IDS.entity_key),jobId:h(IDS.job_id),trace:h(IDS.trace_id),lease:h(IDS.lease_token),leaseUntil:'2026-11-10T21:58:50.188Z',updatedAt:'2026-11-10T23:04:40.739Z'};
// Sensitive-looking markers in every job field that could leave D1; none may reach any output.
const PII=['EMP_SYNTHETIC_PRIVATE','TRACE_SYNTHETIC_PRIVATE','LEASE_SYNTHETIC_PRIVATE','ERROR_SYNTHETIC_PRIVATE',...Object.values(IDS)];
const job=(o={})=>({job_id:IDS.job_id,entity_type:'ATTENDANCE_EVENT',entity_key:IDS.entity_key,entity_version:1,trace_id:IDS.trace_id,status:'REVIEW',attempt_count:1,last_error:'MP248_ATTENDANCE_OUTCOME_UNKNOWN',updated_at:PINS.updatedAt,lease_until:PINS.leaseUntil,lease_token:IDS.lease_token,...o});
const payroll=(o={})=>({job_id:'job_payroll_synthetic',entity_type:'DAILY_PAYROLL',entity_key:'EMP_SYNTHETIC_PRIVATE|2026-11-10',entity_version:1,trace_id:'TRACE_SYNTHETIC_PRIVATE',status:'REVIEW',attempt_count:3,last_error:'ERROR_SYNTHETIC_PRIVATE EMP_SYNTHETIC_PRIVATE',updated_at:'2026-11-10T00:00:00.000Z',lease_until:null,lease_token:null,...o});
const expiredPayroll=(o={})=>payroll({job_id:'job_payroll_expired',entity_key:'EMP_SYNTHETIC_PRIVATE|2026-11-09',status:'PROCESSING',lease_until:'2026-11-02T00:00:00.000Z',lease_token:'LEASE_SYNTHETIC_PRIVATE',...o});
const STALE='exp_synthetic_stale',STALE_HASH=h(`EXPENSE:${STALE}:1`);
function db(jobs=[job()],setup=()=>{}){
 const d=expenseSqlite(),ins=d.sqlite.prepare('INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,last_error,updated_at,lease_until,lease_token) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
 for(const j of jobs)ins.run(j.job_id,j.entity_type,j.entity_key,j.entity_version,j.trace_id,j.status,j.attempt_count,j.last_error,j.updated_at,j.lease_until,j.lease_token);
 setup(d.sqlite);return d;
}
const envelope=row=>[{success:true,meta:{changed_db:false,rows_written:0},results:[{...row}]}];
// Run the real statements; outputs must hold only the expected count columns and no job value.
function evidenceOf(jobs,setup,{pins=PINS,expiredHash}={}){
 const d=db(jobs,setup);try{
  const review=d.sqlite.prepare(reviewSql(pins)).get(),writers=d.sqlite.prepare(expiredHash?writersSql(expiredHash):writersSql()).get();
  assert.deepEqual(Object.keys(review),REVIEW_COLUMNS);assert.deepEqual(Object.keys(writers),WRITER_COLUMNS);
  for(const p of PII)assert.ok(!JSON.stringify([review,writers]).includes(p),'job value left the statement: '+p);
  return {review:envelope(review),writers:envelope(writers),raw:{review:{...review},writers:{...writers}}};
 }finally{d.close()}
}
// A known stale terminal expense in the exact state the expired-writer exception allows.
const staleExpense=sqlite=>{
 sqlite.exec(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('${STALE}','m_stale','U_stale','synthetic',500,'CASH','SHOP_BANK','tip','2026-11-04','CONFIRMED','2026-11-04T00:00:00.000Z',1)`);
 sqlite.exec(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('job_stale','EXPENSE','${STALE}',1,'trace_stale','PROCESSING',5,'2026-11-04T00:00:00.000Z','2026-11-04T00:05:00.000Z','lease_stale')`);
 sqlite.exec(`INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('f_stale','malipang-jobs','trace_stale','EXPENSE:${STALE}:1','{}','DEAD_LETTER_MAX_RETRIES','OPEN',5,'2026-11-04T00:00:00.000Z','2026-11-04T00:00:00.000Z')`);
 for(const [id,name,proj] of [[1815870717,'รายวัน','DAILY'],[247227172,'V52_EXPENSE_RAW','EXPENSE_RAW']])
  sqlite.exec(`INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('1d8Cv76JicUo7jO4KykQ35Xg60GAjMOyJCeYT92xkKL8','EXPENSE','${STALE}','${proj}',${id},'${name}',1,'${'a'.repeat(64)}','op_${proj}','VERIFIED','2026-11-04T00:00:00.000Z')`);
};

// Complete B_POST snapshot, same shape as tests/pr247-stage-guard.test.mjs fixture('B_POST').
const G5_SHA='0d1dda77f3a0e5cfaec1872cb588b59dddfe5bdf',G5_WORKER='reviewed-g5-version-placeholder',NEW_WORKER='synthetic-new-version';
function snapshot(reviewJobs=1){return structuredClone({
 g5:{release:'PR247',state:'VERIFIED_COMPLETED',expected_sha:G5_SHA,prior_worker_version:G5_PREVIOUS_WORKER,queue_was_active:true,queue_id:'synthetic-queue-id'},
 params:{g5Sha:G5_SHA,expectedWorkerVersion:NEW_WORKER,priorWorkerVersion:G5_WORKER,completedBefore:3296,openFailedBefore:32},
 cloudflare:{cron:[{cron:'*/5 * * * *'}],versions:[{version_id:NEW_WORKER,percentage:100}],queue:{queue_name:'malipang-jobs',queue_id:'synthetic-queue-id',settings:{delivery_paused:false}}},
 d1:{migration:MIGRATION,recovery_tables:4,review:0,review_all:0,held:0,inflight:0,epoch_total:1,epoch_active:0,epoch_complete:1,unverified_ops:0,verified_ops:3,completed:3296,open_failed:32,review_jobs:reviewJobs,stale_held:0,unleased_inflight:0,canary_jobs_completed:1,canary_daily:1,canary_raw:1,canary_detail:1},
 status:{ok:true,inFlightProjections:0,claim:null,recoveryGate:{mode:'DISABLED'},sheetPacing:{mode:'OPT_IN'}},
 epoch:{epoch_found:1,epoch_state:'COMPLETE',unverified_ops:0,verified_ops:3,job_completed:1,daily:1,raw:1,detail:1},
 receipt:{state:'OWNER_VERIFIED',g7_canary_verified:true,provider_readback_verified:true,no_duplicate_stable_ids:true,no_new_429_observed:true,owner_approved_g8:true,schema:'MP248_G7_RECEIPT_V1',epoch_id:'syntheticEpoch01',expected_detail_count:1,gcp_quotas_checked:true,gcp_429_delta:0,g5_sha:G5_SHA,g6a_worker_version:G5_WORKER}
})}
const writers=(o={})=>envelope({claims:0,inflight:0,active_or_unbounded_leases:0,staff_processing:0,expired_processing:0,expired_known:0,expired_known_state:0,...o});
const base=evidenceOf([job()]);
const pre=({snap=snapshot(),w=base.writers,review=base.review,ex=ATTENDANCE_ACCEPT,expired='NONE'}={})=>verifyReleasePre({snapshot:snap,writers:w,review,attendanceException:ex,expiredException:expired});
const post=({snap=snapshot(),review=base.review,ex=ATTENDANCE_ACCEPT}={})=>verifyReleasePost({snapshot:snap,review,attendanceException:ex});

test('exact known REVIEW job passes pre and post through the real stage guard on provider-side counts',()=>{
 assert.deepEqual(base.raw.review,{review_total:1,candidates:1,known_job_rows:1,known_exact:1});
 assert.deepEqual(pre(),{ok:true,openFailed:32,expiredRiskAccepted:false});assert.equal(post().ok,true);
});
test('known job missing blocks pre and post; production pins never match synthetic identifiers',()=>{
 const {review}=evidenceOf([]);
 assert.throws(()=>pre({snap:snapshot(0),review}),/NO_GO_NONFINANCIAL_RELEASE_KNOWN_JOB_MISSING/);
 assert.throws(()=>post({snap:snapshot(0),review}),/KNOWN_JOB_MISSING/);
 const d=db();try{const r=d.sqlite.prepare(reviewSql()).get();assert.equal(r.known_job_rows,0);assert.throws(()=>verifyKnownAttendanceReview(envelope(r),ATTENDANCE_ACCEPT),/KNOWN_JOB_MISSING/);}finally{d.close()}
});
test('known job status or field drift blocks, even when no REVIEW job remains',()=>{
 const openFailure=s=>s.exec(`INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('f_known','malipang-jobs','${IDS.trace_id}','ATTENDANCE_EVENT:${IDS.entity_key}:1','{}','DEAD_LETTER_MAX_RETRIES','OPEN',1,'2026-11-10T00:00:00.000Z','2026-11-10T00:00:00.000Z')`);
 for(const [label,jobs,setup] of [['completed',[job({status:'COMPLETED'})]],['pending',[job({status:'PENDING'})]],['attempt changed',[job({attempt_count:2})]],['updated_at changed',[job({updated_at:'2026-11-11T00:00:00.000Z'})]],
  ['lease token changed',[job({lease_token:'LEASE_SYNTHETIC_PRIVATE'})]],['entity key changed',[job({entity_key:'EMP_SYNTHETIC_PRIVATE|other'})]],['trace changed',[job({trace_id:'TRACE_SYNTHETIC_PRIVATE'})]],
  ['error changed',[job({last_error:'ERROR_SYNTHETIC_PRIVATE'})]],['version changed',[job({entity_version:2})]],['lease until changed',[job({lease_until:'2026-11-10T21:58:50.189Z'})]],['open failed job',[job()],openFailure]]){
  const {review,raw}=evidenceOf(jobs,setup);assert.equal(raw.review.known_job_rows,1,label);assert.equal(raw.review.known_exact,0,label);
  const reviewJobs=raw.review.review_total;
  assert.throws(()=>pre({snap:snapshot(reviewJobs),review}),/KNOWN_JOB_DRIFT/,label);assert.throws(()=>post({snap:snapshot(reviewJobs),review}),/KNOWN_JOB_DRIFT/,label);
 }
});
test('payroll or duplicate REVIEW jobs block without any job value leaving D1; the exception never hides them',()=>{
 for(const [label,jobs] of [['payroll REVIEW',[job(),payroll()]],['duplicate attendance version',[job(),job({job_id:'synthetic_job_v2',entity_version:2})]],['duplicate payroll',[job(),payroll(),payroll({job_id:'job_payroll_dup',entity_key:'EMP_SYNTHETIC_PRIVATE|2026-11-11'})]]]){
  const {review,raw}=evidenceOf(jobs);assert.equal(raw.review.known_exact,1,label);assert.ok(raw.review.review_total>1,label);
  assert.throws(()=>pre({snap:snapshot(raw.review.review_total),review}),/NO_GO_NONFINANCIAL_RELEASE_OTHER_REVIEW/,label);
  assert.throws(()=>post({snap:snapshot(raw.review.review_total),review}),/OTHER_REVIEW/,label);
 }
});
test('more than 20 attendance candidates is not trusted',()=>{
 const many=Array.from({length:21},(_,i)=>job({job_id:'synthetic_extra_'+String(i).padStart(2,'0'),entity_key:'synthetic_attendance_extra_'+i,status:'PENDING'}));
 const {review,raw}=evidenceOf([job(),...many]);assert.equal(raw.review.candidates,21);
 assert.throws(()=>pre({review}),/REVIEW_FORMAT/);
});
test('snapshot REVIEW count drifting from the review evidence blocks',()=>{
 assert.throws(()=>pre({snap:snapshot(2)}),/REVIEW_COUNT_DRIFT/);
 assert.throws(()=>post({snap:snapshot(0)}),/REVIEW_COUNT_DRIFT/);
});
test('without owner acceptance the known job blocks release',()=>{
 assert.throws(()=>pre({ex:'NONE'}),/REVIEW_NOT_ACCEPTED/);
});
test('expired PROCESSING jobs: identity and state compared in D1, keys never returned',()=>{
 const payrollOnly=evidenceOf([job(),expiredPayroll()]);assert.deepEqual([payrollOnly.raw.writers.expired_processing,payrollOnly.raw.writers.expired_known],[1,0]);
 assert.throws(()=>pre({w:payrollOnly.writers}),/NO_GO_NONFINANCIAL_RELEASE_EXPIRED_NOT_ACCEPTED/);
 assert.throws(()=>pre({w:payrollOnly.writers,expired:'OWNER ACCEPTS EXPIRED TERMINAL WRITER RACE'}),/EXPIRED_IDENTITY_OR_STATE/);
 const stale=evidenceOf([job()],staleExpense,{expiredHash:STALE_HASH});assert.deepEqual([stale.raw.writers.expired_processing,stale.raw.writers.expired_known,stale.raw.writers.expired_known_state],[1,1,1]);
 assert.throws(()=>pre({w:stale.writers}),/EXPIRED_NOT_ACCEPTED/);
 assert.deepEqual(pre({w:stale.writers,expired:'OWNER ACCEPTS EXPIRED TERMINAL WRITER RACE'}),{ok:true,openFailed:32,expiredRiskAccepted:true});
 const drift=evidenceOf([job()],s=>{staleExpense(s);s.exec(`UPDATE expense_events SET status='CANCELLED' WHERE expense_id='${STALE}'`);},{expiredHash:STALE_HASH});
 assert.deepEqual([drift.raw.writers.expired_known,drift.raw.writers.expired_known_state],[1,0]);
 assert.throws(()=>pre({w:drift.writers,expired:'OWNER ACCEPTS EXPIRED TERMINAL WRITER RACE'}),/EXPIRED_IDENTITY_OR_STATE/);
 const two=evidenceOf([job(),expiredPayroll()],staleExpense,{expiredHash:STALE_HASH});assert.equal(two.raw.writers.expired_processing,2);
 assert.throws(()=>pre({w:two.writers,expired:'OWNER ACCEPTS EXPIRED TERMINAL WRITER RACE'}),/EXPIRED_NOT_ACCEPTED/);
 // Production pin never matches the synthetic stale item.
 assert.equal(evidenceOf([job()],staleExpense).raw.writers.expired_known,0);
});
test('flags, receipt, claim and in-flight failures still block through the real guards',()=>{
 const mut=f=>{const s=snapshot();f(s);return s};
 assert.throws(()=>pre({snap:mut(s=>{s.status.recoveryGate.mode='OPT_IN'})}),/NO_GO_/);
 assert.throws(()=>post({snap:mut(s=>{s.status.recoveryGate.mode='OPT_IN'})}),/NO_GO_STEADY_MODE_NOT_ACTIVE/);
 assert.throws(()=>pre({snap:mut(s=>{s.status.sheetPacing.mode='DISABLED'})}),/NO_GO_/);
 assert.throws(()=>pre({snap:mut(s=>{s.receipt.owner_approved_g8=false})}),/NO_GO_G7_OWNER_RECEIPT/);
 assert.throws(()=>post({snap:mut(s=>{s.receipt=null})}),/NO_GO_G7_OWNER_RECEIPT/);
 assert.throws(()=>pre({snap:mut(s=>{s.d1.review=1;s.d1.review_all=1})}),/NO_GO_REVIEW_NOT_RELEASED/);
 const held=evidenceOf([job()],s=>s.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim','HELD','now','now')"));
 assert.equal(held.raw.writers.claims,1);assert.throws(()=>pre({w:held.writers}),/NO_GO_NONFINANCIAL_RELEASE_BUSY_OR_REVIEW/);
 assert.throws(()=>pre({snap:mut(s=>{s.d1.inflight=1;s.d1.unleased_inflight=1;s.status.inFlightProjections=1})}),/NO_GO_STALE_WRITER_AFTER_GATE_EXIT/);
 for(const o of [{inflight:1},{active_or_unbounded_leases:1},{staff_processing:1}])assert.throws(()=>pre({w:writers(o)}),/BUSY_OR_REVIEW/);
});
test('mask removes exactly one verified job and never alters the input',()=>{
 const s=snapshot(1),m=maskKnownReview(s,1);assert.equal(m.d1.review_jobs,0);assert.equal(s.d1.review_jobs,1);
 assert.throws(()=>maskKnownReview(s,0),/REVIEW_COUNT_DRIFT/);
});
test('malformed, write-shaped or value-carrying evidence is UNKNOWN',()=>{
 const r=base.raw.review;
 for(const [rows,code] of [[[{...envelope(r)[0],meta:{changed_db:true,rows_written:0}}],'REVIEW_EVIDENCE'],[envelope({...r,entity_key:IDS.entity_key}),'REVIEW_EVIDENCE'],[envelope((({known_exact,...x})=>x)(r)),'REVIEW_EVIDENCE'],
  [[...envelope(r),...envelope(r)],'REVIEW_EVIDENCE'],[envelope({...r,known_exact:'1'}),'REVIEW_FORMAT'],[envelope({...r,known_exact:2}),'REVIEW_FORMAT'],[envelope({...r,known_job_rows:2,candidates:1}),'REVIEW_FORMAT']])
  assert.throws(()=>verifyKnownAttendanceReview(rows,ATTENDANCE_ACCEPT),new RegExp(code+'$'));
 assert.throws(()=>pre({w:envelope({...base.raw.writers,expired_json:'[]'})}),/NO_GO_NONFINANCIAL_RELEASE_EVIDENCE/);
 assert.throws(()=>pre({w:writers({expired_known:1})}),/WRITER_FORMAT/);
 for(const bad of [{...PINS,key:'x'},{...PINS,leaseUntil:"2026' OR 1=1"}])assert.throws(()=>reviewSql(bad),/PINS/);assert.throws(()=>writersSql("x' OR 1=1"),/PINS/);
});
test('CLI: SQL, stdout, stderr and evidence files never carry a job value',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'mp248-release-guard-'));try{
  const {review,writers:w}=evidenceOf([job(),payroll(),expiredPayroll()]);
  const files={snapshot:snapshot(2),writers:w,review};for(const [k,v] of Object.entries(files))writeFileSync(path.join(dir,k+'.json'),JSON.stringify(v));
  const env={...process.env,ATTENDANCE_REVIEW_EXCEPTION:ATTENDANCE_ACCEPT,EXPIRED_TERMINAL_EXCEPTION:'NONE'};
  for(const [mode,args] of [['pre',['snapshot','writers','review']],['post',['snapshot','review']]]){
   const r=spawnSync(process.execPath,['scripts/issue248-nonfinancial-release-guard.mjs',mode,...args.map(a=>path.join(dir,a+'.json'))],{encoding:'utf8',env});
   assert.equal(r.status,1,mode);assert.equal(r.stdout,'');assert.equal(r.stderr.trim(),'NO_GO_NONFINANCIAL_RELEASE_OTHER_REVIEW',mode);
  }
  for(const sql of ['sql-review','sql-writers']){const r=spawnSync(process.execPath,['scripts/issue248-nonfinancial-release-guard.mjs',sql],{encoding:'utf8'});assert.equal(r.status,0);assert.match(r.stdout,/^WITH RECURSIVE /);assert.doesNotMatch(r.stdout,/[;\n]./);}
  for(const f of readdirSync(dir))for(const p of PII)assert.ok(!readFileSync(path.join(dir,f),'utf8').includes(p),f+': '+p);
 }finally{rmSync(dir,{recursive:true,force:true})}
});
test('workflow: exact PR #271 source, strict exception, provider-side counts only, single deploy, no replay',()=>{
 const w=readFileSync('.github/workflows/issue248-nonfinancial-guard-release.yml','utf8');
 assert.match(w,/REVIEWED_RUNTIME_SHA: 2680c515b39a082038fdde707c236e4216290039/);
 assert.match(w,/refs\/pull\/271\/head:refs\/review\/pr271/);
 assert.match(w,/git diff --quiet "\$REVIEWED_RUNTIME_SHA" HEAD -- src migrations wrangler\.jsonc/);
 assert.match(w,/test "\$ATTENDANCE_REVIEW_EXCEPTION" = 'OWNER ACCEPTS KNOWN ATTENDANCE REVIEW'/);
 // No inline statement selects job values; review and writer evidence comes from the pinned generator.
 assert.doesNotMatch(w,/entity_key|trace_id|lease_token|last_error|json_group_array|json_object|known_json|review_json|expired_json/);
 assert.equal((w.match(/issue248-nonfinancial-release-guard\.mjs sql-review\)"/g)||[]).length,4);
 assert.equal((w.match(/issue248-nonfinancial-release-guard\.mjs sql-writers\)"/g)||[]).length,2);
 assert.equal((w.match(/--command "\$(REVIEW|WRITERS)_SQL" > "\$RUNNER_TEMP\/hotfix-[a-z-]+\.json" 2>\/dev\/null \|\| \{ echo HOTFIX_(REVIEW|WRITERS)_READ_UNKNOWN; exit 1; \}/g)||[]).length,6);
 assert.equal((w.match(/issue248-nonfinancial-release-guard\.mjs (pre|post)/g)||[]).length,4);
 assert.equal((w.match(/npx wrangler deploy >/g)||[]).length,1);
 assert.match(w,/HOTFIX_DEPLOY_ACK_UNKNOWN_NO_RETRY/);assert.doesNotMatch(w,/--retry [1-9]/);
 assert.doesNotMatch(w,/pr247-readonly-snapshot\.sh B_POST/);
 assert.doesNotMatch(w,/\b(UPDATE|DELETE|INSERT)\b/);assert.doesNotMatch(w,/wrangler (d1 migrations|queues)/);
});
test('expired-writer pin and acceptance stay identical to the terminal hotfix guard',()=>{
 const pick=(file,re)=>readFileSync(file,'utf8').match(re)?.[1];
 assert.equal(pick('scripts/issue248-nonfinancial-release-guard.mjs',/EXPIRED_KNOWN_HASH='([0-9a-f]{64})'/),pick('scripts/issue248-terminal-hotfix-guard.mjs',/KNOWN_HASH='([0-9a-f]{64})'/));
 assert.equal(pick('scripts/issue248-nonfinancial-release-guard.mjs',/EXPIRED_ACCEPT='([A-Z ]+)'/),pick('scripts/issue248-terminal-hotfix-guard.mjs',/ACCEPT='([A-Z ]+)'/));
});
