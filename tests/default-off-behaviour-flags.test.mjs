// With every candidate behaviour flag unset, the paths below must behave as
// they do on main. The fixture environment sets none of the flags.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const worker=require('../dist/index.js').default;
const repositories=require('../dist/db/repositories.js');
const expense={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_default_off',entityVersion:1,traceId:'t'};
const spy=h=>{const seen=[],prepare=h.DB.prepare;h.DB.prepare=function(sql){seen.push(sql);return prepare.call(this,sql);};return seen;};

test('fixture leaves every candidate behaviour flag unset',()=>{const h=expenseSqlite();try{
 for(const flag of ['EXPENSE_SAVED_SYNC_NOTE_ENABLED','EXPENSE_FORCE_RECONCILE_HOLD_ENABLED','STABLE_REDRIVE_HOLD_ENABLED','WORKBOOK_BATCH_FAIRNESS_ENABLED','SYNC_ALERT_DURABLE_ENABLED','STABLE_SCOPED_REVIEW_ENABLED'])assert.equal(h.env[flag],undefined,flag);
}finally{h.close();}});

test('fairness off: a mixed paced batch runs its first workbook job and never reads fairness state',async()=>{
 const h=expenseSqlite(),dispatch=require('../dist/sheets/stable-phase1-dispatch.js'),old=dispatch.dispatchStablePhase1;try{
  Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});
  h.sqlite.exec('DROP TABLE workbook_batch_fairness');
  const seen=spy(h),ran=[];let ack=0;dispatch.dispatchStablePhase1=async(_env,job)=>{ran.push(job.entityKey);return 'BLOCKED';};
  const jobs=[{...expense,entityKey:'exp_first'},{kind:'SHEETS_SYNC',entityType:'DAILY_PAYROLL',entityKey:'hr_second',entityVersion:1,traceId:'t'}];
  await worker.queue({queue:'malipang-jobs',messages:jobs.map(body=>({body,attempts:1,ack(){ack++;},retry(){assert.fail('unexpected retry');}}))},h.env,{});
  assert.deepEqual(ran,['exp_first']);assert.equal(ack,2);
  assert.equal(seen.some(sql=>sql.includes('workbook_batch_fairness')),false);
 }finally{dispatch.dispatchStablePhase1=old;h.close();}});

test('durable alerts off: sheet DLQ records the terminal failure and uses no incident sweep',async()=>{
 const h=expenseSqlite();try{
  const seen=spy(h),sent=[];let ack=0;h.env.JOB_QUEUE.send=async job=>{sent.push(job);};
  await worker.queue({queue:'malipang-jobs-dlq',messages:[{body:expense,attempts:1,ack(){ack++;},retry(){assert.fail('unexpected retry');}}]},h.env,{});
  assert.equal(ack,1);assert.equal(sent.length,0);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE error='DEAD_LETTER_MAX_RETRIES' AND status='OPEN'").get().n,1);
  assert.equal(seen.some(sql=>sql.includes("name='sync_alert_incidents'")),false);
 }finally{h.close();}});

test('redrive hold off: stable recovery re-sends a stale FAILED job instead of holding it for review',async()=>{
 const h=expenseSqlite();try{
  Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});
  h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,next_attempt_at) VALUES('job_failed','DAILY_PAYROLL','hr_failed',1,'t','FAILED','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')").run();
  assert.equal(await repositories.recoverPendingSheetJobs(h.env,0),1);
  assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job_failed'").get().status,'PENDING');
  assert.equal(h.queue.length,1);
 }finally{h.close();}});

test('force hold off: forced reconciliation enqueues expense jobs as on main',async()=>{
 const h=expenseSqlite();try{
  assert.equal(await repositories.enqueueSheetSyncBatch(h.env,[expense],true),1);
  assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key='exp_default_off'").get().status,'PENDING');
  assert.equal(h.queue.length,1);
 }finally{h.close();}});

test('redrive hold off: a queued duplicate claims a FAILED job and an expired PROCESSING lease as on main',async()=>{
 const {claimSheetSyncJob}=require('../dist/sheets/sync.js');
 const h=expenseSqlite();try{
  Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});
  const past='2026-01-01T00:00:00.000Z';
  h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,next_attempt_at) VALUES('j_failed','DAILY_PAYROLL','hr_failed',1,'t','FAILED',?,?)").run(past,past);
  h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('j_expired','DAILY_PAYROLL','hr_expired',1,'t','PROCESSING',?,?,'old')").run(past,past);
  for(const key of ['hr_failed','hr_expired'])assert.equal(typeof await claimSheetSyncJob(h.env,{kind:'SHEETS_SYNC',entityType:'DAILY_PAYROLL',entityKey:key,entityVersion:1,traceId:'t'}),'string',key);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_jobs WHERE job_id IN ('j_failed','j_expired') AND status='PROCESSING'").get().n,2);
 }finally{h.close();}});

test('scoped review off: a daily preflight review throws the main code STABLE_DAILY_REVIEW',async()=>{
 const {STABLE_DAILY_REVIEW_REASONS}=require('../dist/sheets/stable-daily-writer.js');
 assert.equal(STABLE_DAILY_REVIEW_REASONS.includes('STABLE_DAILY_REVIEW'),true);
 assert.equal(STABLE_DAILY_REVIEW_REASONS.includes('STABLE_DAILY_MONTH_OPENING_UNVERIFIED'),true);
});

