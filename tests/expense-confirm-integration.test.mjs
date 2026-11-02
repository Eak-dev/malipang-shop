import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {confirmExpenseAtomically} from '../dist/expense/confirm.js';
import {undoConfirmedExpense} from '../dist/expense/undo.js';
import {handleExpenseText} from '../dist/expense/service.js';
import {generateDefaultSchedule,overrideShiftSchedule} from '../dist/admin/shift-schedule.js';
import {setEmployeeWage,createFixedOtRequest,finalizeFixedOt} from '../dist/admin/payroll-admin.js';
import {enqueueSheetSync,recoverPendingSheetJobs} from '../dist/db/repositories.js';

class Statement{
  constructor(owner,sql){this.owner=owner;this.sql=sql;this.args=[];}
  bind(...args){this.args=args;return this;}
  async first(){const row=this.owner.sqlite.prepare(this.sql).get(...this.args)??null;if(this.owner.afterFirst)await this.owner.afterFirst(this.sql,this.args,row);return row;}
  async all(){return{results:this.owner.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}};}
  runSync(){
    const statement=this.owner.sqlite.prepare(this.sql);
    if(/^\s*SELECT\b/i.test(this.sql))return{results:statement.all(...this.args),meta:{changes:0}};
    const result=statement.run(...this.args);return{meta:{changes:Number(result.changes)}};
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
const created='2026-01-01T00:00:00.000Z';
const reviewedJson=JSON.stringify({expenseReview:{requiredFields:['payment'],confirmedFields:['payment']}});
function harness({version=1,existingVersions=[],syncEnabled=true,document=true,normalizedJson=reviewedJson,updatedAt=created}={}){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');
  const dir=new URL('../migrations/',import.meta.url);
  for(const name of readdirSync(dir).filter(name=>name.endsWith('.sql')).sort())sqlite.exec(readFileSync(new URL(name,dir),'utf8'));
  const snapshot={description:'sanitized fixture',amountSatang:100,transactionDate:'2026-01-01',paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',version};
  sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at,version)
    VALUES('exp_fixture','msg_fixture','line_fixture',?,?,?,?,?,?,'WAITING_CONFIRM','trace_fixture',?,?)`)
    .run(snapshot.description,snapshot.amountSatang,snapshot.paymentKey,snapshot.sourceWallet,snapshot.category,snapshot.transactionDate,created,version);
  if(document)sqlite.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,expense_id,created_at,normalized_json,updated_at)
    VALUES('doc_fixture','doc_msg_fixture','line_fixture','RECEIPT','WAITING_CONFIRM','exp_fixture',?,?,?)`).run(created,normalizedJson,updatedAt);
  for(const n of existingVersions)sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at)
    VALUES(?,'EXPENSE','exp_fixture',?,'trace_fixture','COMPLETED',1,?)`).run(`old_job_${n}`,n,created);
  const DB=new SqliteD1(sqlite),messages=[];
  const queue={fail:false,async sendBatch(batch){if(this.fail)throw new Error('injected queue failure');messages.push(...batch);}};
  const env={DB,JOB_QUEUE:queue,SHEETS_SYNC_ENABLED:String(syncEnabled)};
  const input={expenseId:'exp_fixture',lineUserId:'line_fixture',traceId:'trace_confirm_fixture',actorEmployeeId:'staff_fixture',branchId:'branch_fixture',snapshot,
    ...(document?{documentSnapshot:{documentId:'doc_fixture',normalizedJson,updatedAt}}:{})};
  return{sqlite,DB,env,input,queue,messages,confirm(){return confirmExpenseAtomically(env,input);},close(){sqlite.close();}};
}
const expense=h=>({...h.sqlite.prepare("SELECT * FROM expense_events WHERE expense_id='exp_fixture'").get()});
const documents=h=>h.sqlite.prepare('SELECT * FROM expense_documents ORDER BY document_id').all().map(row=>({...row}));
const jobs=h=>h.sqlite.prepare('SELECT * FROM sync_jobs ORDER BY entity_version').all().map(row=>({...row}));
const audits=h=>h.sqlite.prepare('SELECT * FROM expense_audit_log ORDER BY created_at,audit_id').all().map(row=>({...row}));
const state=h=>JSON.stringify({expense:expense(h),documents:documents(h),jobs:jobs(h),audits:audits(h)});
const expireOutbox=h=>h.sqlite.prepare("UPDATE sync_jobs SET updated_at=? WHERE status='PENDING'").run(created);

test('SQLite: confirmation atomically records the exact reviewed transition and durable outbox',async()=>{
  const h=harness();
  try{
    const before=expense(h);
    assert.equal(await h.confirm(),1);
    const after=expense(h),audit=audits(h)[0],job=jobs(h)[0];
    assert.deepEqual(after,{...before,status:'CONFIRMED',reviewed_by_employee_id:'staff_fixture',approved_at:after.approved_at,updated_at:after.updated_at});
    assert.ok(after.approved_at);assert.equal(after.approved_at,after.updated_at);
    assert.equal(documents(h)[0].status,'CONFIRMED');assert.equal(documents(h)[0].updated_at,after.updated_at);
    assert.equal(audit.action,'CONFIRM');assert.equal(audit.actor_employee_id,'staff_fixture');
    assert.equal(audit.branch_id,'branch_fixture');assert.equal(audit.document_id,'doc_fixture');
    assert.deepEqual(JSON.parse(audit.before_json),{status:'WAITING_CONFIRM',version:1});
    assert.deepEqual(JSON.parse(audit.after_json),{status:'CONFIRMED',version:1});
    assert.equal(job.entity_version,1);assert.equal(job.status,'PENDING');assert.equal(job.attempt_count,0);
    assert.equal(job.trace_id,h.input.traceId);assert.equal(job.next_attempt_at,after.updated_at);
    assert.equal(job.lease_until,null);assert.equal(job.lease_token,null);assert.equal(h.messages.length,0);
    assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{h.close();}
});

test('SQLite: every batch boundary failure rolls back event, document, audit and outbox together',async()=>{
  for(const failAt of [0,1,2,3,4]){
    const h=harness();
    try{const before=state(h);h.DB.failAt=failAt;await assert.rejects(h.confirm(),/injected transactional failure/);assert.equal(state(h),before);assert.equal(h.messages.length,0);}
    finally{h.close();}
  }
});

test('SQLite: an actual outbox SQL constraint failure rolls the business transition back',async()=>{
  const h=harness();
  try{
    h.sqlite.exec("CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON sync_jobs BEGIN SELECT RAISE(ABORT,'fixture outbox constraint'); END");
    const before=state(h);await assert.rejects(h.confirm(),/fixture outbox constraint/);assert.equal(state(h),before);
  }finally{h.close();}
});

test('SQLite: simultaneous confirmation attempts and later duplicates create one transition',async()=>{
  const h=harness();
  try{
    assert.deepEqual(await Promise.all([h.confirm(),h.confirm()]),[1,null]);
    assert.equal(await h.confirm(),null);assert.equal(audits(h).length,1);assert.equal(jobs(h).length,1);
    assert.equal(expense(h).status,'CONFIRMED');assert.equal(documents(h)[0].status,'CONFIRMED');
  }finally{h.close();}
});

test('SQLite: each stale expense business field and version rejects the whole confirmation',async()=>{
  for(const [column,value] of [['description','changed fixture'],['amount_satang',200],['transaction_date','2026-01-02'],['payment_key','transfer'],['source_wallet','SHOP_BANK'],['category','general'],['version',2]]){
    const h=harness();
    try{h.sqlite.prepare(`UPDATE expense_events SET ${column}=?`).run(value);const before=state(h);assert.equal(await h.confirm(),null);assert.equal(state(h),before);}
    finally{h.close();}
  }
});

test('SQLite: unauthorized ownership and non-draft states cannot confirm or create side effects',async()=>{
  for(const variant of ['wrong-user','CONFIRMED','CANCELLED','missing']){
    const h=harness();
    try{
      if(variant==='wrong-user')h.input.lineUserId='another_fixture';
      else if(variant==='missing')h.input.expenseId='absent_fixture';
      else h.sqlite.prepare('UPDATE expense_events SET status=?').run(variant);
      const before=state(h);assert.equal(await h.confirm(),null);assert.equal(state(h),before);
    }finally{h.close();}
  }
});

test('SQLite: changed, removed, replaced, relinked or nonwaiting review document rejects confirmation',async()=>{
  for(const change of [
    "UPDATE expense_documents SET normalized_json='{}'",
    "UPDATE expense_documents SET updated_at='2026-01-02T00:00:00.000Z'",
    "DELETE FROM expense_documents",
    "UPDATE expense_documents SET document_id='doc_replaced'",
    "UPDATE expense_documents SET expense_id=NULL",
    "UPDATE expense_documents SET line_user_id='another_fixture'",
    "UPDATE expense_documents SET status='CONFIRMED'",
    "UPDATE expense_documents SET status='CANCELLED'"
  ]){
    const h=harness();
    try{h.sqlite.exec(change);const before=state(h);assert.equal(await h.confirm(),null);assert.equal(state(h),before);}
    finally{h.close();}
  }
});

test('SQLite: an extra directly attached document of any status invalidates the one-document snapshot',async()=>{
  for(const status of ['WAITING_CONFIRM','WAITING_REVIEW','CONFIRMED','CANCELLED']){
    const h=harness();
    try{
      h.sqlite.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,expense_id,created_at)
        VALUES('doc_extra','doc_msg_extra','line_fixture','BANK_SLIP',?,'exp_fixture',?)`).run(status,created);
      const before=state(h);assert.equal(await h.confirm(),null);assert.equal(state(h),before);
    }finally{h.close();}
  }
});

