import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const route=require('../dist/sheets/continuous-daily-route.js');
const cancellation=require('../dist/sheets/stable-expense-cancellation-job.js');
const {dispatchStablePhase1}=require('../dist/sheets/stable-phase1-dispatch.js');

function fixture(){
 const h=expenseSqlite(),prepare=h.DB.prepare,oldRoute=route.assertContinuousDailyActivated,oldCancel=cancellation.runStableExpenseCancellationJob;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run,all=s.all;s.run=async function(){return {...await run.call(this),success:true}};s.all=async function(){return {...await all.call(this),success:true}};return s};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'false',STABLE_SHEETS_PACING_ENABLED:'true',STABLE_REDRIVE_HOLD_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true'});
 h.sqlite.exec("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'; INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_example','message','fixture','item',100,'transfer','SHOP_BANK','ingredients','2026-11-21','CONFIRMED','now',1); UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_example'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,last_error) VALUES('first','EXPENSE','exp_example',1,'fixture','REVIEW',1,'now','STABLE_SYNC_REVIEW'); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at) VALUES('undo','EXPENSE','exp_example',2,'fixture','PENDING',0,'now','2000-01-01T00:00:00.000Z')");
 route.assertContinuousDailyActivated=async()=>({sheet:'daily',sheetId:8});let called=0;
 cancellation.runStableExpenseCancellationJob=async()=>{called++;return 'COMPLETED'};
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_example',entityVersion:2,traceId:'fixture'};
 return {...h,job,get called(){return called},run(){return dispatchStablePhase1(h.env,job)},close(){route.assertContinuousDailyActivated=oldRoute;cancellation.runStableExpenseCancellationJob=oldCancel;h.close()}};
}
test('an unattempted Undo behind an unresolved confirmation is held without claiming the workbook',async()=>{
 const h=fixture();try{
  const before=h.sqlite.prepare("SELECT status,version FROM expense_events WHERE expense_id='exp_example'").get();
  assert.equal(await h.run(),'REVIEW');assert.equal(h.called,0);
  assert.deepEqual({...h.sqlite.prepare("SELECT status,version FROM expense_events WHERE expense_id='exp_example'").get()},{...before});
  assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error,attempt_count,next_attempt_at FROM sync_jobs WHERE job_id='undo'").get()},{status:'REVIEW',last_error:'CONTINUOUS_CANCEL_PREDECESSOR_REVIEW',attempt_count:0,next_attempt_at:null});
  assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='first'").get().status,'REVIEW');
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{h.close()}
});
test('duplicate deliveries keep the same review fence and never invoke a provider writer',async()=>{
 const h=fixture();try{const r=await Promise.all([h.run(),h.run()]);assert.deepEqual(r,['REVIEW','REVIEW']);assert.equal(h.called,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0)}finally{h.close()}
});
test('D1 trigger changes included in the hold count still leave the workbook unclaimed',async()=>{
 const h=fixture(),prepare=h.DB.prepare;try{
  h.DB.prepare=function(sql){const s=prepare.call(this,sql);if(sql.includes("CONTINUOUS_CANCEL_PREDECESSOR_REVIEW")){const run=s.run;s.run=async function(){const r=await run.call(this);return r.meta?.changes===1?{...r,meta:{...r.meta,changes:2}}:r}}return s};
  assert.equal(await h.run(),'REVIEW');assert.equal(h.called,0);
  assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='undo'").get().status,'REVIEW');
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{h.close()}
});
for(const [label,mutate] of [
 ['original still pending',h=>h.sqlite.exec("UPDATE sync_jobs SET status='PENDING' WHERE job_id='first'")],
 ['Undo already attempted',h=>h.sqlite.exec("UPDATE sync_jobs SET attempt_count=1 WHERE job_id='undo'")],
 ['an existing row index',h=>h.sqlite.exec("INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('daily','exp_example',5)")],
])test(`unrelated cancellation path is preserved for ${label}`,async()=>{
 const h=fixture();try{mutate(h);assert.equal(await h.run(),'PROCESSED');assert.equal(h.called,1);assert.notEqual(h.sqlite.prepare("SELECT last_error FROM sync_jobs WHERE job_id='undo'").get().last_error,'CONTINUOUS_CANCEL_PREDECESSOR_REVIEW')}finally{h.close()}
});
test('an armed recovery gate blocks the hold and leaves the pending job untouched',async()=>{
 const h=fixture();try{h.env.STABLE_RECOVERY_GATE_ENABLED='true';assert.equal(await h.run(),'BLOCKED');assert.equal(h.called,0);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='undo'").get().status,'PENDING')}finally{h.close()}
});
