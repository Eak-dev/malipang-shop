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
 for(const flag of ['EXPENSE_SAVED_SYNC_NOTE_ENABLED','EXPENSE_FORCE_RECONCILE_HOLD_ENABLED','STABLE_REDRIVE_HOLD_ENABLED','WORKBOOK_BATCH_FAIRNESS_ENABLED','SYNC_ALERT_DURABLE_ENABLED'])assert.equal(h.env[flag],undefined,flag);
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
