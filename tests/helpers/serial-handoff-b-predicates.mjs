import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);

// Local synthetic D1 only (Issue #348 regression for advanceAttestedHeldPilot).
// Every "fault" below is DIRECT SQL fault injection into the isolated fixture
// database. Whether the same state is reachable through the runtime is UNKNOWN;
// these tests only prove whether the handoff re-checks the predicate that
// holdReservedPilot enforced. They never touch a real barrier or provider.
export const FAULTS=['projection-inflight','projection-review','projection-verified','projection-child','row-index','row-index-child','failed-job','dlq-producer','dlq-guarded','attempt-count'];
export const BPRED_MODES=['bpred-positive','bpred-unrelated-prefix','bpred-ack-before','bpred-ack-after',...['t1','t2'].flatMap(t=>FAULTS.map(f=>`bpred-${t}-${f}`))];
// Not covered (FK or insert-trigger preconditions make a synthetic row non-trivial):
// stable_expense_cancellation_writes, continuous_publication_intents, continuous_normal_notice_handoffs.
// continuous_notice_dispatches: its insert trigger (0046:18) requires a notice handoff and a claim in
// phase END_NOTICE_PENDING, which cannot coexist with the held PILOT_RESERVED claim in this fixture.

async function inject(env,fault,bExpense,pilotId){
 const db=env.DB;
 const run=(sql,...args)=>db.prepare(sql).bind(...args).run();
 if(fault.startsWith('projection-')){
  // 0034 rejects rows that do not target the active continuous sheet, so use its ids.
  const cut=await db.prepare("SELECT continuous_sheet_id id,continuous_sheet_name name FROM continuous_daily_cutovers WHERE spreadsheet_id='book' AND state='ACTIVE'").first();
  assert.ok(cut,'fixture has an ACTIVE continuous cutover');
  const child=fault==='projection-child';
  return run("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE',?,'DAILY',?,?,1,?,'fault-op',?,'now')",child?bExpense+'|DETAIL':bExpense,cut.id,cut.name,'0'.repeat(64),child?'VERIFIED':fault.slice('projection-'.length).toUpperCase().replace('INFLIGHT','IN_FLIGHT'));
 }
 if(fault==='row-index'||fault==='row-index-child')return run("INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('fault-sheet',?,2)",fault==='row-index-child'?bExpense+'|DETAIL':bExpense);
 if(fault==='failed-job')return run("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('fault-failed','malipang-jobs','fault-trace',?,'{}','FAULT','OPEN',1,'now','now')",'EXPENSE:'+bExpense+':1');
 if(fault==='dlq-producer'||fault==='dlq-guarded'){
  // Reachable producer path: src/index.ts DLQ consumer calls createFailedJob without
  // reading sync_jobs.status, so a late SHEETS_SYNC message for held B is recorded.
  const {createFailedJob}=require('../../dist/db/repositories.js');
  const b=await db.prepare('SELECT trace_id,entity_version FROM sync_jobs WHERE job_id=?').bind(pilotId).first();
  const producerEnv=fault==='dlq-guarded'?{...env,EXPENSE_OUTBOX_SOURCE_GUARD_ENABLED:'true'}:env;
  const produce=()=>createFailedJob(producerEnv,'malipang-jobs',b.trace_id,{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:bExpense,entityVersion:b.entity_version,traceId:b.trace_id},'DEAD_LETTER_MAX_RETRIES');
  // With the existing guarded producer, D1 may persist the row while its
  // acknowledgement is uncertain. This is separate from the handoff outcome.
  if(fault==='dlq-guarded'){
   try{assert.equal(await produce(),'RECORDED');}
   catch(error){assert.match(String(error.message),/EXPENSE_FAILED_JOB_UNCERTAIN/);}
  }else assert.equal(await produce(),'RECORDED');
  assert.equal((await db.prepare('SELECT count(*) n FROM failed_jobs WHERE job_key=?').bind('EXPENSE:'+bExpense+':'+b.entity_version).first()).n,1,'producer wrote the failed job');
  return;
 }
 if(fault==='attempt-count')return run("UPDATE sync_jobs SET attempt_count=1 WHERE job_id=?",pilotId);
 throw Error('unknown fault '+fault);
}

const one=async(db,sql,...args)=>db.prepare(sql).bind(...args).first();