test('SQLite: absent document snapshot asserts absence, including a document attached after the read',async()=>{
  const h=harness({document:false});
  try{
    h.sqlite.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,expense_id,created_at)
      VALUES('doc_added','doc_msg_added','line_fixture','RECEIPT','WAITING_CONFIRM','exp_fixture',?)`).run(created);
    const before=state(h);assert.equal(await h.confirm(),null);assert.equal(state(h),before);
  }finally{h.close();}
  const text=harness({document:false});
  try{assert.equal(await text.confirm(),1);assert.equal(documents(text).length,0);assert.equal(audits(text)[0].document_id,null);}
  finally{text.close();}
});

test('SQLite: exact null legacy review JSON and timestamp remain confirmable',async()=>{
  const h=harness({normalizedJson:null,updatedAt:null});
  try{assert.equal(await h.confirm(),1);assert.equal(expense(h).status,'CONFIRMED');}
  finally{h.close();}
});

test('SQLite: supporting linked evidence remains WAITING_REVIEW and is not promoted with the owned document',async()=>{
  const h=harness();
  try{
    h.sqlite.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,expense_id,created_at)
      VALUES('doc_support','doc_msg_support','line_fixture','BANK_SLIP','WAITING_REVIEW',NULL,?)`).run(created);
    h.sqlite.prepare(`INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at)
      VALUES('link_support','exp_fixture','doc_support','PAYMENT_EVIDENCE','EXACT_IDENTIFIER',?)`).run(created);
    const support=documents(h).find(row=>row.document_id==='doc_support');
    assert.equal(await h.confirm(),1);
    assert.deepEqual(documents(h).find(row=>row.document_id==='doc_support'),support);
    assert.equal(documents(h).find(row=>row.document_id==='doc_fixture').status,'CONFIRMED');
  }finally{h.close();}
});

