import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const pacing=require('../dist/sheets/stable-sheet-pacing.js');
const worker=require('../dist/index.js').default;

const expense={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:1,traceId:'fixture'};
function dbFixture(){
 const db=new DatabaseSync(':memory:');
 db.exec('CREATE TABLE stable_workbook_claims(spreadsheet_id TEXT PRIMARY KEY,operation_token TEXT NOT NULL UNIQUE,state TEXT NOT NULL,notice_stamp TEXT);');
 db.exec(readFileSync(new URL('../migrations/0023_stable_recovery_admission.sql',import.meta.url),'utf8'));
 const DB={prepare(sql){const q=db.prepare(sql);let args=[];return{bind(...v){args=v;return this;},async all(){return{results:q.all(...args),success:true};},async first(){return q.get(...args)??null;},async run(){return{success:true,meta:{changes:q.run(...args).changes}};}};}};
 return{db,env:{DB,GOOGLE_SPREADSHEET_ID:'synthetic-book',STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'},close(){db.close();}};
}
const claim=(h,token)=>h.db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('synthetic-book',?,'HELD')").run(token);
const release=h=>h.db.exec("DELETE FROM stable_workbook_claims");

test('D1 shared pacing admits only one stage per 75s and reserves 52 read units',async()=>{
 const h=dbFixture();try{
  claim(h,'token-0001');const now=1793930400000;
  assert.equal(await pacing.admitPacedWorkbookOperation(h.env,expense,'token-0001',now),true);
  release(h);claim(h,'token-0002');
  assert.equal(await pacing.admitPacedWorkbookOperation(h.env,expense,'token-0002',now+60_000),false);
  assert.equal(await pacing.admitPacedWorkbookOperation(h.env,expense,'token-0002',now+75_000),true);
  const row=h.db.prepare('SELECT reserved_units,total_admissions,last_admission_ms FROM stable_sheet_pacing').get();
  assert.equal(row.reserved_units,52);
  assert.equal(row.total_admissions,2);
  assert.equal(row.last_admission_ms,now+75_000);
 }finally{h.close();}
});

test('50 simultaneous reservations on one HELD claim cannot exceed pacing budget',async()=>{
 const h=dbFixture();try{
  claim(h,'test-synthetic-token');
  const results=await Promise.all(Array.from({length:50},()=>pacing.admitPacedWorkbookOperation(h.env,expense,'test-synthetic-token',1793930400000)));
  assert.equal(results.filter(Boolean).length,1);
  assert.equal(h.db.prepare('SELECT total_admissions FROM stable_sheet_pacing').get().total_admissions,1);
 }finally{h.close();}
});

test('invalid pacing configuration and missing schema both fail closed',async()=>{
 for(const raw of ['0','61','','TRUE','1.5']){
  const h=dbFixture();try{h.env.STABLE_SHEETS_READ_BUDGET_PER_MINUTE=raw;assert.equal(await pacing.pacingPreflightBlocked(h.env),true);}finally{h.close();}
 }
 const h=dbFixture();try{h.db.exec('DROP TABLE stable_sheet_pacing');assert.equal(await pacing.pacingPreflightBlocked(h.env),true);}finally{h.close();}
});

test('persisted busy backoff uses bounded exponential delay plus deterministic jitter',async()=>{
 const h=dbFixture();try{
  const j={entityType:'EXPENSE',entityKey:'synthetic',entityVersion:1};
  assert.equal(await pacing.persistedStableBusyDelay(h.env,j,()=>0,1793930400000),30);
  assert.equal(await pacing.persistedStableBusyDelay(h.env,j,()=>0,1793930400001),60);
  assert.equal(await pacing.persistedStableBusyDelay(h.env,j,()=>0,1793930400002),120);
  assert.equal(await pacing.persistedStableBusyDelay(h.env,j,()=>0,1793930400003),240);
  assert.equal(await pacing.persistedStableBusyDelay(h.env,j,()=>1,1793930400004),300);
  assert.equal(await pacing.persistedStableBusyDelay(h.env,j,()=>0,1793930400000+700000),30);
 }finally{h.close();}
});

test('paced 10-sheet batch acknowledges all but preserves every durable outbox on REVIEW',async()=>{
 const h=expenseSqlite();try{
  Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});
  h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other','REVIEW','now','now')");
  let acks=0,retries=0;
  const messages=Array.from({length:10},(_,i)=>({
    body:{...expense,entityKey:'exp_'+i},attempts:1,ack(){acks++;},retry(){retries++;}
  }));
  await worker.queue({queue:'malipang-jobs',messages},h.env,{});
  assert.equal(acks,10);assert.equal(retries,0);
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sync_jobs WHERE status=\'PENDING\'').get().n,10);
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM failed_jobs').get().n,0);
 }finally{h.close();}
});

