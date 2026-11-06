import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {withStableWorkbookClaim}=require('../dist/sheets/stable-workbook-claim.js');
const gate=require('../dist/sheets/stable-recovery-admission.js');
const notice=require('../dist/sheets/stable-edit-notice.js');
const pacing=require('../dist/sheets/stable-sheet-pacing.js');

const expense={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_synthetic',entityVersion:1};
const other={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_other',entityVersion:1};
const hr={kind:'SHEETS_SYNC',entityType:'DAILY_PAYROLL',entityKey:'EMP_TEST|2026-11-06',entityVersion:1};
const epochId='synthetic-epoch-0001';

function fixture({flag='true',schema=true}={}){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('PRAGMA foreign_keys=ON');
 sqlite.exec('CREATE TABLE expense_events(expense_id TEXT PRIMARY KEY); CREATE TABLE owner_personal_transactions(personal_use_id TEXT PRIMARY KEY); CREATE TABLE expense_documents(id TEXT); CREATE TABLE expense_document_links(id TEXT); CREATE TABLE expense_document_items(id TEXT)');
 sqlite.exec(readFileSync(new URL('../migrations/0021_stable_workbook_claim.sql',import.meta.url),'utf8'));
 sqlite.exec(readFileSync(new URL('../migrations/0022_stable_claim_diagnostics.sql',import.meta.url),'utf8'));
 if(schema)sqlite.exec(readFileSync(new URL('../migrations/0023_stable_recovery_admission.sql',import.meta.url),'utf8'));
 sqlite.exec('CREATE TABLE sync_jobs(entity_type TEXT,entity_key TEXT,entity_version INT,status TEXT,last_error TEXT,PRIMARY KEY(entity_type,entity_key,entity_version)); CREATE TABLE staff_config_sync_outbox(employee_id TEXT,version INT,status TEXT,PRIMARY KEY(employee_id,version))');
 const DB={prepare(sql){const q=sqlite.prepare(sql);let args=[];return{bind(...values){args=values;return this;},async first(){return q.get(...args)??null;},async all(){return{success:true,results:q.all(...args)};},async run(){return{success:true,meta:{changes:q.run(...args).changes}};}};}};
 const env={DB,GOOGLE_SPREADSHEET_ID:'test-book',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:flag,STABLE_SHEETS_PACING_ENABLED:flag==='false'?'false':'true'};
 const oldBegin=notice.beginStableNotice,oldEnd=notice.endStableNotice,oldPace=pacing.admitPacedWorkbookOperation,oldPreflight=pacing.pacingPreflightBlocked;
 notice.beginStableNotice=async(_env,_token,_wait,onMutationAuthorized)=>{await onMutationAuthorized?.();};notice.endStableNotice=async()=>{};
 pacing.admitPacedWorkbookOperation=async()=>true;pacing.pacingPreflightBlocked=async()=>false;
 return{sqlite,env,close(){notice.beginStableNotice=oldBegin;notice.endStableNotice=oldEnd;pacing.admitPacedWorkbookOperation=oldPace;pacing.pacingPreflightBlocked=oldPreflight;sqlite.close();}};
}
function arm(h,target=expense,epoch=epochId){
 h.sqlite.prepare("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES(?,'test-book','ARMED',?,?,?,'2026-11-06T01:00:00Z','2026-11-06T01:00:00Z')").run(epoch,target.entityType,target.entityKey,target.entityVersion);
}
const state=h=>h.sqlite.prepare('SELECT state FROM stable_recovery_epochs').get()?.state;
const stageCounts=h=>h.sqlite.prepare("SELECT state,count(*) n FROM stable_recovery_operations GROUP BY state").all().map(x=>({state:x.state,n:x.n}));

test('default-off migration preserves existing workbook behavior',async()=>{
 const h=fixture({flag:'false'});try{let n=0;await withStableWorkbookClaim(h.env,async()=>n++,expense);await withStableWorkbookClaim(h.env,async()=>n++,other);assert.equal(n,2);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_recovery_operations').get().n,0);}finally{h.close();}
});

test('single target continues through DAILY, RAW and FINAL stages, then closes its epoch',async()=>{
 const h=fixture();try{arm(h);let writes=0;
 for(const stage of ['DAILY','RAW','FINAL']){
  const value=await withStableWorkbookClaim(h.env,async()=>{
   writes++;
   if(stage==='FINAL')h.sqlite.prepare("INSERT INTO sync_jobs(entity_type,entity_key,entity_version,status) VALUES('EXPENSE','exp_synthetic',1,'COMPLETED')").run();
   return stage;
  },expense);
  assert.equal(value,stage);
  assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }
 assert.equal(writes,3);assert.equal(state(h),'COMPLETE');assert.deepEqual(stageCounts(h),[{state:'VERIFIED',n:3}]);
 const report=await gate.stableRecoveryGateDiagnostic(h.env);assert.equal(report.state,'COMPLETE');assert.equal(report.admittedStages,3);
 await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('no fourth stage'),expense),/STABLE_RECOVERY_GATE_BLOCKED/);
 }finally{h.close();}
});

test('all other writer identities are blocked without consuming admission',async()=>{
 const h=fixture();try{arm(h);for(const job of [other,hr,undefined,{kind:'STAFF_CONFIG_SYNC',employeeId:'EMP_SYNTH',version:1}]){
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('must not call Sheets'),job),/STABLE_RECOVERY_GATE_BLOCKED/);
 }
 assert.equal(stageCounts(h).length,0);assert.equal(state(h),'ARMED');
 }finally{h.close();}
});

