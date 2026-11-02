import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {legacyDailyWriterOpen} from '../dist/sheets/daily-legacy-writer-gate.js';
import {syncJob,reconcileExpenseItemRows} from '../dist/sheets/sync.js';
import {writeConfirmedExpenseToDaily,writeConfirmedExpenseWithDocumentItemsToDaily,clearCancelledExpenseFromDaily} from '../dist/sheets/daily-expense.js';
import {handleAdmin} from '../dist/admin/handler.js';
import workerModule from '../dist/index.js';
const worker=workerModule.default;
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js');
const migration=readFileSync(new URL('../migrations/0026_daily_legacy_writer_gate.sql',import.meta.url),'utf8');
const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:1,traceId:'fixture'};
function setup(){const h=expenseSqlite();h.sqlite.exec(migration);Object.assign(h.env,{DAILY_LEGACY_WRITER_GATE_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'fixture',SHEET_EXPENSE_DAILY:'daily',SHEETS_SYNC_ENABLED:'true'});return h;}
test('gate defaults off but enabled missing, malformed or HOLD fails closed',async()=>{
  const h=setup();try{delete h.env.DAILY_LEGACY_WRITER_GATE_ENABLED;assert.equal(await legacyDailyWriterOpen(h.env),true);h.env.DAILY_LEGACY_WRITER_GATE_ENABLED='typo';assert.equal(await legacyDailyWriterOpen(h.env),false);h.env.DAILY_LEGACY_WRITER_GATE_ENABLED='true';assert.equal(await legacyDailyWriterOpen(h.env),false);h.sqlite.exec("INSERT INTO daily_legacy_writer_gates VALUES('fixture','daily','OPEN','g1','now')");assert.equal(await legacyDailyWriterOpen(h.env),true);h.sqlite.exec("UPDATE daily_legacy_writer_gates SET state='HOLD'");assert.equal(await legacyDailyWriterOpen(h.env),false);h.sqlite.exec(migration);h.sqlite.exec('DROP TABLE daily_legacy_writer_gates');assert.equal(await legacyDailyWriterOpen(h.env),false);assert.equal(await syncJob(h.env,job),'REVIEW');}finally{h.close();}
});
test('held expense queue work is durably recorded before REVIEW without a Google call',async()=>{
  const h=setup(),fetch=globalThis.fetch;try{let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected request');};assert.equal(await syncJob(h.env,job),'REVIEW');assert.equal(await syncJob(h.env,job),'REVIEW');assert.deepEqual({...h.sqlite.prepare('SELECT status,last_error,attempt_count FROM sync_jobs').get()},{status:'REVIEW',last_error:'DAILY_LEGACY_CUTOVER_HOLD',attempt_count:0});assert.equal(calls,0);}finally{globalThis.fetch=fetch;h.close();}
});
test('gate never reclaims a processing job or resets an existing review',async()=>{
  const h=setup();try{h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_token) VALUES('f','EXPENSE','exp_fixture',1,'fixture','PROCESSING','now','owned')").run();assert.equal(await syncJob(h.env,job),'TERMINAL_HOLD');assert.equal(h.sqlite.prepare('SELECT lease_token FROM sync_jobs').get().lease_token,'owned');h.sqlite.prepare("UPDATE sync_jobs SET status='REVIEW',last_error='independent hold'").run();assert.equal(await syncJob(h.env,job),'REVIEW');assert.equal(h.sqlite.prepare('SELECT last_error FROM sync_jobs').get().last_error,'independent hold');}finally{h.close();}
});
test('gate preserves the original failure reason for an already failed outbox',async()=>{
  const h=setup();try{h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,last_error) VALUES('f','EXPENSE','exp_fixture',1,'fixture','FAILED','now','original failure')").run();assert.equal(await syncJob(h.env,job),'REVIEW');assert.equal(h.sqlite.prepare("SELECT last_error FROM sync_jobs WHERE job_id='f'").get().last_error,'original failure');}finally{h.close();}
});
test('outbox transaction failure keeps existing pending work; lost acknowledgement keeps REVIEW',async()=>{
  for(const lostAck of [false,true]){const h=setup();try{
    h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('f','EXPENSE','exp_fixture',1,'fixture','PENDING','now')").run();
    if(lostAck)h.DB.failAfterCommit=true;else h.DB.failAt=1;
    await assert.rejects(syncJob(h.env,job),/fixture/);
    assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='f'").get().status,lostAck?'REVIEW':'PENDING');
    h.DB.failAfterCommit=false;h.DB.failAt=null;assert.equal(await syncJob(h.env,job),'REVIEW');
  }finally{h.close();}}
});
test('direct legacy daily and reconciliation paths stop before network or row allocation',async()=>{
  const h=setup(),fetch=globalThis.fetch;try{let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected request');};const r={expenseId:'exp_fixture',version:1};await assert.rejects(writeConfirmedExpenseToDaily(h.env,r),/CUTOVER_HOLD/);await assert.rejects(writeConfirmedExpenseWithDocumentItemsToDaily(h.env,r,null,[]),/CUTOVER_HOLD/);await assert.rejects(clearCancelledExpenseFromDaily(h.env,'exp_fixture'),/CUTOVER_HOLD/);await assert.rejects(reconcileExpenseItemRows(h.env,'exp_fixture'),/CUTOVER_HOLD/);h.env.ADMIN_TOKEN='synthetic-long-admin-token-for-local-tests';const response=await handleAdmin(new Request('https://local.invalid/admin/reconcile-expense-items',{method:'POST',headers:{authorization:'Bearer '+h.env.ADMIN_TOKEN,'content-type':'application/json'},body:JSON.stringify({expenseId:'exp_fixture'})}),h.env,{});assert.notEqual(response.status,200);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sheet_row_index').get().n,0);assert.equal(calls,0);}finally{globalThis.fetch=fetch;h.close();}
});
test('queue acknowledges the durable hold without re-enqueueing or dropping its review alert',async()=>{
  const h=setup();try{let acknowledgements=0,retries=0,sends=0;h.env.JOB_QUEUE={send:async()=>{sends++;}};const message={body:job,attempts:1,ack(){acknowledgements++;},retry(){retries++;}};await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});assert.equal(acknowledgements,1);assert.equal(retries,0);assert.equal(sends,0);assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'REVIEW');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE status='OPEN'").get().n,1);}finally{h.close();}
});
test('an OPEN to HOLD transition during a daily write stops dispatch at the callback',async()=>{
  const h=setup(),oldRead=client.batchGetSheetValues,oldFormula=client.batchGetSheetFormulaValues,oldWrite=client.batchWriteValues;try{
    h.sqlite.exec("INSERT INTO daily_legacy_writer_gates VALUES('fixture','daily','OPEN','g1','now')");
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_fixture','msg','fixture','Synthetic',10000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const body=Array.from({length:12},()=>[]),headers=[[],Array(8).fill(null),[]];body[5]=[null,10,null,'รายรับทั้งหมดในบัญชี'];body[10]=['รวม',10];headers[1][7]='เงินโอน';
    client.batchGetSheetValues=async()=>[structuredClone(body),structuredClone(headers)];client.batchGetSheetFormulaValues=async(_env,ranges)=>ranges.map(()=>[]);let dispatched=0;client.batchWriteValues=async(_env,_writes,before)=>{h.sqlite.exec("UPDATE daily_legacy_writer_gates SET state='HOLD'");await before();dispatched++;};
    await assert.rejects(writeConfirmedExpenseToDaily(h.env,{expenseId:'exp_fixture',transactionDate:'2026-10-28',description:'Synthetic',amountBaht:100,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'general',version:1}),/CUTOVER_HOLD/);assert.equal(dispatched,0);
  }finally{client.batchGetSheetValues=oldRead;client.batchGetSheetFormulaValues=oldFormula;client.batchWriteValues=oldWrite;h.close();}
});