const armTarget=(h,type,key)=>h.sqlite.prepare("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('synthetic-epoch-r4','book','ARMED',?,?,1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')").run(type,key);
// Real D1 results carry success:true; this fixture omits it, so add it as other suites do.
const d1Success=h=>{const prepare=h.DB.prepare,batch=h.DB.batch;h.DB.prepare=function(sql){const st=prepare.call(this,sql),run=st.run,all=st.all;st.run=async function(){return{...await run.call(this),success:true};};st.all=async function(){return{...await all.call(this),success:true};};return st;};h.DB.batch=async function(stmts){return(await batch.call(this,stmts)).map(r=>({...r,success:true}));};};
const gateEnv=h=>{d1Success(h);Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});};

test('R4 redrive hold off: the armed recovery target is re-sent from FAILED or an expired lease as on main',async()=>{
 for(const [status,extra] of [['FAILED',"next_attempt_at='2026-01-01T00:00:00.000Z'"],['PROCESSING',"lease_until='2026-01-01T00:00:00.000Z',lease_token='old'"]]){
  const h=expenseSqlite();try{
   gateEnv(h);armTarget(h,'DAILY_PAYROLL','hr_armed');
   h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('j','DAILY_PAYROLL','hr_armed',1,'t',?,'2026-01-01T00:00:00.000Z')`).run(status);
   h.sqlite.exec(`UPDATE sync_jobs SET ${extra} WHERE job_id='j'`);
   const sent=[];h.env.JOB_QUEUE.send=async job=>{sent.push(job);};
   assert.equal(await repositories.recoverArmedSheetJob(h.env,0),1,status);
   assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='j'").get().status,'PENDING');assert.equal(sent.length,1);
   // With the hold on, the same state is not re-sent (scheduled recovery reviews it instead).
   h.sqlite.prepare(`UPDATE sync_jobs SET status=?,updated_at='2026-01-01T00:00:00.000Z' WHERE job_id='j'`).run(status);h.sqlite.exec(`UPDATE sync_jobs SET ${extra} WHERE job_id='j'`);
   h.env.STABLE_REDRIVE_HOLD_ENABLED='true';
   assert.equal(await repositories.recoverArmedSheetJob(h.env,0),0,status);assert.equal(sent.length,1);
  }finally{h.close();}
 }
});

test('R4 terminal hold under the recovery gate: an expense with an open terminal DLQ is held, as on main',async()=>{
 const {withStableWorkbookClaim}=require('../dist/sheets/stable-workbook-claim.js'),notice=require('../dist/sheets/stable-edit-notice.js'),pacing=require('../dist/sheets/stable-sheet-pacing.js');
 const old={b:notice.beginStableNotice,e:notice.endStableNotice,a:pacing.admitPacedWorkbookOperation,p:pacing.pacingPreflightBlocked};
 const h=expenseSqlite();try{
  gateEnv(h);notice.beginStableNotice=async(_e,_t,_w,ok)=>{await ok?.();};notice.endStableNotice=async()=>{};pacing.admitPacedWorkbookOperation=async()=>true;pacing.pacingPreflightBlocked=async()=>false;
  armTarget(h,'EXPENSE','exp_r4');
  h.sqlite.exec("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,created_at,updated_at) VALUES('f','malipang-jobs','t','EXPENSE:exp_r4:1','{}','DEAD_LETTER_MAX_RETRIES','OPEN','now','now')");
  let ran=0;
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>{ran++;},{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_r4',entityVersion:1,traceId:'t'}),/STABLE_TERMINAL_HOLD/);
  assert.equal(ran,0);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_recovery_operations").get().n,0);
  assert.equal(h.sqlite.prepare("SELECT state FROM stable_recovery_epochs").get().state,'ARMED');
 }finally{Object.assign(notice,{beginStableNotice:old.b,endStableNotice:old.e});Object.assign(pacing,{admitPacedWorkbookOperation:old.a,pacingPreflightBlocked:old.p});h.close();}
});

test('R7: a transient read failure of the activation marker is retried, not held for review',async()=>{
 const {assertContinuousNoticeActivation,CONTINUOUS_NOTICE_ACTIVATION_BLOCKED}=require('../dist/sheets/continuous-notice-activation.js');
 const h=expenseSqlite();try{
  const prepare=h.DB.prepare;let fail=true;
  h.DB.prepare=function(sql){const st=prepare.call(this,sql);if(sql.includes('FROM continuous_notice_activation')||sql.includes('continuous_notice_activation a')){const first=st.first;st.first=async function(){if(fail)throw Error('synthetic D1 timeout');return first.call(this);};}return st;};
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_r7',entityVersion:1,traceId:'t'};
  await assert.rejects(assertContinuousNoticeActivation(h.env,job),e=>e.message==='synthetic D1 timeout');
  h.env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED='true';
  await assert.rejects(assertContinuousNoticeActivation(h.env,job),e=>e.message===CONTINUOUS_NOTICE_ACTIVATION_BLOCKED);
  delete h.env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED;fail=false;
  await assertContinuousNoticeActivation(h.env,job);
 }finally{h.close();}
});