test('a paced mixed LINE and Sheets batch processes LINE and durably parks Sheets',async()=>{
 const h=expenseSqlite(),p=require('../dist/router/process-event.js');
 const prior=p.processInbound;let seen=0,acks=0,retries=0;
 try{
  Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});
  p.processInbound=async()=>{seen++;};
  const jobs=[
   {kind:'LINE_EVENT',event:{},traceId:'line-1',receivedAtIso:'2026-11-06T00:00:00Z'},
   {...expense,entityKey:'exp_1'},{...expense,entityKey:'exp_2'}
  ];
  const messages=jobs.map(body=>({body,attempts:1,ack(){acks++;},retry(){retries++;}}));
  await worker.queue({queue:'malipang-jobs',messages},h.env,{});
  assert.equal(seen,1);assert.equal(acks,3);assert.equal(retries,0);
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM sync_jobs').get().n,2);
 }finally{p.processInbound=prior;h.close();}
});

test('controlled drain recovers at most 4 jobs with staggered schedule',async()=>{
 const h=expenseSqlite();try{
  Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});
  for(let i=0;i<9;i++)h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES(?,'EXPENSE',?,1,?,'PENDING',0,'2026-10-01T00:00:00Z')").run('job'+i,'expense'+i,'fixture'+i);
  const {recoverPendingSheetJobs}=require('../dist/db/repositories.js');
  const recovered=await recoverPendingSheetJobs(h.env,300,false);
  assert.equal(recovered,4);assert.equal(h.queue.length,4);
  assert.deepEqual(h.queue.map(x=>x.delaySeconds||0),[0,90,180,270]);
  const rows=h.sqlite.prepare("SELECT count(*) n FROM sync_jobs WHERE updated_at!='2026-10-01T00:00:00Z'").get();
  assert.equal(rows.n,4);
 }finally{h.close();}
});

test('a verified staged CONTINUE schedules the next stage after pacing delay, not BUSY escalation',async()=>{
 const h=expenseSqlite(),dispatch=require('../dist/sheets/stable-phase1-dispatch.js');
 const prior=dispatch.dispatchStablePhase1;let next=[],ack=0;
 try{
  Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});
  dispatch.dispatchStablePhase1=async()=> 'CONTINUE';
  h.env.JOB_QUEUE.send=async(job,options)=>{next.push({job,options});};
  await worker.queue({queue:'malipang-jobs',messages:[{body:expense,attempts:1,ack(){ack++;},retry(){assert.fail('must not retry original queue message');}}]},h.env,{});
  assert.equal(ack,1);assert.equal(next.length,1);assert.equal(next[0].options.delaySeconds,90);
  assert.deepEqual(next[0].job,expense);
 }finally{dispatch.dispatchStablePhase1=prior;h.close();}
});