test('SQLite: allocation preserves the draft version or exceeds existing sync history without modifying it',async()=>{
  for(const [version,existingVersions,next] of [[1,[],1],[3,[1,2],3],[1,[1,2,7],8],[9,[1,2],9]]){
    const h=harness({version,existingVersions});
    try{
      const old=jobs(h);assert.equal(await h.confirm(),next);assert.equal(expense(h).version,next);
      assert.deepEqual(jobs(h).filter(job=>job.job_id.startsWith('old_job_')),old);
      assert.equal(jobs(h).at(-1).entity_version,next);assert.equal(jobs(h).at(-1).status,'PENDING');
    }finally{h.close();}
  }
});

test('SQLite: invalid or exhausted versions cannot commit a lossy numeric version',async()=>{
  for(const version of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1]){
    const h=harness();
    try{h.input.snapshot.version=version;const before=state(h);assert.equal(await h.confirm(),null);assert.equal(state(h),before);}
    finally{h.close();}
  }
  const h=harness({existingVersions:[Number.MAX_SAFE_INTEGER]});
  try{const before=state(h);assert.equal(await h.confirm(),null);assert.equal(state(h),before);}
  finally{h.close();}
});

test('SQLite: commit-response loss leaves a recoverable outbox and retry cannot repeat confirmation',async()=>{
  const h=harness();
  try{
    h.DB.failAfterCommit=true;await assert.rejects(h.confirm(),/injected crash after D1 commit/);
    assert.equal(expense(h).status,'CONFIRMED');assert.equal(audits(h).length,1);assert.equal(jobs(h)[0].status,'PENDING');
    h.DB.failAfterCommit=false;assert.equal(await h.confirm(),null);
    expireOutbox(h);assert.equal(await recoverPendingSheetJobs(h.env),1);
    assert.equal(h.messages[0].body.entityVersion,1);assert.equal(audits(h).length,1);assert.equal(jobs(h).length,1);
  }finally{h.close();}
});