test('50 competing workers cannot hold two workbook claims at once; only one admission',async()=>{
 const h=fixture();try{arm(h);let writes=0;let release=()=>{};const barrier=new Promise(r=>{release=r});
 const messages=Array.from({length:50},(_,i)=>i%5===0?expense:i%5===1?hr:other);
 const pending=messages.map(job=>withStableWorkbookClaim(h.env,async()=>{writes++;await barrier;},job));
 const settled=Promise.allSettled(pending);
 await new Promise(resolve=>setImmediate(resolve));release();
 const all=await settled;
 assert.equal(all.filter(x=>x.status==='fulfilled').length,1);
 assert.equal(writes,1);assert.deepEqual(stageCounts(h),[{state:'VERIFIED',n:1}]);
 }finally{h.close();}
});

test('uncertain provider outcome leaves ADMITTED durable and workbook REVIEW',async()=>{
 const h=fixture();try{arm(h);
 await assert.rejects(withStableWorkbookClaim(h.env,async()=>{throw Error('UNKNOWN_PROVIDER_WRITE')},expense));
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 assert.deepEqual(stageCounts(h),[{state:'ADMITTED',n:1}]);
 await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('must not retry'),expense));
 }finally{h.close();}
});

test('lost D1 admission acknowledgement is preserved as REVIEW not automatically refunded',async()=>{
 const h=fixture();try{arm(h);
 const original=h.env.DB.prepare;let once=true;
 h.env.DB.prepare=function(sql){
  const a=original.call(this,sql),run=a.run;
  a.run=async function(){const res=await run.call(this);if(once&&sql.includes('INSERT INTO stable_recovery_operations')){once=false;throw Error('lost admission ack');}return res;};return a;
 };
 await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('no Sheets'),expense),/lost admission ack/);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 assert.deepEqual(stageCounts(h),[{state:'ADMITTED',n:1}]);
 }finally{h.close();}
});

test('missing schema, absent epoch, invalid gate config all fail closed',async()=>{
 for(const config of [{schema:false,flag:'true'},{schema:true,flag:'true'},{schema:true,flag:''},{schema:true,flag:'TRUE'},{schema:true,flag:'1'}]){
  const h=fixture(config);try{let n=0;await assert.rejects(withStableWorkbookClaim(h.env,async()=>n++,expense));assert.equal(n,0);}finally{h.close();}
 }
});

test('historical epochs and operations are immutable and cannot re-arm spent epoch',()=>{
 const h=fixture();try{arm(h);const q=h.sqlite;
 q.prepare("UPDATE stable_recovery_epochs SET state='COMPLETE',updated_at='now' WHERE epoch_id=?").run(epochId);
 assert.throws(()=>q.prepare("UPDATE stable_recovery_epochs SET state='ARMED',updated_at='again' WHERE epoch_id=?").run(epochId));
 assert.throws(()=>q.prepare("UPDATE stable_recovery_epochs SET epoch_id='different',updated_at='again' WHERE epoch_id=?").run(epochId));
 assert.throws(()=>q.prepare("DELETE FROM stable_recovery_epochs WHERE epoch_id=?").run(epochId));
 arm(h,other,'synthetic-epoch-0002');
 assert.equal(q.prepare("SELECT count(*) n FROM stable_recovery_epochs").get().n,2);
 assert.throws(()=>arm(h,hr,'synthetic-epoch-0003'));
 }finally{h.close();}
});

test('diagnostics redact target key, epoch ID and operation token',async()=>{
 const h=fixture();try{arm(h);await withStableWorkbookClaim(h.env,async()=>{},expense);
 const d=await gate.stableRecoveryGateDiagnostic(h.env);
 assert.equal(d.mode,'OPT_IN');assert.equal(d.admittedStages,1);assert.equal(d.unverifiedStages,0);
 const text=JSON.stringify(d);
 for(const forbidden of ['exp_synthetic',epochId,'operation_token','test-book'])assert.equal(text.includes(forbidden),false);
 }finally{h.close();}
});

test('migration is repeatable and keeps preexisting REVIEW workbook claim',()=>{
 const h=fixture({schema:false});try{
 h.sqlite.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('test-book','synthetic-token','REVIEW','old','old')").run();
 const migration=readFileSync(new URL('../migrations/0023_stable_recovery_admission.sql',import.meta.url),'utf8');
 h.sqlite.exec(migration);h.sqlite.exec(migration);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims").get().state,'REVIEW');
 assert.equal(h.sqlite.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
 assert.equal(h.sqlite.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{h.close();}
});

test('gate refuses to arm unless stable pacing is also enabled',async()=>{
 const h=fixture();try{arm(h);h.env.STABLE_SHEETS_PACING_ENABLED='false';
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('no provider write'),expense),/STABLE_RECOVERY_GATE_BLOCKED/);
  assert.equal(stageCounts(h).length,0);
 }finally{h.close();}
});

test('capacity-review callback cannot be misreported as a verified financial stage',async()=>{
 const h=fixture();try{
  arm(h);
  const outcome=await withStableWorkbookClaim(h.env,async()=>{
   h.sqlite.prepare("INSERT INTO sync_jobs(entity_type,entity_key,entity_version,status,last_error) VALUES('EXPENSE','exp_synthetic',1,'REVIEW','STABLE_DAILY_CAPACITY')").run();
   return 'CAPACITY_REVIEW';
  },expense);
  assert.equal(outcome,'CAPACITY_REVIEW');
  assert.equal(state(h),'REVIEW');
  assert.deepEqual(stageCounts(h),[{state:'ADMITTED',n:1}]);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM stable_workbook_claims').get().n,0);
  await assert.rejects(withStableWorkbookClaim(h.env,async()=>assert.fail('do not write'),expense),/STABLE_RECOVERY_GATE_BLOCKED/);
 }finally{h.close();}
});
