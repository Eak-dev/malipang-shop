import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const {handleAdmin}=require('../dist/admin/handler.js');
const {stableRecoveryGateDiagnostic}=require('../dist/sheets/stable-recovery-admission.js');

test('P0-c status is authenticated, aggregate-only and never leaks source identity',async()=>{
 const h=expenseSqlite();try{
  Object.assign(h.env,{
   ADMIN_TOKEN:'x'.repeat(44),STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',
   STABLE_SHEETS_PACING_ENABLED:'true',STABLE_SHEETS_READ_BUDGET_PER_MINUTE:'55',
   GOOGLE_SPREADSHEET_ID:'synthetic-book'
  });
  h.sqlite.prepare("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('synthetic-epoch-00001','synthetic-book','ARMED','EXPENSE','sensitive-expense-id',1,'2026-11-06T00:00:00Z','2026-11-06T00:00:00Z')").run();
  h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,last_error) VALUES('x','EXPENSE','sensitive-expense-id',1,'sensitive-trace','PENDING',3,'2026-11-06T00:00:00Z','STABLE_RECOVERY_GATE_BLOCKED')").run();
  h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,last_error) VALUES('y','DAILY_PAYROLL','sensitive-payroll-id',1,'sensitive-trace-2','PENDING',1,'2026-11-06T00:00:00Z','STABLE_SHEETS_PACING_BLOCKED')").run();
  const unauth=await handleAdmin(new Request('https://example.test/admin/stable-sync/status'),h.env,{});
  assert.equal(unauth.status,401);
  const req=new Request('https://example.test/admin/stable-sync/status',{headers:{authorization:'Bearer '+h.env.ADMIN_TOKEN}});
  const res=await handleAdmin(req,h.env,{});
  assert.equal(res.status,200);
  const body=await res.json();assert.equal(body.ok,true);
  assert.equal(body.recoveryGate.mode,'OPT_IN');
  assert.deepEqual(body.recoveryGate.parked,[{entityType:'EXPENSE',count:1}]);
  assert.equal(body.recoveryGate.targetJobStatus,'PENDING');
  assert.deepEqual(body.recoveryGate.deferredByReason,[{entityType:'DAILY_PAYROLL',reason:'STABLE_SHEETS_PACING_BLOCKED',count:1},{entityType:'EXPENSE',reason:'STABLE_RECOVERY_GATE_BLOCKED',count:1}]);
  assert.equal(body.sheetPacing.mode,'UNARMED');
  assert.equal(body.syncBacklog.some(x=>x.entityType==='EXPENSE'&&x.count===1),true);
  for(const value of ['sensitive-expense-id','sensitive-payroll-id','sensitive-trace','synthetic-epoch-00001',h.env.ADMIN_TOKEN]){
   assert.equal(JSON.stringify(body).includes(value),false);
  }
 }finally{h.close();}
});

test('P0-c diagnostic reports invalid config without revealing ID or throwing',async()=>{
 const h=expenseSqlite();try{
  Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'1',GOOGLE_SPREADSHEET_ID:'book'});
  const result=await stableRecoveryGateDiagnostic(h.env);
  assert.deepEqual(result,{mode:'INVALID_CONFIG'});
 }finally{h.close();}
});

test('admin retry-sync explicitly identifies blocked REVIEW, CANARY and invalid pacing',async()=>{
 const h=expenseSqlite();try{
  Object.assign(h.env,{ADMIN_TOKEN:'k'.repeat(40),GOOGLE_SPREADSHEET_ID:'book',STABLE_PHASE1_ENABLED:'true'});
  const request=()=>new Request('https://example.test/admin/retry-sync',{method:'POST',headers:{authorization:'Bearer '+h.env.ADMIN_TOKEN,'content-type':'application/json'},body:'{}'});
  h.sqlite.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','review','REVIEW','now','now')");
  let r=await handleAdmin(request(),h.env,{});assert.deepEqual((await r.json()).blockedBy,'WORKBOOK_REVIEW');
  h.sqlite.exec("DELETE FROM stable_workbook_claims");
  h.env.STABLE_RECOVERY_GATE_ENABLED='true';h.env.STABLE_SHEETS_PACING_ENABLED='true';
  r=await handleAdmin(request(),h.env,{});assert.equal((await r.json()).blockedBy,'RECOVERY_GATE');
  h.env.STABLE_RECOVERY_GATE_ENABLED='false';h.env.STABLE_SHEETS_PACING_ENABLED='TRUE';
  r=await handleAdmin(request(),h.env,{});assert.equal((await r.json()).blockedBy,'PACING_INVALID_CONFIG');
 }finally{h.close();}
});


test('NH-3: default-on existing stable sync excludes Terminal DLQ, explicit boolean true retains old admin redrive',async()=>{
 const h=expenseSqlite();try{
  Object.assign(h.env,{ADMIN_TOKEN:'k'.repeat(40),GOOGLE_SPREADSHEET_ID:'book',
    STABLE_PHASE1_ENABLED:'true',SHEETS_SYNC_ENABLED:'true'});
  const now='2026-01-01T00:00:00.000Z';
  h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('dlq-job','EXPENSE','synthetic-dlq',1,'trace-dlq','FAILED',3,?)").run(now);
  h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('failed-dlq','malipang-jobs','trace-dlq','EXPENSE:synthetic-dlq:1','{}','DEAD_LETTER_MAX_RETRIES','OPEN',5,?,?)").run(now,now);
  // A completed job must never be re-enqueued, even with explicit opt-in.
  h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('done-job','EXPENSE','synthetic-done',1,'trace-done','COMPLETED',3,?)").run(now);
  h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('failed-done','malipang-jobs','trace-done','EXPENSE:synthetic-done:1','{}','DEAD_LETTER_MAX_RETRIES','OPEN',5,?,?)").run(now,now);
  const endpoint='https://example.test/admin/retry-sync';
  const call=async(body,token=h.env.ADMIN_TOKEN)=>{
    const response=await handleAdmin(new Request(endpoint,{method:'POST',
      headers:{authorization:'Bearer '+token,'content-type':'application/json'},
      body:JSON.stringify(body)}),h.env,{});
    const text=await response.text();
    return {status:response.status,body:text.startsWith('{')?JSON.parse(text):text};
  };
  // Default (all new optional flags absent) must not unexpectedly redrive DLQ.
  assert.deepEqual(await call({}),{status:200,body:{ok:true,enqueued:0}});
  assert.deepEqual(await call({includeTerminalDlq:false}),{status:200,body:{ok:true,enqueued:0}});
  assert.deepEqual(await call({includeTerminalDlq:'true'}),{status:200,body:{ok:true,enqueued:0}});
  assert.equal(h.queue.length,0);
  assert.equal((await call({includeTerminalDlq:true},'invalid-token')).status,401);
  assert.equal(h.queue.length,0);
  const result=await call({includeTerminalDlq:true});
  assert.deepEqual(result,{status:200,body:{ok:true,enqueued:1}});
  assert.equal(h.queue.length,1);
  assert.equal(h.queue[0].body.entityKey,'synthetic-dlq');
  assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_key='synthetic-done'").get().status,'COMPLETED');
  // The D1 durable job is updated only once; a second immediate call is not a replay storm.
  assert.deepEqual(await call({includeTerminalDlq:true}),{status:200,body:{ok:true,enqueued:0}});
  assert.equal(h.queue.length,1);
 }finally{h.close();}
});
