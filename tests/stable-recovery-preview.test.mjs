import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
const {previewExpenseRecovery}=createRequire(import.meta.url)('../dist/admin/stable-recovery-preview.js');

function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec(`CREATE TABLE sync_jobs(entity_type TEXT,entity_key TEXT,entity_version INTEGER,status TEXT);
 CREATE TABLE expense_events(expense_id TEXT,status TEXT,version INTEGER);
 CREATE TABLE stable_workbook_claims(spreadsheet_id TEXT,state TEXT);
 CREATE TABLE stable_recovery_epochs(epoch_id TEXT,spreadsheet_id TEXT,state TEXT);
 CREATE TABLE stable_recovery_operations(epoch_id TEXT,state TEXT);
 CREATE TABLE failed_jobs(queue_name TEXT,job_key TEXT,status TEXT,error TEXT);
 CREATE TABLE stable_projection_writes(spreadsheet_id TEXT,entity_type TEXT,entity_id TEXT,state TEXT);
 CREATE TABLE stable_sync_cutover(singleton INTEGER,state TEXT);
 CREATE TABLE stable_pre_cutover_sources(entity_type TEXT,entity_id TEXT);
 INSERT INTO sync_jobs VALUES('EXPENSE','expense-a',1,'PENDING');
 INSERT INTO expense_events VALUES('expense-a','CONFIRMED',1);
 INSERT INTO stable_sync_cutover VALUES(1,'ACTIVE');`);
 let writes=0;
 const env={GOOGLE_SPREADSHEET_ID:'book-a',DB:{prepare(sql){assert.match(sql,/^WITH target/);const stmt=sqlite.prepare(sql);let values;return {bind(...args){values=args;return this;},async first(){return stmt.get(...values)??null},async run(){writes++;throw Error('write forbidden')}}}}};
 return {env,sqlite,get writes(){return writes},close(){sqlite.close()}};
}
const target={expenseId:'expense-a',version:1};
test('a clean database snapshot only requests provider reconciliation and never writes',async()=>{const h=fixture();try{
 assert.deepEqual(await previewExpenseRecovery(h.env,target),{disposition:'PROVIDER_RECONCILIATION_REQUIRED',reasons:['PROVIDER_RECONCILIATION_REQUIRED'],journal:{verified:0,inFlight:0,review:0}});
 assert.equal(h.writes,0);
}finally{h.close()}});
test('review, terminal, in-flight and cancelled superseded expenses are held',async()=>{const h=fixture();try{
 h.sqlite.exec(`UPDATE sync_jobs SET status='REVIEW'; UPDATE expense_events SET status='CANCELLED',version=2;
 INSERT INTO stable_workbook_claims VALUES('book-a','REVIEW');
 INSERT INTO failed_jobs VALUES('malipang-jobs','EXPENSE:expense-a:1','OPEN','DEAD_LETTER_MAX_RETRIES');
 INSERT INTO stable_projection_writes VALUES('book-a','EXPENSE','expense-a|item','IN_FLIGHT');`);
 const p=await previewExpenseRecovery(h.env,target);
 assert.equal(p.disposition,'HOLD');for(const reason of ['JOB_REVIEW','SOURCE_NOT_CONFIRMED','SOURCE_VERSION_CHANGED','WORKBOOK_REVIEW','OPEN_TERMINAL','PROJECTION_IN_FLIGHT','PROVIDER_RECONCILIATION_REQUIRED'])assert.ok(p.reasons.includes(reason),reason);
 assert.deepEqual(p.journal,{verified:0,inFlight:1,review:0});assert.equal(h.writes,0);
}finally{h.close()}});
test('all non-pending statuses hold and only exact book and expense journal are counted',async()=>{const h=fixture();try{
 h.sqlite.exec(`INSERT INTO stable_projection_writes VALUES('book-b','EXPENSE','expense-a','REVIEW');
 INSERT INTO stable_projection_writes VALUES('book-a','EXPENSE','expense-ab|item','REVIEW');
 INSERT INTO stable_projection_writes VALUES('book-a','EXPENSE','expense-a|item','VERIFIED');`);
 for(const status of ['REVIEW','FAILED','PROCESSING','COMPLETED']){
 h.sqlite.prepare('UPDATE sync_jobs SET status=?').run(status);const p=await previewExpenseRecovery(h.env,target);assert.equal(p.disposition,'HOLD');assert.ok(p.reasons.includes(`JOB_${status}`));assert.deepEqual(p.journal,{verified:1,inFlight:0,review:0});
 }
}finally{h.close()}});
test('invalid target or unreadable schema fail closed without exposing errors',async()=>{const h=fixture();try{
 assert.deepEqual(await previewExpenseRecovery(h.env,{expenseId:'expense-a|x',version:1}),{disposition:'UNAVAILABLE',reasons:['INVALID_TARGET'],journal:null});
 h.sqlite.exec('DROP TABLE stable_recovery_epochs');assert.deepEqual(await previewExpenseRecovery(h.env,target),{disposition:'UNAVAILABLE',reasons:['READ_UNVERIFIED'],journal:null});
}finally{h.close()}});