function armExactRecovery(h,entityType,entityKey,entityVersion=1){
 h.env.STABLE_RECOVERY_GATE_ENABLED='true';
 h.env.STABLE_SHEETS_PACING_ENABLED='true';
 h.env.STABLE_PHASE1_ENABLED='true';
 h.env.GOOGLE_SPREADSHEET_ID='book';
 h.sqlite.prepare("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('synthetic-canary-epoch-001','book','ARMED',?,?,?,'2026-11-06T00:00:00Z','2026-11-06T00:00:00Z')")
  .run(entityType,entityKey,entityVersion);
}
test('armed canary cron sends exactly its eligible target, not earlier unrelated pending jobs',async()=>{
 const h=expenseSqlite(),{recoverPendingSheetJobs}=require('../dist/db/repositories.js');
 try{
  armExactRecovery(h,'EXPENSE','expense-target',1);
  const rows=[['DAILY_PAYROLL','hr-unrelated'],['EXPENSE','expense-target'],['EXPENSE','expense-other']];
  for(const [type,key] of rows)
   h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES(?,?,?,?,?,'PENDING',0,'2026-11-01T00:00:00Z')")
    .run('job-'+key,type,key,1,'trace-'+key);
  // The fixture's SQLite adapter omits Cloudflare's success:true metadata.
  const originalPrepare=h.env.DB.prepare;h.env.DB.prepare=function(sql){
   const q=originalPrepare.call(this,sql),run=q.run;
   q.run=async function(){return {...await run.call(this),success:true};};return q;
  };
  h.env.JOB_QUEUE.send=async(job)=>h.queue.push({body:job});
  const recovered=await recoverPendingSheetJobs(h.env,300,false);
  assert.equal(recovered,1);assert.equal(h.queue.length,1);
  assert.equal(h.queue[0].body.entityKey,'expense-target');
  assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_key='hr-unrelated'").get().status,'PENDING');
  assert.equal(await recoverPendingSheetJobs(h.env,300,false),0);
 }finally{h.close();}
});
test('canary target is selected even when not the first Sheets message',async()=>{
 const h=expenseSqlite(),dispatch=require('../dist/sheets/stable-phase1-dispatch.js');
 const prev=dispatch.dispatchStablePhase1;const calls=[];let ack=0;
 try{
  armExactRecovery(h,'EXPENSE','exp-target');
  dispatch.dispatchStablePhase1=async(_env,j)=>{calls.push(j.entityKey);return 'BLOCKED';};
  const messages=[
    {body:{...expense,entityKey:'non-target'},attempts:1,ack(){ack++;},retry(){assert.fail('unexpected retry');}},
    {body:{...expense,entityKey:'exp-target'},attempts:1,ack(){ack++;},retry(){assert.fail('unexpected retry');}}
  ];
  await worker.queue({queue:'malipang-jobs',messages},h.env,{});
  assert.deepEqual(calls,['exp-target']);assert.equal(ack,2);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_jobs WHERE entity_key='non-target'").get().n,1);
 }finally{dispatch.dispatchStablePhase1=prev;h.close();}
});
test('mixed LINE and canary batch re-enqueues only target while still processing LINE',async()=>{
 const h=expenseSqlite(),p=require('../dist/router/process-event.js'),dispatch=require('../dist/sheets/stable-phase1-dispatch.js');
 const prev=p.processInbound,oldDispatch=dispatch.dispatchStablePhase1,queued=[];let line=0,ack=0;
 try{
  armExactRecovery(h,'EXPENSE','exp-target');
  p.processInbound=async()=>{line++;};
  dispatch.dispatchStablePhase1=async()=>assert.fail('mixed batch should prioritize LINE');
  h.env.JOB_QUEUE.send=async(job,options)=>queued.push({job,options});
  const messages=[
    {body:{kind:'LINE_EVENT',event:{},receivedAtIso:'2026-11-06T00:00:00Z',traceId:'line-test'},attempts:1,ack(){ack++;},retry(){assert.fail('line retry');}},
    {body:{...expense,entityKey:'exp-target'},attempts:1,ack(){ack++;},retry(){assert.fail('canary retry');}},
    {body:{...expense,entityKey:'exp-other'},attempts:1,ack(){ack++;},retry(){assert.fail('non-target retry');}}
  ];
  await worker.queue({queue:'malipang-jobs',messages},h.env,{});
  assert.equal(line,1);assert.equal(ack,3);assert.equal(queued.length,1);
  assert.equal(queued[0].job.entityKey,'exp-target');assert.equal(queued[0].options.delaySeconds,90);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_jobs WHERE entity_key IN ('exp-target','exp-other')").get().n,2);
 }finally{p.processInbound=prev;dispatch.dispatchStablePhase1=oldDispatch;h.close();}
});
test('staff-config canary cron only sends the exact staff outbox row',async()=>{
 const h=expenseSqlite(),{recoverPendingStaffConfigSyncs}=require('../dist/sheets/staff-config.js');
 try{
  armExactRecovery(h,'STAFF_CONFIG_SYNC','EMP_SYNTH',1);
  for(const key of ['EMP_SYNTH','EMP_OTHER']){
   h.sqlite.prepare("INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,updated_at) VALUES(?,? ,?,'08:00','18:00','2026-11-01T00:00:00Z')").run(key,'Synthetic', 'line-'+key);
   h.sqlite.prepare("INSERT INTO staff_config_sync_outbox(employee_id,version,trace_id,status,attempt_count,created_at,updated_at) VALUES(?,1,?,'PENDING',0,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z')").run(key,'trace-'+key);
  }
  const recovered=await recoverPendingStaffConfigSyncs(h.env);
  assert.equal(recovered,1);assert.equal(h.queue.length,1);
  assert.equal(h.queue[0].body.employeeId,'EMP_SYNTH');
 }finally{h.close();}
});

test('blocked StaffConfig without a durable outbox is retried, never silently ACKed',async()=>{
 const h=expenseSqlite();let acks=0,retries=0;
 try{
  armExactRecovery(h,'EXPENSE','exp-target');
  const message={body:{kind:'STAFF_CONFIG_SYNC',employeeId:'EMP_MISSING',version:1,traceId:'fixture'},
   attempts:1,ack(){acks++;},retry(options){retries++;assert.equal(options.delaySeconds,90);}};
  await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});
  assert.equal(acks,0);assert.equal(retries,1);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs").get().n,0);
 }finally{h.close();}
});
