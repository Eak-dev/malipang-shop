import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),worker=require('../dist/index.js').default;
test('staff and legacy sheet jobs wait for the same occupied workbook without losing the message',async()=>{
 for(const job of [{kind:'STAFF_CONFIG_SYNC',employeeId:'staff',version:1,traceId:'fixture'},{kind:'SHEETS_SYNC',entityType:'DAILY_PAYROLL',entityKey:'staff|2026-11-03',entityVersion:1,traceId:'fixture'}]){const h=expenseSqlite();try{
  const prepare=h.DB.prepare;h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=async function(){return{...await run.call(this),success:true};};return s;};Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other','HELD','now','now')");
  let sent=0,ack=0,retry=0;h.env.JOB_QUEUE.send=async(value,opts)=>{assert.deepEqual(value,job);assert.equal(opts.delaySeconds,30);sent++;};const message={body:job,attempts:1,ack(){ack++;},retry(){retry++;}};
  await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});assert.equal(sent,1);assert.equal(ack,1);assert.equal(retry,0);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'HELD');
 }finally{h.close();}}
});
test('a review claim acknowledges every workbook delivery once, keeps the durable job and stops the busy loop',async()=>{
 for(const job of [{kind:'STAFF_CONFIG_SYNC',employeeId:'staff',version:1,traceId:'fixture'},{kind:'SHEETS_SYNC',entityType:'DAILY_PAYROLL',entityKey:'staff|2026-11-03',entityVersion:1,traceId:'fixture'},{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_new',entityVersion:1,traceId:'fixture'}]){const h=expenseSqlite();try{
  const prepare=h.DB.prepare;h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=async function(){return{...await run.call(this),success:true};};return s;};Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other','REVIEW','now','now')");
  let sent=0,ack=0,retry=0;h.env.JOB_QUEUE.send=async()=>{sent++;};const message={body:job,attempts:1,ack(){ack++;},retry(){retry++;}};
  for(let i=0;i<20;i++)await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});
  assert.equal(ack,20);assert.equal(sent,0);assert.equal(retry,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM failed_jobs').get().n,0);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
  if(job.kind==='SHEETS_SYNC')assert.deepEqual({...h.sqlite.prepare('SELECT status,attempt_count FROM sync_jobs WHERE entity_key=?').get(job.entityKey)},{status:'PENDING',attempt_count:0});
 }finally{h.close();}}
});
test('scheduled recovery waits for a review claim to be resolved before re-sending durable jobs',async()=>{const h=expenseSqlite(),{recoverPendingSheetJobs}=require('../dist/db/repositories.js'),{recoverPendingStaffConfigSyncs}=require('../dist/sheets/staff-config.js');try{
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});const prepared=[],prepare=h.DB.prepare;h.DB.prepare=function(sql){prepared.push(sql);return prepare.call(this,sql);};
 h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('job','DAILY_PAYROLL','staff|2026-11-03',1,'fixture','PENDING',0,'2026-11-01T00:00:00.000Z'); INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other','REVIEW','now','now')");
 assert.equal(await recoverPendingSheetJobs(h.env),0);assert.equal(await recoverPendingStaffConfigSyncs(h.env),0);assert.equal(h.queue.length,0);assert.equal(prepared.some(sql=>sql.includes('staff_config_sync_outbox')),false);
 h.sqlite.exec('DELETE FROM stable_workbook_claims');
 assert.equal(await recoverPendingSheetJobs(h.env),1);assert.equal(h.queue.length,1);assert.equal(h.queue[0].body.entityKey,'staff|2026-11-03');
}finally{h.close();}});