test('SQLite: enqueue failure after commit cannot lose the confirmation or its recoverable outbox',async()=>{
  const h=harness();
  try{
    const version=await h.confirm();h.queue.fail=true;
    await assert.rejects(enqueueSheetSync(h.env,{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:h.input.expenseId,entityVersion:version,traceId:h.input.traceId}),/injected queue failure/);
    assert.equal(expense(h).status,'CONFIRMED');assert.equal(jobs(h).length,1);assert.equal(jobs(h)[0].status,'PENDING');
    h.queue.fail=false;assert.equal(await h.confirm(),null);expireOutbox(h);
    assert.equal(await recoverPendingSheetJobs(h.env),1);assert.equal(h.messages.length,1);assert.equal(audits(h).length,1);
  }finally{h.close();}
});

test('SQLite: cancel and confirmation CAS cannot both win the same draft',async()=>{
  for(const cancelFirst of [true,false]){
    const h=harness();
    try{
      const cancel=()=>Number(h.sqlite.prepare("UPDATE expense_events SET status='CANCELLED' WHERE expense_id='exp_fixture' AND status='WAITING_CONFIRM'").run().changes);
      if(cancelFirst){assert.equal(cancel(),1);assert.equal(await h.confirm(),null);assert.equal(audits(h).length,0);assert.equal(jobs(h).length,0);}
      else{assert.equal(await h.confirm(),1);assert.equal(cancel(),0);assert.equal(audits(h).length,1);assert.equal(jobs(h).length,1);}
    }finally{h.close();}
  }
});

test('SQLite: confirmation followed by Undo allocates the next version and preserves both transitions',async()=>{
  const h=harness();
  try{
    assert.equal(await h.confirm(),1);
    assert.equal(await undoConfirmedExpense(h.env,h.input),2);
    assert.equal(expense(h).status,'CANCELLED');assert.equal(expense(h).version,2);
    assert.equal(documents(h)[0].status,'CANCELLED');assert.deepEqual(jobs(h).map(job=>job.entity_version),[1,2]);
    assert.deepEqual(audits(h).map(audit=>audit.action).sort(),['CONFIRM','UNDO']);assert.equal(await h.confirm(),null);
  }finally{h.close();}
});