async function assertNotAdvanced(db,{pilotId,successorId,snapshot,claimToken}){
 assert.equal((await one(db,'SELECT count(*) n FROM serial_pilot_attested_handoffs')).n,0,'no handoff row');
 assert.equal((await one(db,'SELECT state FROM stable_recovery_epochs WHERE epoch_id=?',snapshot.context.predecessorEpochId)).state,'ARMED','B epoch stays ARMED');
 const claim=await one(db,"SELECT state,phase,operation_token FROM stable_workbook_claims WHERE spreadsheet_id='book'");
 assert.deepEqual({state:claim.state,phase:claim.phase,token:claim.operation_token},{state:'HELD',phase:'PILOT_RESERVED',token:claimToken},'claim unchanged');
 const b=await one(db,'SELECT status,last_error FROM sync_jobs WHERE job_id=?',pilotId);
 assert.deepEqual(b,{status:'REVIEW',last_error:'SERIAL_PILOT_B_REVIEW'},'B stays held');
 const c=await one(db,'SELECT status,attempt_count,serial_lease_generation g,lease_token FROM sync_jobs WHERE job_id=?',successorId);
 assert.deepEqual(c,{status:'PENDING',attempt_count:0,g:0,lease_token:null},'C untouched');
 assert.equal((await one(db,"SELECT count(*) n FROM admin_audit WHERE id=?",'issue296:serial:'+pilotId)).n,0,'no handoff audit');
 assert.equal((await one(db,"SELECT count(*) n FROM stable_recovery_epochs e JOIN sync_jobs j ON j.entity_key=e.target_key WHERE j.job_id=? AND e.epoch_id LIKE 'normal_pilot296_%'",successorId)).n,0,'no C epoch');
}

/** Runs one scenario inside the existing handoff fixture. Mode names are
 * bpred-positive | bpred-ack-before | bpred-ack-after | bpred-<t1|t2>-<fault>. */
