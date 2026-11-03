import test from 'node:test';
import assert from 'node:assert/strict';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {readStableExpenseSource} from '../dist/sheets/stable-expense-source.js';

test('expense snapshot requires new identity, claim and current lease, and detects source changes',async()=>{
 const h=expenseSqlite();try{h.env.GOOGLE_SPREADSHEET_ID='book';const batch=h.DB.batch;h.DB.batch=async function(statements){return(await batch.call(this,statements)).map(result=>({...result,success:true}));};
  h.sqlite.exec("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'; INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_new','message','owner','example',10000,'transfer','SHOP_BANK','ingredients','2026-10-09','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_new',1,'fixture','PROCESSING','now','2099-01-01T00:00:00.000Z','lease'); INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim','HELD','now','now')");
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_new',entityVersion:1,traceId:'fixture'},first=await readStableExpenseSource(h.env,job,'lease','claim');assert.ok(first);assert.equal(await readStableExpenseSource(h.env,job,'wrong','claim'),null);
  h.sqlite.exec("UPDATE expense_events SET description='changed' WHERE expense_id='exp_new'; UPDATE expense_events SET description='example' WHERE expense_id='exp_new'");
  const after=await readStableExpenseSource(h.env,job,'lease','claim');assert.ok(after);assert.equal(after.digest,first.digest);assert.ok(after.revision>first.revision);
 }finally{h.close();}
});
