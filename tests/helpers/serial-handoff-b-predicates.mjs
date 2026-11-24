import assert from 'node:assert/strict';

// Local synthetic D1 only (Issue #348 regression for advanceAttestedHeldPilot).
// Every "fault" below is DIRECT SQL fault injection into the isolated fixture
// database. Whether the same state is reachable through the runtime is UNKNOWN;
// these tests only prove whether the handoff re-checks the predicate that
// holdReservedPilot enforced. They never touch a real barrier or provider.
export const FAULTS=['projection-inflight','projection-review','projection-verified','row-index','failed-job','attempt-count'];
export const BPRED_MODES=['bpred-positive','bpred-ack-before','bpred-ack-after',...['t1','t2'].flatMap(t=>FAULTS.map(f=>`bpred-${t}-${f}`))];
// Not covered (FK or insert-trigger preconditions make a synthetic row non-trivial):
// stable_expense_cancellation_writes, continuous_publication_intents, continuous_normal_notice_handoffs.
// continuous_notice_dispatches: its insert trigger (0046:18) requires a notice handoff and a claim in
// phase END_NOTICE_PENDING, which cannot coexist with the held PILOT_RESERVED claim in this fixture.

async function inject(db,fault,bExpense,pilotId){
 const run=(sql,...args)=>db.prepare(sql).bind(...args).run();
 if(fault.startsWith('projection-')){
  // 0034 rejects rows that do not target the active continuous sheet, so use its ids.
  const cut=await db.prepare("SELECT continuous_sheet_id id,continuous_sheet_name name FROM continuous_daily_cutovers WHERE spreadsheet_id='book' AND state='ACTIVE'").first();
  assert.ok(cut,'fixture has an ACTIVE continuous cutover');
  return run("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE',?,'DAILY',?,?,1,?,'fault-op',?,'now')",bExpense,cut.id,cut.name,'0'.repeat(64),fault.slice('projection-'.length).toUpperCase().replace('INFLIGHT','IN_FLIGHT'));
 }
 if(fault==='row-index')return run("INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('fault-sheet',?,2)",bExpense);
 if(fault==='failed-job')return run("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('fault-failed','malipang-jobs','fault-trace',?,'{}','FAULT','OPEN',1,'now','now')",'EXPENSE:'+bExpense+':1');
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
export async function runBPredicateScenario(mode,{env,att,key,snapshot,advance,pilotId,successorId}){
 const db=env.DB,scenario=mode.slice('bpred-'.length);
 const bExpense=(await one(db,'SELECT entity_key FROM sync_jobs WHERE job_id=?',pilotId)).entity_key;
 const claimToken=(await one(db,"SELECT operation_token t FROM stable_workbook_claims WHERE spreadsheet_id='book'")).t;
 const ctx={pilotId,successorId,snapshot,claimToken};
 const original=db.batch;
 const withBatch=async(wrapper,fn)=>{db.batch=wrapper;try{return await fn();}finally{db.batch=original;}};
 let batchError;
 const call=async()=>{if(!process.env.BPRED_TRACE)return advance(env,att,key,()=>true);const inner=db.batch;db.batch=async x=>{try{return await inner.call(db,x);}catch(error){batchError=error.message;throw error;}};try{return await advance(env,att,key,()=>true);}finally{db.batch=inner;}};

 if(scenario==='positive'){
  const result=await call();assert.equal(result.outcome,'RESERVED',JSON.stringify(result));
  assert.equal((await one(db,'SELECT count(*) n FROM serial_pilot_attested_handoffs')).n,1);
  assert.equal((await one(db,'SELECT state FROM stable_recovery_epochs WHERE epoch_id=?',snapshot.context.predecessorEpochId)).state,'CLOSED');
  assert.equal((await one(db,"SELECT count(*) n FROM stable_recovery_epochs e JOIN sync_jobs j ON j.entity_key=e.target_key WHERE j.job_id=? AND e.epoch_id LIKE 'normal_pilot296_%' AND e.state='ARMED'",successorId)).n,1);
  assert.equal((await one(db,'SELECT count(*) n FROM admin_audit WHERE id=?','issue296:serial:'+pilotId)).n,1);
  assert.equal((await call()).outcome,'RESERVATION_RECORDED','replay never resubmits');
  assert.equal((await one(db,'SELECT count(*) n FROM serial_pilot_attested_handoffs')).n,1);
  return;
 }
 if(scenario==='ack-before'){
  // Throw after submitted=true but before the real batch: nothing committed.
  const result=await withBatch(async()=>{throw Error('SYNTHETIC_ACK_LOST_BEFORE_BATCH');},call);
  assert.equal(result.outcome,'UNCERTAIN',JSON.stringify(result));
  await assertNotAdvanced(db,ctx);
  const retry=await call();assert.equal(retry.outcome,'RESERVED',JSON.stringify(retry));
  assert.equal((await one(db,'SELECT count(*) n FROM serial_pilot_attested_handoffs')).n,1);
  return;
 }
 if(scenario==='ack-after'){
  // Real batch commits, then the acknowledgement is lost.
  const result=await withBatch(async statements=>{await original.call(db,statements);throw Error('SYNTHETIC_ACK_LOST_AFTER_COMMIT');},call);
  assert.equal(result.outcome,'RESERVATION_RECORDED',JSON.stringify(result));
  assert.equal((await one(db,'SELECT count(*) n FROM serial_pilot_attested_handoffs')).n,1);
  assert.equal((await call()).outcome,'RESERVATION_RECORDED');
  assert.equal((await one(db,'SELECT count(*) n FROM serial_pilot_attested_handoffs')).n,1);
  assert.equal((await one(db,'SELECT count(*) n FROM admin_audit WHERE id=?','issue296:serial:'+pilotId)).n,1);
  return;
 }
 const [timing,...rest]=scenario.split('-'),fault=rest.join('-');
 assert.ok(['t1','t2'].includes(timing)&&FAULTS.includes(fault),'unknown scenario '+scenario);
 // Desired behaviour: a B-side row that holdReservedPilot would have refused must
 // also stop the handoff. t1 = before the call (pre-read can see it, outcome HELD
 // if the fix lives there, UNCERTAIN if only in the batch); t2 = injected inside
 // the wrapped db.batch, after the pre-read and signature check (always UNCERTAIN
 // because the batch throws after submitted=true).
 let result;
 if(timing==='t1'){await inject(db,fault,bExpense,pilotId);result=await call();assert.ok(['HELD','UNCERTAIN'].includes(result.outcome),'t1 outcome '+JSON.stringify(result));}
 else{
  let injectError;
  result=await withBatch(async statements=>{try{await inject(db,fault,bExpense,pilotId);}catch(error){injectError=error;throw error;}return original.call(db,statements);},call);
  assert.equal(injectError,undefined,'FIXTURE_INJECTION_FAILED: '+injectError?.message);
  assert.equal(result.outcome,'UNCERTAIN','t2 outcome '+JSON.stringify(result));
 }
 if(process.env.BPRED_TRACE)console.log('BPRED_TRACE',mode,JSON.stringify(result),batchError??'');
 await assertNotAdvanced(db,ctx);
}