export async function runBPredicateScenario(mode,{env,att,key,snapshot,advance,readContext,roundId,version,pilotId,successorId}){
 const db=env.DB,scenario=mode.slice('bpred-'.length);
 const bExpense=(await one(db,'SELECT entity_key FROM sync_jobs WHERE job_id=?',pilotId)).entity_key;
 const claimToken=(await one(db,"SELECT operation_token t FROM stable_workbook_claims WHERE spreadsheet_id='book'")).t;
 const ctx={pilotId,successorId,snapshot,claimToken};
 const original=db.batch;
 const withBatch=async(wrapper,fn)=>{db.batch=wrapper;try{return await fn();}finally{db.batch=original;}};
 let batchError,batchCalls=0,injecting=false;
 // Counts db.batch submissions per call so a lost/uncertain answer can never be
 // followed by an automatic resend inside advanceAttestedHeldPilot.
 const call=async()=>{batchCalls=0;const inner=db.batch;db.batch=async x=>{if(!injecting)batchCalls++;try{return await inner.call(db,x);}catch(error){batchError=error.message;if(process.env.BPRED_TRACE)console.log('BPRED_BATCH_ERROR',mode,batchError);throw error;}};try{return await advance(env,att,key,()=>true);}finally{db.batch=inner;}};

 if(scenario==='positive'||scenario==='unrelated-prefix'){
  if(scenario==='unrelated-prefix')await inject(env,'row-index',bExpense+'-other',pilotId);
  const result=await call();assert.equal(result.outcome,'RESERVED',JSON.stringify(result));
  assert.equal((await one(db,'SELECT count(*) n FROM serial_pilot_attested_handoffs')).n,1);
  assert.equal((await one(db,'SELECT state FROM stable_recovery_epochs WHERE epoch_id=?',snapshot.context.predecessorEpochId)).state,'CLOSED');
  assert.equal((await one(db,"SELECT count(*) n FROM stable_recovery_epochs e JOIN sync_jobs j ON j.entity_key=e.target_key WHERE j.job_id=? AND e.epoch_id LIKE 'normal_pilot296_%' AND e.state='ARMED'",successorId)).n,1);
  assert.equal((await one(db,'SELECT count(*) n FROM admin_audit WHERE id=?','issue296:serial:'+pilotId)).n,1);
  assert.equal(batchCalls,1,'first call submits once');
  assert.equal((await call()).outcome,'RESERVATION_RECORDED','replay never resubmits');
  assert.equal(batchCalls,0,'replay submits no batch');
  assert.equal((await one(db,'SELECT count(*) n FROM serial_pilot_attested_handoffs')).n,1);
  return;
 }
 if(scenario==='ack-before'){
  // Throw after submitted=true but before the real batch: nothing committed.
  const result=await withBatch(async()=>{throw Error('SYNTHETIC_ACK_LOST_BEFORE_BATCH');},call);
  assert.equal(result.outcome,'UNCERTAIN',JSON.stringify(result));
  assert.equal(batchCalls,1,'no resend after an unknown answer');
  await assertNotAdvanced(db,ctx);
  const retry=await call();assert.equal(retry.outcome,'RESERVED',JSON.stringify(retry));
  assert.equal((await one(db,'SELECT count(*) n FROM serial_pilot_attested_handoffs')).n,1);
  return;
 }
 if(scenario==='ack-after'){
  // Real batch commits, then the acknowledgement is lost.
  const result=await withBatch(async statements=>{await original.call(db,statements);throw Error('SYNTHETIC_ACK_LOST_AFTER_COMMIT');},call);
  assert.equal(result.outcome,'RESERVATION_RECORDED',JSON.stringify(result));
  assert.equal(batchCalls,1,'no resend after an unknown answer');
  assert.equal((await one(db,'SELECT count(*) n FROM serial_pilot_attested_handoffs')).n,1);
  assert.equal((await call()).outcome,'RESERVATION_RECORDED');
  assert.equal(batchCalls,0,'replay submits no batch');
  assert.equal((await one(db,'SELECT count(*) n FROM serial_pilot_attested_handoffs')).n,1);
  assert.equal((await one(db,'SELECT count(*) n FROM admin_audit WHERE id=?','issue296:serial:'+pilotId)).n,1);
  return;
 }
 const [timing,...rest]=scenario.split('-'),fault=rest.join('-');
 assert.ok(['t1','t2'].includes(timing)&&FAULTS.includes(fault),'unknown scenario '+scenario);
 // A B-side row that holdReservedPilot refuses must also stop the handoff.
 // t1 = before the call: the pre-read must see it (context null) and the call
 // returns HELD without ever submitting a batch. t2 = injected inside db.batch,
 // after the pre-read and signature check: the guarded INSERT must reject it, the
 // whole batch rolls back (UNCERTAIN, one submission, nothing committed).
 let result;
 if(timing==='t1'){
  await inject(env,fault,bExpense,pilotId);
  assert.equal(await readContext(env,roundId,pilotId,successorId,version,()=>true),null,'pre-read context must be null');
  result=await call();assert.equal(result.outcome,'HELD','t1 outcome '+JSON.stringify(result));
  assert.equal(batchCalls,0,'t1 submits no batch');
 }else{
  let injectError;
  // createFailedJob may itself use db.batch; let that nested call reach the real one.
  result=await withBatch(async statements=>{if(injecting)return original.call(db,statements);injecting=true;try{await inject(env,fault,bExpense,pilotId);}catch(error){injectError=error;throw error;}finally{injecting=false;}return original.call(db,statements);},call);
  assert.equal(injectError,undefined,'FIXTURE_INJECTION_FAILED: '+injectError?.message);
  assert.equal(result.outcome,'UNCERTAIN','t2 outcome '+JSON.stringify(result));
  assert.equal(batchCalls,1,'t2 submits once and never resends');
 }
 if(process.env.BPRED_TRACE)console.log('BPRED_TRACE',mode,JSON.stringify(result),batchError??'');
 await assertNotAdvanced(db,ctx);
 // A rollback of the handoff must not erase the independently recorded evidence.
 if(fault.startsWith('projection-')){
  const entity=fault==='projection-child'?bExpense+'|DETAIL':bExpense;
  assert.equal((await one(db,"SELECT count(*) n FROM stable_projection_writes WHERE entity_type='EXPENSE' AND entity_id=?",entity)).n,1);
 }else if(fault.startsWith('row-index')){
  const entity=fault==='row-index-child'?bExpense+'|DETAIL':bExpense;
  assert.equal((await one(db,'SELECT count(*) n FROM sheet_row_index WHERE entity_key=?',entity)).n,1);
 }else if(fault==='failed-job'||fault==='dlq-producer'||fault==='dlq-guarded'){
  assert.equal((await one(db,'SELECT count(*) n FROM failed_jobs WHERE job_key=?','EXPENSE:'+bExpense+':1')).n,1);
 }else if(fault==='attempt-count'){
  assert.equal((await one(db,'SELECT attempt_count n FROM sync_jobs WHERE job_id=?',pilotId)).n,1);
 }
}