test('SQLite: disabled sync preserves a confirmation outbox for later recovery',async()=>{
  const h=harness({syncEnabled:false});
  try{assert.equal(await h.confirm(),1);assert.equal(await h.confirm(),null);assert.equal(expense(h).status,'CONFIRMED');assert.equal(documents(h)[0].status,'CONFIRMED');assert.equal(audits(h).length,1);assert.deepEqual(jobs(h).map(job=>[job.entity_version,job.status]),[[1,'PENDING']]);assert.equal(h.messages.length,0);expireOutbox(h);h.env.SHEETS_SYNC_ENABLED='true';assert.equal(await recoverPendingSheetJobs(h.env,0),1);assert.deepEqual(h.messages.map(message=>message.body.entityVersion),[1]);}
  finally{h.close();}
});

test('SQLite: disabled confirmation rolls back when outbox creation fails',async()=>{
  const h=harness({syncEnabled:false});
  try{h.sqlite.exec("CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON sync_jobs BEGIN SELECT RAISE(ABORT,'fixture outbox constraint'); END");const before=state(h);await assert.rejects(h.confirm(),/fixture outbox constraint/);assert.equal(state(h),before);}
  finally{h.close();}
});

test('SQLite: text quick-save is atomic with its audit and recoverable outbox',async()=>{
  const h=harness({syncEnabled:false}),event={source:{type:'user',userId:'line_fixture'},message:{id:'quick_message',type:'text',text:'ไข่ ทอน 375'}};
  h.env.RUNTIME_MODE='shadow';h.env.SHADOW_LINE_OUTPUT='false';
  try{
    assert.equal(await handleExpenseText(h.env,event,'trace_quick'),'CONFIRMED');
    const saved=h.sqlite.prepare(`SELECT expense_id,version,status FROM expense_events WHERE message_id='quick_message'`).get();
    assert.equal(saved.status,'CONFIRMED');assert.equal(saved.version,1);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM expense_audit_log WHERE expense_id=? AND action='CREATE_DRAFT'`).get(saved.expense_id).n,1);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs WHERE entity_key=? AND entity_version=1 AND status='PENDING'`).get(saved.expense_id).n,1);
    assert.equal(h.messages.length,0);
    h.sqlite.prepare(`UPDATE sync_jobs SET updated_at='2000-01-01T00:00:00.000Z',next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity_key=?`).run(saved.expense_id);
    h.env.SHEETS_SYNC_ENABLED='true';assert.equal(await recoverPendingSheetJobs(h.env,0),1);
    assert.equal(h.messages[0].body.entityVersion,1);
    h.sqlite.prepare(`UPDATE expense_events SET version=3 WHERE expense_id=?`).run(saved.expense_id);
    assert.equal(await handleExpenseText(h.env,event,'trace_retry'),'CONFIRMED');
    assert.equal(h.messages.at(-1).body.entityVersion,3);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM expense_events WHERE message_id='quick_message'`).get().n,1);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM expense_audit_log WHERE expense_id=?`).get(saved.expense_id).n,1);
  }finally{h.close();}
});

test('SQLite: quick-save redelivery does not create phantom source revisions',async()=>{
  const h=harness({syncEnabled:false}),event={source:{type:'user',userId:'line_fixture'},message:{id:'quick_replay',type:'text',text:'ไข่ ทอน 375'}};h.env.RUNTIME_MODE='shadow';h.env.SHADOW_LINE_OUTPUT='false';
  try{assert.deepEqual(await Promise.all([handleExpenseText(h.env,event,'trace_a'),handleExpenseText(h.env,event,'trace_b')]),['CONFIRMED','CONFIRMED']);const saved=h.sqlite.prepare("SELECT expense_id FROM expense_events WHERE message_id='quick_replay'").get();const before=h.sqlite.prepare('SELECT revision,state FROM expense_projection_source_revisions WHERE expense_id=?').get(saved.expense_id);const count=h.sqlite.prepare('SELECT count(*) n FROM expense_projection_source_revisions').get().n;assert.equal(await handleExpenseText(h.env,event,'trace_c'),'CONFIRMED');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM expense_events WHERE message_id=?').get('quick_replay').n,1);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM expense_projection_source_revisions').get().n,count);assert.deepEqual(h.sqlite.prepare('SELECT revision,state FROM expense_projection_source_revisions WHERE expense_id=?').get(saved.expense_id),before);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM expense_audit_log WHERE expense_id=?').get(saved.expense_id).n,1);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sync_jobs WHERE entity_key=?').get(saved.expense_id).n,1);}finally{h.close();}
});

