import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),worker=require('../dist/index.js').default;
test('staff and legacy sheet jobs wait for the same occupied workbook without losing the message',async()=>{
 for(const job of [{kind:'STAFF_CONFIG_SYNC',employeeId:'staff',version:1,traceId:'fixture'},{kind:'SHEETS_SYNC',entityType:'DAILY_PAYROLL',entityKey:'staff|2026-11-03',entityVersion:1,traceId:'fixture'}]){const h=expenseSqlite();try{
  const prepare=h.DB.prepare;h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;s.run=async function(){return{...await run.call(this),success:true};};return s;};Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other','HELD','now','now')");
  let sent=0,ack=0,retry=0;h.env.JOB_QUEUE.send=async(value,opts)=>{assert.deepEqual(value,job);assert.equal(opts.delaySeconds,30);sent++;};const message={body:job,attempts:1,ack(){ack++;},retry(){retry++;}};
  await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});assert.equal(sent,1);assert.equal(ack,1);assert.equal(retry,0);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'HELD');
 }finally{h.close();}}
});
