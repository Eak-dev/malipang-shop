import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {handleExpensePostback} from '../dist/expense/service.js';
import {claimSheetSyncJob,syncJob} from '../dist/sheets/sync.js';
import {recoverPendingSheetJobs} from '../dist/db/repositories.js';
const sheetsClient=createRequire(import.meta.url)('../dist/sheets/client.js');

class Statement{
  constructor(owner,sql){this.owner=owner;this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  async first(){return this.owner.sqlite.prepare(this.sql).get(...this.args)??null;}
  async all(){return{results:this.owner.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}};}
  runSync(){
    const stmt=this.owner.sqlite.prepare(this.sql);
    if(/^\s*SELECT\b/i.test(this.sql))return{results:stmt.all(...this.args),meta:{changes:0}};
    const result=stmt.run(...this.args);return{meta:{changes:Number(result.changes)}};
  }
  async run(){return this.runSync();}
}
class SqliteD1{
  constructor(sqlite){this.sqlite=sqlite;this.failAt=null;this.failAfterCommit=false;}
  prepare(sql){return new Statement(this,sql);}
  async batch(statements){
    this.sqlite.exec('BEGIN IMMEDIATE');let results;
    try{
      results=statements.map((statement,index)=>{
        if(this.failAt===index)throw new Error('injected transactional failure');
        return statement.runSync();
      });
      this.sqlite.exec('COMMIT');
    }catch(error){this.sqlite.exec('ROLLBACK');throw error;}
    if(this.failAfterCommit)throw new Error('injected crash after D1 commit');
    return results;
  }
}
function harness({version=2,status='CONFIRMED',existingVersions=[1,2],syncEnabled=true}={}){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  const dir=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,dir),'utf8'));
  const created='2026-01-01T00:00:00.000Z';
  sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,version) VALUES('exp_fixture','msg_fixture','line_fixture','sanitized fixture',100,'cash','CASH_DRAWER','ingredients','2026-01-01',?,'trace_fixture',?,?)`).run(status,created,version);
  sqlite.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,expense_id,created_at) VALUES('doc_fixture','doc_msg_fixture','line_fixture','RECEIPT',?,'exp_fixture',?)`).run(status,created);
  for(const n of existingVersions)sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES(?,'EXPENSE','exp_fixture',?,'trace_fixture','COMPLETED',1,?)`).run(`old_job_${n}`,n,created);
  const DB=new SqliteD1(sqlite),messages=[];
  const queue={fail:false,async sendBatch(batch){if(this.fail)throw new Error('injected queue failure');messages.push(...batch);}};
  const env={DB,JOB_QUEUE:queue,SHEETS_SYNC_ENABLED:String(syncEnabled),RUNTIME_MODE:'shadow',SHADOW_LINE_OUTPUT:'false'};
  const event={source:{type:'user',userId:'line_fixture'},postback:{data:'a=expense_undo&id=exp_fixture'}};
  const actor={canSubmitExpense:true,employeeId:'staff_fixture'};
  return{sqlite,DB,queue,messages,env,event,actor,async undo(){await handleExpensePostback(env,event,actor);},close(){sqlite.close();}};
}
const row=h=>({...h.sqlite.prepare("SELECT status,version,amount_satang,payment_key,source_wallet,transaction_date FROM expense_events WHERE expense_id='exp_fixture'").get()});
const jobs=h=>h.sqlite.prepare("SELECT entity_version,status FROM sync_jobs WHERE entity_key='exp_fixture' ORDER BY entity_version").all().map(x=>({...x}));
const audits=h=>h.sqlite.prepare("SELECT action,before_json,after_json FROM expense_audit_log WHERE expense_id='exp_fixture'").all().map(x=>({...x}));
const undoMessages=h=>h.messages.map(x=>x.body).filter(x=>x.entityType==='EXPENSE');

test('SQLite: Undo survives an existing COMPLETED version 2 without altering its history',async()=>{
  const h=harness();
  try{
    const before=row(h),oldJobs=JSON.stringify(h.sqlite.prepare('SELECT * FROM sync_jobs ORDER BY job_id').all());
    await h.undo();
    assert.deepEqual(row(h),{...before,status:'CANCELLED',version:3});
    assert.deepEqual(jobs(h),[{entity_version:1,status:'COMPLETED'},{entity_version:2,status:'COMPLETED'},{entity_version:3,status:'PENDING'}]);
    assert.equal(JSON.stringify(h.sqlite.prepare("SELECT * FROM sync_jobs WHERE job_id LIKE 'old_job_%' ORDER BY job_id").all()),oldJobs);
    assert.equal(h.sqlite.prepare("SELECT status FROM expense_documents WHERE document_id='doc_fixture'").get().status,'CANCELLED');
    assert.equal(audits(h).length,1);assert.equal(audits(h)[0].action,'UNDO');
    assert.deepEqual(JSON.parse(audits(h)[0].before_json),{status:'CONFIRMED',version:2});
    assert.deepEqual(JSON.parse(audits(h)[0].after_json),{status:'CANCELLED',version:3});
    assert.deepEqual(undoMessages(h).map(x=>x.entityVersion),[3]);
    assert.ok(await claimSheetSyncJob(h.env,undoMessages(h)[0]));
    assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{h.close();}
});

test('SQLite: allocation exceeds both the Expense version and all old sync versions',async()=>{
  for(const [version,existingVersions,next] of [[1,[1],2],[1,[1,2,7],8],[9,[1,2],10]]){
    const h=harness({version,existingVersions});
    try{await h.undo();assert.equal(row(h).version,next);assert.equal(undoMessages(h)[0].entityVersion,next);}
    finally{h.close();}
  }
});

test('SQLite: simultaneous and duplicate Undo produce one transition, audit and outbox',async()=>{
  const h=harness();
  try{
    await Promise.all([h.undo(),h.undo()]);await h.undo();
    assert.equal(row(h).version,3);assert.equal(audits(h).length,1);
    assert.equal(jobs(h).filter(x=>x.entity_version===3).length,1);assert.equal(undoMessages(h).length,1);
  }finally{h.close();}
});

test('SQLite: failures at each transactional boundary roll back status, audit and outbox together',async()=>{
  for(const failAt of [0,1,2,3,4]){
    const h=harness();
    try{
      const before=row(h),beforeJobs=jobs(h);h.DB.failAt=failAt;
      await assert.rejects(h.undo(),/injected transactional failure/);
      assert.deepEqual(row(h),before);assert.deepEqual(jobs(h),beforeJobs);assert.deepEqual(audits(h),[]);
      assert.equal(h.sqlite.prepare("SELECT status FROM expense_documents WHERE document_id='doc_fixture'").get().status,'CONFIRMED');
      assert.equal(h.messages.length,0);
    }finally{h.close();}
  }
});

test('SQLite: crash after commit leaves a recoverable outbox and retry cannot repeat Undo',async()=>{
  const h=harness();
  try{
    h.DB.failAfterCommit=true;await assert.rejects(h.undo(),/injected crash after D1 commit/);
    assert.equal(row(h).status,'CANCELLED');assert.equal(audits(h).length,1);
    assert.deepEqual(jobs(h).at(-1),{entity_version:3,status:'PENDING'});
    h.DB.failAfterCommit=false;await h.undo();assert.equal(audits(h).length,1);
    h.sqlite.prepare("UPDATE sync_jobs SET updated_at='2026-01-01T00:00:00.000Z' WHERE entity_version=3").run();
    assert.equal(await recoverPendingSheetJobs(h.env),1);
    assert.deepEqual(undoMessages(h).map(x=>x.entityVersion),[3]);
  }finally{h.close();}
});

test('SQLite: queue failure cannot lose the committed Undo or duplicate the business transition',async()=>{
  const h=harness();
  try{
    h.queue.fail=true;await assert.rejects(h.undo(),/injected queue failure/);
    assert.equal(row(h).status,'CANCELLED');assert.equal(audits(h).length,1);
    assert.deepEqual(jobs(h).at(-1),{entity_version:3,status:'PENDING'});
    h.queue.fail=false;await h.undo();assert.equal(audits(h).length,1);
    h.sqlite.prepare("UPDATE sync_jobs SET updated_at='2026-01-01T00:00:00.000Z' WHERE entity_version=3").run();
    assert.equal(await recoverPendingSheetJobs(h.env),1);
  }finally{h.close();}
});

test('SQLite: unauthorized ownership and non-CONFIRMED states do not create Undo effects',async()=>{
  for(const scenario of ['wrong-user','no-permission','WAITING_CONFIRM','CANCELLED']){
    const h=harness({status:['WAITING_CONFIRM','CANCELLED'].includes(scenario)?scenario:'CONFIRMED'});
    try{
      const before=row(h),beforeJobs=jobs(h);
      if(scenario==='wrong-user')h.event.source.userId='other_fixture';
      if(scenario==='no-permission')h.actor.canSubmitExpense=false;
      await h.undo();assert.deepEqual(row(h),before);assert.deepEqual(jobs(h),beforeJobs);assert.deepEqual(audits(h),[]);assert.equal(h.messages.length,0);
    }finally{h.close();}
  }
});

test('SQLite: disabled Sheets sync still atomically preserves the Undo audit without queue writes',async()=>{
  const h=harness({syncEnabled:false});
  try{await h.undo();assert.equal(row(h).status,'CANCELLED');assert.equal(row(h).version,3);assert.equal(audits(h).length,1);assert.equal(jobs(h).length,2);assert.equal(h.messages.length,0);}
  finally{h.close();}
});

test('SQLite: new Undo version updates only its mapped mirrors; partial sink failure is retry-safe',async()=>{
  const h=harness(),writes=[],clears=[];
  const originalWrite=sheetsClient.batchWriteValues,originalClear=sheetsClient.batchClearValues;
  Object.assign(h.env,{SHEET_EXPENSE_RAW:'V52_EXPENSE_RAW',SHEET_EXPENSE_DAILY:'daily_fixture',SHEET_PURCHASE_DETAILS:'details_fixture'});
  for(const [sheet,key,rowNumber] of [['V52_EXPENSE_RAW','exp_fixture',2],['daily_fixture','exp_fixture',10],['details_fixture','exp_fixture|item_fixture',20],['daily_fixture','exp_other',11],['details_fixture','exp_other|item_other',21]])h.sqlite.prepare('INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)').run(sheet,key,rowNumber);
  sheetsClient.batchWriteValues=async(_env,data)=>{writes.push(...data);};
  let failOnce=true;
  sheetsClient.batchClearValues=async(_env,ranges)=>{clears.push(...ranges);if(failOnce){failOnce=false;throw new Error('fixture timeout after clear');}};
  try{
    await h.undo();const job=undoMessages(h)[0];
    await assert.rejects(syncJob(h.env,job),/fixture timeout after clear/);
    assert.equal(row(h).status,'CANCELLED');assert.equal(audits(h).length,1);
    assert.equal(jobs(h).at(-1).status,'FAILED');
    h.sqlite.prepare("UPDATE sync_jobs SET next_attempt_at='2026-01-01T00:00:00.000Z' WHERE entity_version=3").run();
    assert.equal(await syncJob(h.env,job),'PROCESSED');
    const finishedWrites=writes.length,finishedClears=clears.length;
    assert.equal(await syncJob(h.env,job),'IGNORED');
    assert.equal(await syncJob(h.env,{...job,entityVersion:2}),'IGNORED');
    assert.equal(writes.length,finishedWrites);assert.equal(clears.length,finishedClears);
    assert.deepEqual(writes.filter(x=>x.range.includes('V52_EXPENSE_RAW')).map(x=>x.values[0][7]),['CANCELLED','CANCELLED']);
    assert.deepEqual(writes.filter(x=>x.range==="'details_fixture'!Q20").map(x=>x.values),[[['CANCELLED']]]);
    assert.deepEqual([...new Set(clears)],["'daily_fixture'!B10:D10","'daily_fixture'!F10:H10","'daily_fixture'!K10:Q10","'daily_fixture'!V10:W10"]);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM sheet_row_index WHERE sheet_name='daily_fixture' AND entity_key='exp_fixture'").get().n,0);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM sheet_row_index WHERE entity_key IN ('exp_other','exp_other|item_other')").get().n,2);
    assert.equal(audits(h).length,1);assert.equal(row(h).version,3);
  }finally{sheetsClient.batchWriteValues=originalWrite;sheetsClient.batchClearValues=originalClear;h.close();}
});