test('SQLite: quick-save rolls back the expense and audit if outbox creation fails',async()=>{
  const h=harness(),event={source:{type:'user',userId:'line_fixture'},message:{id:'quick_failure',type:'text',text:'ไข่ ทอน 375'}};
  h.env.RUNTIME_MODE='shadow';h.env.SHADOW_LINE_OUTPUT='false';
  try{
    h.sqlite.exec("CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON sync_jobs BEGIN SELECT RAISE(ABORT,'fixture outbox constraint'); END");
    await assert.rejects(handleExpenseText(h.env,event,'trace_quick'),/fixture outbox constraint/);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM expense_events WHERE message_id='quick_failure'`).get().n,0);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM expense_audit_log`).get().n,0);
  }finally{h.close();}
});

test('SQLite: shift generation and override retain outboxes during a sync pause',async()=>{
  const h=harness({syncEnabled:false});
  try{
    h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('FIX001','Fixture','shift_user_fixture','08:00','17:00','ACTIVE',?)`).run(created);
    const input={employeeIds:['FIX001'],fromDate:'2026-01-02',toDate:'2026-01-02',scheduledIn:'08:00',scheduledOut:'17:00',changedBy:'OWNER',reason:'Fixture'};
    assert.equal((await generateDefaultSchedule(h.env,input)).inserted,1);
    assert.equal((await generateDefaultSchedule(h.env,input)).inserted,0);
    await overrideShiftSchedule(h.env,{employeeId:'FIX001',workDate:'2026-01-02',newStatus:'DAY_OFF',changedBy:'OWNER',reason:'Fixture'});
    const rows=h.sqlite.prepare(`SELECT entity_version,status FROM sync_jobs WHERE entity_type='SHIFT_SCHEDULE' AND entity_key='FIX001|2026-01-02' ORDER BY entity_version`).all();
    assert.deepEqual(rows.map(row=>({...row})),[{entity_version:1,status:'PENDING'},{entity_version:2,status:'PENDING'}]);
    assert.equal(h.messages.length,0);
    h.sqlite.prepare(`UPDATE sync_jobs SET updated_at='2000-01-01T00:00:00.000Z',next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity_type='SHIFT_SCHEDULE'`).run();h.env.SHEETS_SYNC_ENABLED='true';
    assert.equal(await recoverPendingSheetJobs(h.env,0),2);
  }finally{h.close();}
});

test('SQLite: shift generation rolls back row and audit if outbox creation fails',async()=>{
  const h=harness({syncEnabled:false});
  try{
    h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('FIX001','Fixture','shift_user_fixture','08:00','17:00','ACTIVE',?)`).run(created);
    h.sqlite.exec("CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON sync_jobs WHEN NEW.entity_type='SHIFT_SCHEDULE' BEGIN SELECT RAISE(ABORT,'fixture shift outbox failure'); END");
    await assert.rejects(generateDefaultSchedule(h.env,{employeeIds:['FIX001'],fromDate:'2026-01-02',toDate:'2026-01-02',scheduledIn:'08:00',scheduledOut:'17:00',changedBy:'OWNER',reason:'Fixture'}),/fixture shift outbox failure/);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM employee_shift_days WHERE employee_id='FIX001'`).get().n,0);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM shift_schedule_audit WHERE employee_id='FIX001'`).get().n,0);
  }finally{h.close();}
});

test('SQLite: wage source and every changed history row retain outboxes during a sync pause',async()=>{
  const h=harness({syncEnabled:false});
  try{
    h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('FIX001','Fixture','wage_user_fixture','08:00','17:00','ACTIVE',?)`).run(created);
    const first=await setEmployeeWage(h.env,{employeeId:'FIX001',dailyWageBaht:500,effectiveFrom:'2026-01-01',note:'Fixture'});
    const second=await setEmployeeWage(h.env,{employeeId:'FIX001',dailyWageBaht:600,effectiveFrom:'2026-02-01',note:'Fixture'});
    assert.equal(first.version,1);assert.equal(second.version,1);
    const rows=h.sqlite.prepare(`SELECT entity_key,entity_version,status FROM sync_jobs WHERE entity_type='WAGE_HISTORY' ORDER BY entity_key,entity_version`).all().map(row=>({...row}));
    assert.deepEqual(rows,[{entity_key:first.wageId,entity_version:1,status:'PENDING'},{entity_key:first.wageId,entity_version:2,status:'PENDING'},{entity_key:second.wageId,entity_version:1,status:'PENDING'}]);
    assert.equal(h.messages.length,0);
    h.sqlite.prepare(`UPDATE sync_jobs SET updated_at='2000-01-01T00:00:00.000Z',next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity_type='WAGE_HISTORY'`).run();h.env.SHEETS_SYNC_ENABLED='true';
    assert.equal(await recoverPendingSheetJobs(h.env,0),3);
  }finally{h.close();}
});

test('SQLite: wage update rolls back all history and audit writes if its outbox fails',async()=>{
  const h=harness({syncEnabled:false});
  try{
    h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('FIX001','Fixture','wage_user_fixture','08:00','17:00','ACTIVE',?)`).run(created);
    const first=await setEmployeeWage(h.env,{employeeId:'FIX001',dailyWageBaht:500,effectiveFrom:'2026-01-01',note:'Fixture'});
    const before=JSON.stringify(h.sqlite.prepare(`SELECT * FROM employee_wage_history WHERE employee_id='FIX001'`).all());
    h.sqlite.exec("CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON sync_jobs WHEN NEW.entity_type='WAGE_HISTORY' BEGIN SELECT RAISE(ABORT,'fixture wage outbox failure'); END");
    await assert.rejects(setEmployeeWage(h.env,{employeeId:'FIX001',dailyWageBaht:600,effectiveFrom:'2026-02-01',note:'Fixture'}),/fixture wage outbox failure/);
    assert.equal(JSON.stringify(h.sqlite.prepare(`SELECT * FROM employee_wage_history WHERE employee_id='FIX001'`).all()),before);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM admin_audit WHERE action='WAGE_CHANGE'`).get().n,1);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs WHERE entity_type='WAGE_HISTORY' AND entity_key=?`).get(first.wageId).n,1);
  }finally{h.close();}
});

test('SQLite: legacy wage IDs survive a wage update and are used in its outbox and audit',async()=>{
  const h=harness({syncEnabled:false});
  try{
    h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('FIX001','Fixture','wage_user_fixture','08:00','17:00','ACTIVE',?)`).run(created);
    h.sqlite.prepare(`INSERT INTO employee_wage_history VALUES('legacy_wage_fixture','FIX001',50000,'2026-01-01',NULL,'TEST','',1,?,?)`).run(created,created);
    const result=await setEmployeeWage(h.env,{employeeId:'FIX001',dailyWageBaht:600,effectiveFrom:'2026-01-01',note:'Fixture'});
    assert.deepEqual(result,{wageId:'legacy_wage_fixture',version:2});
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs WHERE entity_type='WAGE_HISTORY' AND entity_key='legacy_wage_fixture' AND entity_version=2`).get().n,1);
    assert.equal(h.sqlite.prepare(`SELECT entity_key FROM admin_audit WHERE action='WAGE_CHANGE'`).get().entity_key,'legacy_wage_fixture');
  }finally{h.close();}
});

test('SQLite: OT create and finalization retain outboxes during a sync pause',async()=>{
  const h=harness({syncEnabled:false});
  try{
    h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('FIX001','Fixture','ot_user_fixture','08:00','17:00','ACTIVE',?)`).run(created);
    const ot=await createFixedOtRequest(h.env,{employeeId:'FIX001',workDate:'2026-01-01',reason:'Fixture',fixedAmountBaht:100});
    assert.equal((await finalizeFixedOt(h.env,{otId:ot.otId,approved:false,note:'Fixture'})).version,2);
    assert.deepEqual(h.sqlite.prepare(`SELECT entity_version,status FROM sync_jobs WHERE entity_type='OT_REQUEST' AND entity_key=? ORDER BY entity_version`).all(ot.otId).map(row=>({...row})),[{entity_version:1,status:'PENDING'},{entity_version:2,status:'PENDING'}]);
    assert.equal(h.messages.length,0);
    h.sqlite.prepare(`UPDATE sync_jobs SET updated_at='2000-01-01T00:00:00.000Z',next_attempt_at='2000-01-01T00:00:00.000Z' WHERE entity_type='OT_REQUEST'`).run();h.env.SHEETS_SYNC_ENABLED='true';
    assert.equal(await recoverPendingSheetJobs(h.env,0),2);
  }finally{h.close();}
});

test('SQLite: OT finalization rolls back its audit and source if outbox creation fails',async()=>{
  const h=harness({syncEnabled:false});
  try{
    h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('FIX001','Fixture','ot_user_fixture','08:00','17:00','ACTIVE',?)`).run(created);
    const ot=await createFixedOtRequest(h.env,{employeeId:'FIX001',workDate:'2026-01-01',reason:'Fixture',fixedAmountBaht:100});
    const before=JSON.stringify(h.sqlite.prepare(`SELECT * FROM ot_requests WHERE ot_id=?`).get(ot.otId));
    h.sqlite.exec("CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON sync_jobs WHEN NEW.entity_type='OT_REQUEST' BEGIN SELECT RAISE(ABORT,'fixture OT outbox failure'); END");
    await assert.rejects(finalizeFixedOt(h.env,{otId:ot.otId,approved:false,note:'Fixture'}),/fixture OT outbox failure/);
    assert.equal(JSON.stringify(h.sqlite.prepare(`SELECT * FROM ot_requests WHERE ot_id=?`).get(ot.otId)),before);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM admin_audit WHERE action='OT_FINALIZE'`).get().n,0);
  }finally{h.close();}
});

test('SQLite: a stale OT finalization creates neither an audit nor an outbox',async()=>{
  const h=harness({syncEnabled:false});
  try{
    h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('FIX001','Fixture','ot_user_fixture','08:00','17:00','ACTIVE',?)`).run(created);
    const ot=await createFixedOtRequest(h.env,{employeeId:'FIX001',workDate:'2026-01-01',reason:'Fixture',fixedAmountBaht:100});
    h.DB.afterFirst=async(sql)=>{if(sql.includes('FROM ot_requests o JOIN employees')){h.DB.afterFirst=null;h.sqlite.prepare(`UPDATE ot_requests SET version=2 WHERE ot_id=?`).run(ot.otId);}};
    await assert.rejects(finalizeFixedOt(h.env,{otId:ot.otId,approved:false,note:'Fixture'}),/OT_REQUEST_CHANGED_CONCURRENTLY/);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM admin_audit WHERE action='OT_FINALIZE'`).get().n,0);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs WHERE entity_type='OT_REQUEST' AND entity_key=? AND entity_version=2`).get(ot.otId).n,0);
  }finally{h.close();}
});

test('SQLite: OT creation rolls back its audit and source if outbox creation fails',async()=>{
  const h=harness({syncEnabled:false});
  try{
    h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('FIX001','Fixture','ot_user_fixture','08:00','17:00','ACTIVE',?)`).run(created);
    h.sqlite.exec("CREATE TRIGGER fixture_outbox_failure BEFORE INSERT ON sync_jobs WHEN NEW.entity_type='OT_REQUEST' BEGIN SELECT RAISE(ABORT,'fixture OT outbox failure'); END");
    await assert.rejects(createFixedOtRequest(h.env,{employeeId:'FIX001',workDate:'2026-01-01',reason:'Fixture',fixedAmountBaht:100}),/fixture OT outbox failure/);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM ot_requests WHERE employee_id='FIX001'`).get().n,0);
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM admin_audit WHERE action='OT_PREAPPROVE'`).get().n,0);
  }finally{h.close();}
});
