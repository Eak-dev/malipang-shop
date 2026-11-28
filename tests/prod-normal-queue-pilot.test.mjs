import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pilotInputs,runNormalPilot as runPilot,summarize,describeResult} from '../scripts/prod-normal-queue-pilot.mjs';
// Unit fixtures explicitly inject a synthetic identity; durable filesystem behavior is tested separately.
const runNormalPilot=(input,fetcher,sleep,coordinator,store)=>{if(input.PILOT_PHASE==='RUN_SERIAL'&&input.PILOT_ROUND_MODE==='true'){input.PILOT_LOCAL_IDENTITY='true';input.MALIPANG_WORKER_URL='https://localhost/';store??={claim:async()=>({state:'FRESH',roundId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'})};}return runPilot(input,fetcher,sleep,coordinator,store);};

const version='01234567-89ab-cdef-0123-456789abcdef', sha='a'.repeat(40);
const env={GITHUB_SHA:sha,EXPECTED_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',
  PILOT_PHASE:'PROBE',EXPECTED_WORKER_VERSION_SHA256:createHash('sha256').update(version).digest('hex'),
  CLOUDFLARE_API_TOKEN:'cf-test',CLOUDFLARE_ACCOUNT_ID:'synthetic',MALIPANG_ADMIN_TOKEN:'admin-test',
  MALIPANG_WORKER_URL:'https://worker.invalid'};
const fingerprint='b'.repeat(64),preimageDigest='c'.repeat(64),jobId='12345678-1234-1234-1234-123456789abc';
const gates={BACKUP_RUN_ID:'123',GITHUB_TOKEN:'gh-test',EXTERNAL_WRITERS_FENCED:'true',OWNER_SUPERVISING:'true'};

function provider({state='IN_FLIGHT',rows=[],outcome='MATCHED',missingAck=false,committed=false,statuses=['JOB_COMPLETE'],finishProofs=[preimageDigest]}={}){
  const calls=[];
  const reply=(data,status=200)=>Response.json(data,{status});
  const request=async(input,opts)=>{
    const url=String(input);
    if(url.includes('/deployments?'))return reply({success:true,result:{deployments:[{versions:[{version_id:version,percentage:100}]}]}});
    if(url.includes('/d1/database/')){
      const {sql}=JSON.parse(opts.body);
      assert.match(sql,/^SELECT /);
      const results=sql.includes('AS predecessor')?rows.map(r=>({...r,action:'ISSUE296_PAUSED_NOTICE_HANDOVER',book:'book',version})):rows;
      return reply({success:true,result:[{success:true,results}]});
    }
    if(url.includes('/actions/runs/')){
      const job={name:'ops',id:1234,status:'completed',conclusion:'success',steps:[{name:'Backup and migration rehearsal',conclusion:'success'}]};
      return reply(url.includes('/jobs?')?{jobs:[job]}:{path:'.github/workflows/prod-ops-readonly.yml',event:'workflow_dispatch',status:'completed',conclusion:'success',head_sha:sha,created_at:new Date().toISOString()});
    }
    if(url.endsWith('/jobs/1234/logs'))return new Response(null,{status:302,headers:{location:'https://log.invalid/download'}});
    if(url==='https://log.invalid/download')return new Response(['export','backup_upload','backup_checksum','restore','integrity_before','foreign_keys_before','preexisting_rows_unchanged','integrity_after','foreign_keys_after','smoke_all'].map(k=>'- '+k+': PASS').join('\n'));
    assert.equal(new URL(url).origin,env.MALIPANG_WORKER_URL);
    const body=JSON.parse(opts.body);
    calls.push(body);
    assert.equal(opts.headers['x-malipang-expected-worker-version'],version);
    if(body.action==='INSPECT')return reply({ok:true,outcome:'INSPECTED',fingerprint,projectionState:state,preimageDigest:state==='VERIFIED'?preimageDigest:null,servedVersion:version});
    if(missingAck&&['SETTLE','HANDOVER_ONE'].includes(body.action)){
      if(committed&&body.action==='SETTLE')state='VERIFIED';
      throw Error('sensitive test value');
    }
    const results={PROBE:'MATCHED',SETTLE:'SETTLED',HANDOVER_ONE:'RESERVED',INSPECT_HANDOVER:'ADOPTED',READBACK:outcome,
      FINISH_STATUS:body.action==='FINISH_STATUS'&&statuses.length>1?statuses.shift():statuses[0]};
    const proof=body.action==='FINISH_STATUS'&&results.FINISH_STATUS==='JOB_COMPLETE'
      ?(finishProofs.length>1?finishProofs.shift():finishProofs[0]):undefined;
    return reply({ok:true,outcome:results[body.action],proof,fingerprint,preimageDigest,servedVersion:version});
  };
  return {calls,request};
}

test('mutation requires verified backup, correct revision, first attempt and active owner fence',()=>{
  for(const phase of ['SETTLE','HANDOVER_ONE','RUN_SERIAL']){
    const ok={...env,...gates,PILOT_PHASE:phase};
    assert.equal(pilotInputs(ok).phase,phase);
    for(const partial of [{OWNER_SUPERVISING:'false'},{EXTERNAL_WRITERS_FENCED:'false'},{BACKUP_RUN_ID:''},{EXPECTED_SHA:'d'.repeat(40)},{GITHUB_RUN_ATTEMPT:'2'}]){
      assert.throws(()=>pilotInputs({...ok,...partial}),/PILOT_/);
    }
  }
});

test('probe and final readback only succeed against their pinned exact receipts',async()=>{
  const p=provider();
  assert.equal(await runNormalPilot(env,p.request),'PILOT_ORIGINAL_MATCHED');
  assert.deepEqual(p.calls.map(c=>c.action),['INSPECT','PROBE']);
  assert.equal(await runNormalPilot({...env,PILOT_PHASE:'READBACK'},p.request),'PILOT_DAILY_D1_MATCHED');
  await assert.rejects(runNormalPilot({...env,PILOT_PHASE:'READBACK'},provider({outcome:'UNVERIFIED'}).request),/PILOT_RESULT_UNVERIFIED/);
});

test('protected runner admits one private candidate, never retries or falls through on uncertainty',async()=>{
  const phase={...env,...gates,PILOT_PHASE:'HANDOVER_ONE'};
  const p=provider({state:'VERIFIED',rows:[{job_id:jobId}]});
  assert.equal(await runNormalPilot(phase,p.request),'PILOT_JOB_COMPLETE_DAILY_MATCHED');
  assert.deepEqual(p.calls.map(c=>c.action),['INSPECT','HANDOVER_ONE','FINISH_STATUS','READBACK','FINISH_STATUS']);
  assert.deepEqual(p.calls[1],{action:'HANDOVER_ONE',fingerprint,preimageDigest,jobId,ownerSupervising:true,externalWritersFenced:true});
  for(const [step,state] of [['SETTLE','IN_FLIGHT'],['HANDOVER_ONE','VERIFIED']]){
    const lost=provider({missingAck:true,state,rows:[{job_id:jobId}]});
    await assert.rejects(runNormalPilot({...phase,PILOT_PHASE:step},lost.request),/PILOT_RESPONSE_UNKNOWN_NO_RETRY/);
    assert.equal(lost.calls.filter(c=>c.action===step).length,1);
  }
  const held=provider();
  await assert.rejects(runNormalPilot(phase,held.request),/PILOT_ORIGINAL_UNVERIFIED/);
  assert.deepEqual(held.calls.map(c=>c.action),['INSPECT']);
});

test('missing write responses reconcile exact old and pilot evidence without re-dispatch',async()=>{
  const original=provider({missingAck:true,committed:true});
  assert.equal(await runNormalPilot({...env,...gates,PILOT_PHASE:'SETTLE'},original.request),'PILOT_ORIGINAL_SETTLED_JOB_HELD');
  assert.deepEqual(original.calls.map(c=>c.action),['INSPECT','PROBE','SETTLE','INSPECT']);
  const pilot=provider({missingAck:true,state:'VERIFIED',rows:[{job_id:jobId,fingerprint}]});
  assert.equal(await runNormalPilot({...env,...gates,PILOT_PHASE:'HANDOVER_ONE'},pilot.request),'PILOT_JOB_COMPLETE_DAILY_MATCHED');
  assert.equal(pilot.calls.filter(c=>c.action==='HANDOVER_ONE').length,1);
});

test('bounded read-only finish reconciles both endpoints and classifies held and uncertain runs',async()=>{
  const phase={...env,PILOT_PHASE:'FINISH_PILOT'},rows=[{job_id:jobId,fingerprint}];
  for(const [statuses,outcome,expected] of [
    [['IN_PROGRESS','JOB_COMPLETE'],'MATCHED','PILOT_JOB_COMPLETE_DAILY_MATCHED'],
    [['JOB_REVIEW'],'MATCHED','PILOT_JOB_REVIEW_DAILY_MATCHED'],
    [['JOB_FAILED'],'UNVERIFIED','PILOT_JOB_FAILED_DAILY_UNVERIFIED'],
    [['JOB_COMPLETE','JOB_REVIEW'],'MATCHED','PILOT_FINAL_STATE_CHANGED'],
    [['JOB_COMPLETE'],'UNVERIFIED','PILOT_JOB_COMPLETE_DAILY_UNVERIFIED'],
    [['IN_PROGRESS'],'MATCHED','PILOT_OBSERVATION_TIMEOUT_IN_PROGRESS'],
    [['NOT_STARTED'],'MATCHED','PILOT_FINISH_NOT_STARTED'],
  ]){
    let waits=0;
    const p=provider({rows,statuses:[...statuses],outcome}),run=runNormalPilot(phase,p.request,async ms=>{assert.equal(ms,60000);waits++;});
    if(expected==='PILOT_JOB_COMPLETE_DAILY_MATCHED')assert.equal(await run,expected);
    else await assert.rejects(run,{message:expected});
    assert.equal(waits,expected.includes('TIMEOUT')?15:statuses[0]==='IN_PROGRESS'?1:0);
    assert.ok(p.calls.every(c=>['FINISH_STATUS','READBACK'].includes(c.action)));
  }
  const absent=provider();
  await assert.rejects(runNormalPilot(phase,absent.request),/PILOT_FINISH_NOT_STARTED/);
  assert.equal(absent.calls.length,0);
  const drift=provider({rows,finishProofs:['d'.repeat(64),'e'.repeat(64)]});
  await assert.rejects(runNormalPilot(phase,drift.request),/PILOT_FINAL_STATE_CHANGED/);
  const missing=provider({rows,finishProofs:[]});
  await assert.rejects(runNormalPilot(phase,missing.request),/PILOT_FINAL_PROOF_UNVERIFIED/);
  assert.deepEqual(missing.calls.map(c=>c.action),['FINISH_STATUS']);
});

test('inspect reads the audit before consulting the Worker and never selects a new candidate',async()=>{
  const phase={...env,PILOT_PHASE:'INSPECT_HANDOVER'};
  const empty=provider();
  assert.equal(await runNormalPilot(phase,empty.request),'PILOT_NO_HANDOVER_RECORDED');
  assert.deepEqual(empty.calls,[]);
  const p=provider({rows:[{job_id:jobId,fingerprint}]});
  assert.equal(await runNormalPilot(phase,p.request),'PILOT_ADOPTED');
  assert.deepEqual(p.calls,[{action:'INSPECT_HANDOVER',jobId,fingerprint}]);
});

const nextId='22345678-1234-1234-1234-123456789abc',laterId='32345678-1234-1234-1234-123456789abc';
const serialEnv={...env,...gates,PILOT_PHASE:'RUN_SERIAL'};

function serialHarness(t,{selected=[jobId,nextId],chain=[],fail=()=>{}}={}){
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.exec(`CREATE TABLE sync_jobs(job_id,entity_key,entity_type,entity_version,status,attempt_count,lease_token,lease_until,next_attempt_at,updated_at);
    CREATE TABLE expense_events(expense_id,version,status,transaction_date);
    CREATE TABLE continuous_daily_cutovers(spreadsheet_id,state);
    CREATE TABLE continuous_daily_post_cutover_expenses(spreadsheet_id,expense_id);
    CREATE TABLE admin_audit(id,action,entity_key,reason,before_json,after_json);
    INSERT INTO continuous_daily_cutovers VALUES('test-book','ACTIVE')`);
  function add(id){
    db.prepare("INSERT INTO sync_jobs VALUES(?,?,'EXPENSE',1,'PENDING',0,NULL,NULL,NULL,?)").run(id,id,id);
    db.prepare("INSERT INTO expense_events VALUES(?,1,'CONFIRMED',date('now','+7 hours'))").run(id);
    db.prepare("INSERT INTO continuous_daily_post_cutover_expenses VALUES('test-book',?)").run(id);
  }
  const proofFor=id=>createHash('sha256').update(id).digest('hex');
  function record(id,previous,proof=proofFor(previous??id),roundId){
    db.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?)').run(
      previous?'issue296:serial:'+previous:'issue296:parked:synthetic',
      previous?'ISSUE296_SERIAL_EXPENSE_HANDOVER':'ISSUE296_PAUSED_NOTICE_HANDOVER',
      id,fingerprint,JSON.stringify({book:'test-book',predecessorJobId:previous,proof}),JSON.stringify({version,...(roundId?{roundId}:{})}));
  }
  selected.forEach(add);
  chain.forEach((id,index)=>record(id,chain[index-1]));
  const actions=[],base=provider(),serving=(body,outcome,more={})=>Response.json({ok:true,outcome,servedVersion:version,...more});
  const request=async(url,opts)=>{
    if(String(url).includes('/d1/database/')){
      const {sql}=JSON.parse(opts.body);
      assert.match(sql,/^SELECT /);
      return Response.json({success:true,result:[{success:true,results:db.prepare(sql).all()}]});
    }
    if(!String(url).startsWith(env.MALIPANG_WORKER_URL)&&!String(url).startsWith('https://localhost'))return base.request(url,opts);
    const body=JSON.parse(opts.body);actions.push(body);
    const substitute=fail(body,{db,record,add,actions,serving,proofFor});
    if(substitute)return substitute;
    switch(body.action){
      case 'INSPECT':return serving(body,'INSPECTED',{fingerprint,projectionState:'IN_FLIGHT',preimageDigest:null});
      case 'PROBE':return serving(body,'MATCHED',{fingerprint,preimageDigest});
      case 'SETTLE':return serving(body,'SETTLED',{fingerprint,preimageDigest});
      case 'HANDOVER_ONE':record(body.jobId);return serving(body,'RESERVED');
      case 'FINISH_STATUS':return serving(body,'JOB_COMPLETE',{proof:proofFor(body.jobId)});
      case 'RECORD_VERIFIED':return serving(body,'RECORDED');
      case 'READBACK':return serving(body,'MATCHED');
      case 'ADVANCE_ONE':
        assert.equal(body.proof,proofFor(body.jobId));
        record(body.nextJobId,body.jobId,body.proof);return serving(body,'RESERVED');
      default:assert.fail('Unexpected worker action');
    }
  };
  return {actions,request,db};
}

test('serial run settles A, finishes B then C against their exact rows and does not adopt new arrivals',async t=>{
  const p=serialHarness(t,{fail(body,{add}){
    if(body.action==='HANDOVER_ONE')add(laterId);
  }});
  assert.deepEqual(await runNormalPilot(serialEnv,p.request),{outcome:'PILOT_SERIAL_FINISHED',verified:2,remaining:0});
  assert.deepEqual(p.actions.map(x=>x.action),['INSPECT','PROBE','SETTLE','HANDOVER_ONE',
    'FINISH_STATUS','READBACK','FINISH_STATUS','ADVANCE_ONE','FINISH_STATUS','READBACK','FINISH_STATUS']);
  assert.deepEqual(p.actions.filter(x=>x.action==='READBACK'),
    [jobId,nextId].map(id=>({action:'READBACK',jobId:id,fingerprint})));
  assert.deepEqual(p.actions[7],{action:'ADVANCE_ONE',jobId,fingerprint,proof:createHash('sha256').update(jobId).digest('hex'),
    nextJobId:nextId,externalWritersFenced:true,ownerSupervising:true});
});

test('uncertain B prevents C reservation and retains exact partial counts',async t=>{
  const p=serialHarness(t,{chain:[jobId],fail(body,{serving}){
    if(body.action==='READBACK')return serving(body,'UNVERIFIED');
  }});
  await assert.rejects(runNormalPilot(serialEnv,p.request),{message:'PILOT_JOB_COMPLETE_DAILY_UNVERIFIED',serialProgress:{verified:0,remaining:2}});
  assert.deepEqual(p.actions.map(x=>x.action),['FINISH_STATUS','READBACK']);
});

test('serial advance lost response checks exact committed edge without resending',async t=>{
  for(const mode of ['confirmed','wrong-proof','absent']){
    const p=serialHarness(t,{chain:[jobId],fail(body,{record}){
      if(body.action==='ADVANCE_ONE'){
        if(mode!=='absent')record(body.nextJobId,body.jobId,mode==='confirmed'?body.proof:'f'.repeat(64));
        throw Error('simulated lost response');
      }
    }});
    const run=runNormalPilot(serialEnv,p.request);
    if(mode==='confirmed')assert.deepEqual(await run,{outcome:'PILOT_SERIAL_FINISHED',verified:2,remaining:0});
    else await assert.rejects(run,{message:'PILOT_RESPONSE_UNKNOWN_NO_RETRY',serialProgress:{verified:1,remaining:1}});
    assert.equal(p.actions.filter(body=>body.action==='ADVANCE_ONE').length,1);
  }
});

test('serial resume always verifies durable tip even when there are no new eligible jobs',async t=>{
  const p=serialHarness(t,{selected:[],chain:[jobId,nextId]});
  assert.deepEqual(await runNormalPilot(serialEnv,p.request),{outcome:'PILOT_SERIAL_FINISHED',verified:1,remaining:0});
  assert.deepEqual(p.actions.map(x=>[x.action,x.jobId]),[['FINISH_STATUS',nextId],['READBACK',nextId],['FINISH_STATUS',nextId]]);
  const readonly=serialHarness(t,{selected:[],chain:[jobId,nextId]});
  assert.equal(await runNormalPilot({...env,PILOT_PHASE:'FINISH_PILOT'},readonly.request),'PILOT_JOB_COMPLETE_DAILY_MATCHED');
  assert.deepEqual(readonly.actions.map(x=>[x.action,x.jobId]),[['FINISH_STATUS',nextId],['READBACK',nextId],['FINISH_STATUS',nextId]]);
  const empty=serialHarness(t,{selected:[]});
  assert.deepEqual(await runNormalPilot(serialEnv,empty.request),{outcome:'PILOT_SERIAL_FINISHED',verified:0,remaining:0});
  assert.deepEqual(empty.actions,[]);
});

test('corrupt or disconnected serial audit fails before a new reservation',async t=>{
  const p=serialHarness(t,{chain:[jobId,nextId]});
  p.db.exec("UPDATE admin_audit SET before_json=json_set(before_json,'$.predecessorJobId','invalid') WHERE action='ISSUE296_SERIAL_EXPENSE_HANDOVER'");
  await assert.rejects(runNormalPilot(serialEnv,p.request),/PILOT_SERIAL_CHAIN_UNVERIFIED/);
  assert.deepEqual(p.actions,[]);
});

test('round recovery reads the durable close without issuing a new write',async()=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',base=provider(),actions=[];
 const phase={...env,...gates,PILOT_PHASE:'RECOVER_ROUND',PILOT_ROUND_ID:roundId};
 assert.throws(()=>pilotInputs({...phase,PILOT_ROUND_ID:'wrong'}),/PILOT_INPUT_INVALID/);
 const fetcher=async(url,opts)=>{
  if(!String(url).endsWith('/serial-round-recovery'))return base.request(url,opts);
  const body=JSON.parse(opts.body);actions.push(body.action);assert.equal(body.roundId,roundId);
  if(body.action==='CLOSE_UNVERIFIED')throw Error('synthetic lost response');
  return Response.json({ok:true,outcome:'CLOSED',selected:1,results:[{jobId,successorJobId:null,category:'RECONCILE',evidence:'UNVERIFIED'}],observationsAreProof:false,observationsAtomicWithRound:false,observedAt:'2026-11-22T00:00:00.000Z',observations:[{jobId,jobState:'REVIEW',holdReason:null,provenanceVersion:0,leaseGeneration:0,epochState:'REVIEW',workbookClaimStateGlobal:'REVIEW',workbookClaimPhaseGlobal:'SERIAL_CONTINUATION',workbookClaimReasonGlobal:'SERIAL_FINAL_COMPLETION_NOT_READY',claimRelationship:'UNKNOWN',admittedOperations:1,verifiedStages:0,unresolvedStages:1}],servedVersion:version});
 };
 const recovered=await runNormalPilot(phase,fetcher);assert.deepEqual(recovered,{outcome:'PILOT_ROUND_RECONCILIATION_REQUIRED',selected:1,observedAt:'2026-11-22T00:00:00.000Z',jobs:[{jobId,successorJobId:null,jobState:'REVIEW',holdReason:null,provenanceVersion:0,leaseGeneration:0,epochState:'REVIEW',workbookClaimStateGlobal:'REVIEW',workbookClaimPhaseGlobal:'SERIAL_CONTINUATION',workbookClaimReasonGlobal:'SERIAL_FINAL_COMPLETION_NOT_READY',claimRelationship:'UNKNOWN',admittedOperations:1,verifiedStages:0,unresolvedStages:1}]});
 assert.deepEqual(actions,['READ']);
 const dir=mkdtempSync(join(tmpdir(),'recover-summary-'));try{const path=join(dir,'summary');summarize('RECOVER_ROUND',recovered.outcome,recovered,path);const output=readFileSync(path,'utf8');assert.match(output,/SERIAL_FINAL_COMPLETION_NOT_READY/);assert.match(output,/SERIAL_CONTINUATION/);assert.match(output,/UNKNOWN/);}finally{rmSync(dir,{recursive:true,force:true});}
});

test('open round recovery reports expired provider uncertainty without dispatch',async()=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',base=provider(),actions=[];
 let holdReason='SERIAL_EXPIRED_PROVIDER_UNCERTAIN',reservationChain;
 const request=async(url,opts)=>{
  if(!String(url).endsWith('/serial-round-recovery'))return base.request(url,opts);
  const body=JSON.parse(opts.body);actions.push(body.action);
  const observed={jobState:'REVIEW',holdReason,provenanceVersion:1,leaseGeneration:2,epochState:'ARMED',workbookClaimStateGlobal:'HELD',workbookClaimPhaseGlobal:'SERIAL_CONTINUATION',workbookClaimReasonGlobal:null,claimRelationship:'EXACT_EPOCH_OPERATION',admittedOperations:1,verifiedStages:1,unresolvedStages:1,reservations:1,lastVerifiedStageCandidate:'DAILY',lastVerifiedStageMayTie:true,lastVerifiedAt:'2026-11-22T00:00:00.000Z'};
  return Response.json({ok:true,outcome:'OPEN',selected:2,members:[jobId,nextId],reservationChain,observationsAreProof:false,observationsAtomicWithRound:false,observedAt:'2026-11-22T00:00:00.000Z',observations:[{...observed,jobId,holdReason:'SERIAL_PILOT_B_REVIEW'},{...observed,jobId:nextId}],servedVersion:version});
 };
 let progress;try{await runNormalPilot({...env,...gates,PILOT_PHASE:'RECOVER_ROUND',PILOT_ROUND_ID:roundId},request);assert.fail('OPEN must stop');}catch(error){assert.match(error.message,/PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION/);progress=error.serialProgress;}
 assert.equal(progress.jobs[1].holdReason,holdReason);assert.deepEqual(actions,['READ']);
 const dir=mkdtempSync(join(tmpdir(),'recover-open-summary-'));try{const path=join(dir,'summary');summarize('RECOVER_ROUND','PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION',progress,path);const output=readFileSync(path,'utf8');assert.match(output,/SERIAL_EXPIRED_PROVIDER_UNCERTAIN/);assert.match(output,/ผล provider ยังไม่ชัด/);assert.match(output,/ห้ามส่งซ้ำ/);assert.match(output,/ยังไม่ตรวจสายการจอง/);assert.doesNotMatch(output,/ยังไม่พบการจองถัดไป/);}finally{rmSync(dir,{recursive:true,force:true});}
 const recovery={...env,...gates,PILOT_PHASE:'RECOVER_ROUND',PILOT_ROUND_ID:roundId};
 reservationChain={status:'OBSERVED',workerVersion:version,jobIds:[jobId,nextId]};
 await assert.rejects(runNormalPilot(recovery,request),error=>{
  assert.match(error.message,/PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION/);
  assert.equal(error.serialProgress.jobs[0].successorJobId,nextId);
  const dir=mkdtempSync(join(tmpdir(),'recover-recorded-'));
  try{
   const path=join(dir,'summary');summarize('RECOVER_ROUND',error.message,error.serialProgress,path);
   const summary=readFileSync(path,'utf8');assert.ok(summary.includes(jobId+' → '+nextId));assert.ok(summary.includes(version));
   assert.match(summary,/DAILY 2026-11-22T00:00:00.000Z/);assert.match(summary,/หลายขั้นเวลาเดียวกัน/);
   assert.match(summary,/ยังยืนยันการจองถัดไปไม่ได้/);
  }finally{rmSync(dir,{recursive:true,force:true});}
  return true;
 });
 assert.deepEqual(actions.splice(1),['READ']);
 for(const invalid of [[nextId],[jobId,jobId]]){
  reservationChain.jobIds=invalid;
  await assert.rejects(runNormalPilot(recovery,request),/PILOT_ROUND_UNVERIFIED/);
  assert.deepEqual(actions.splice(1),['READ']);
 }
 reservationChain={status:'UNKNOWN'};
 holdReason='private-unrecognized-reason';await assert.rejects(runNormalPilot({...env,...gates,PILOT_PHASE:'RECOVER_ROUND',PILOT_ROUND_ID:roundId},request),/PILOT_ROUND_UNVERIFIED/);
 assert.deepEqual(actions,['READ','READ']);
});

test('round discovery uses only the read-only admin action and never dispatches work',async()=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',base=provider(),actions=[];
 const fetcher=async(url,opts)=>{
  if(!String(url).endsWith('/serial-round-recovery'))return base.request(url,opts);
  const body=JSON.parse(opts.body);actions.push(body.action);
  return Response.json({ok:true,outcome:'RECENT_ROUNDS',rounds:[{roundId,state:'CLOSED',selectedCount:2}],servedVersion:version});
 };
 assert.deepEqual(await runNormalPilot({...env,PILOT_PHASE:'DISCOVER_ROUND'},fetcher),{outcome:'PILOT_OPEN_ROUNDS_READ',rounds:[{roundId,state:'CLOSED',selected:2}]});
 assert.deepEqual(actions,['LIST_RECENT']);
});
test('hold reserved only contains the root and never retries an unknown mutation',async()=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',base=provider(),actions=[];
 const phase={...env,...gates,PILOT_PHASE:'HOLD_RESERVED',PILOT_ROUND_ID:roundId};let lost=false;
 const fetcher=async(url,opts)=>{
  if(!String(url).endsWith('/serial-round-recovery'))return base.request(url,opts);
  const body=JSON.parse(opts.body);actions.push(body.action);
  if(body.action==='READ')return Response.json({ok:true,outcome:'OPEN',fingerprint,members:[jobId],servedVersion:version});
  assert.equal(body.jobId,jobId);if(lost)throw Error('lost');return Response.json({ok:true,outcome:'RECONCILIATION_REQUIRED',servedVersion:version});
 };
 const held=await runNormalPilot(phase,fetcher);assert.deepEqual(held,{outcome:'PILOT_HOLD_RECONCILIATION_REQUIRED',roundId,jobId});
 const dir=mkdtempSync(join(tmpdir(),'hold-summary-'));try{const path=join(dir,'summary');summarize('HOLD_RESERVED',held.outcome,held,path);const summary=readFileSync(path,'utf8');assert.ok(summary.includes(roundId)&&summary.includes(jobId));}finally{rmSync(dir,{recursive:true,force:true});}
 assert.deepEqual(actions,['READ','HOLD_RESERVED']);actions.length=0;lost=true;
 await assert.rejects(runNormalPilot(phase,fetcher),error=>{
  assert.match(error.message,/PILOT_RESPONSE_UNKNOWN_NO_RETRY/);assert.deepEqual(error.serialProgress,{roundId,jobId});
  const dir=mkdtempSync(join(tmpdir(),'hold-unknown-'));try{const path=join(dir,'summary');summarize('HOLD_RESERVED',error.message,error.serialProgress,path);const summary=readFileSync(path,'utf8');assert.ok(summary.includes(roundId)&&summary.includes(jobId));assert.match(summary,/อ่านรอบเดิม/);}finally{rmSync(dir,{recursive:true,force:true});}return true;
 });
 assert.deepEqual(actions,['READ','HOLD_RESERVED']);
});

test('closed verified round can be read across Worker versions without reservation or writes',async()=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',oldVersion='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',base=provider(),actions=[];
 const phase={...env,PILOT_PHASE:'READ_ROUND',PILOT_ROUND_ID:roundId};
 assert.throws(()=>pilotInputs({...phase,PILOT_ROUND_ID:'invalid'}),/PILOT_INPUT_INVALID/);
 let unsafe=false,algorithm='pilot-finish-v2',members;
 const fetcher=async(url,opts)=>{
  if(!String(url).endsWith('/serial-round-recovery'))return base.request(url,opts);
  const body=JSON.parse(opts.body);actions.push(body.action);assert.equal(body.roundId,roundId);
  return Response.json({ok:true,outcome:'CLOSED',selected:1,members,recordedResultsAreCurrentProviderProof:unsafe,readRevalidatesRecordedIntegrity:false,
   results:[{jobId,successorJobId:null,category:'VERIFIED',evidence:'VERIFIED_RECEIPT'}],
   receipts:[{jobId,proof:'f'.repeat(64),proofAlgorithm:algorithm,workerVersion:oldVersion,verifiedAt:'2026-11-22T00:00:00.000Z'}],servedVersion:version});
 };
 const result=await runNormalPilot(phase,fetcher);
 assert.equal(result.outcome,'PILOT_ROUND_RECORDED_READ_ONLY');assert.equal(result.jobs[0].workerVersion,oldVersion);
 const recovery=await runNormalPilot({...phase,...gates,PILOT_PHASE:'RECOVER_ROUND'},fetcher);
 assert.deepEqual(recovery,result,'recovering a lost close response reads the existing terminal result');
 assert.deepEqual(actions.splice(1),['READ']);

 const dir=mkdtempSync(join(tmpdir(),'round-summary-'));try{
  const path=join(dir,'summary');summarize('READ_ROUND',result.outcome,result,path);
  const summary=readFileSync(path,'utf8');assert.match(summary,/2026-11-22T00:00:00.000Z/);assert.ok(summary.includes(oldVersion));
  assert.match(summary,/ไม่ได้ตรวจหลักฐานซ้ำ/);assert.doesNotMatch(summary,/undefined|job ไม่พบ|epoch ไม่พบ/);
 }finally{rmSync(dir,{recursive:true,force:true});}
 assert.deepEqual(actions,['READ']);
 for(const [ids,valid] of [[[jobId],true],[[nextId],false]]){
  members=ids;
  const observed=runNormalPilot({...phase,...gates,PILOT_PHASE:'RECOVER_ROUND'},fetcher);
  if(valid)assert.deepEqual(await observed,result);
  else await assert.rejects(observed,/PILOT_ROUND_UNVERIFIED/);
  assert.deepEqual(actions.splice(1),['READ']);
 }
 members=undefined;
 unsafe=true;await assert.rejects(runNormalPilot(phase,fetcher),/PILOT_ROUND_UNVERIFIED/);
 assert.deepEqual(actions,['READ','READ']);
 unsafe=false;algorithm='pilot-finish-v1';await assert.rejects(runNormalPilot(phase,fetcher),/PILOT_ROUND_UNVERIFIED/);
 assert.deepEqual(actions,['READ','READ','READ']);
});

const mockFenceRows=roundId=>Response.json({success:true,result:[{success:true,results:[{round_id:roundId,worker_version:version,nonce:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',fence_digest:'f'.repeat(64),fence_generation:1}]}]});

test('local mock close reports four outcomes and reads back after a lost response',async()=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',ids=[jobId,nextId,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','dddddddd-dddd-4ddd-8ddd-dddddddddddd'];
 const phase={...env,...gates,PILOT_PHASE:'CLOSE_MOCK_ROUND',PILOT_ROUND_ID:roundId,PILOT_LOCAL_MOCK:'true',MALIPANG_WORKER_URL:'https://localhost/'};
 assert.throws(()=>pilotInputs({...phase,MALIPANG_WORKER_URL:'https://example.com/'}),/PILOT_INPUT_INVALID/);
 assert.throws(()=>pilotInputs({...phase,PILOT_LOCAL_MOCK:'false'}),/PILOT_INPUT_INVALID/);
 const base=provider(),actions=[],results=['PARKED','VERIFIED','NOT_STARTED','RECONCILE'].map((category,i)=>({jobId:ids[i],category,evidence:['MOCK_ATTESTED_HANDOFF','VERIFIED_RECEIPT','MOCK_NEVER_STARTED','UNVERIFIED'][i],successorJobId:i===0?ids[1]:null}));let corrupt=x=>x,closed=false;
 const fetcher=async(url,opts)=>{
  if(String(url).includes('/d1/database/'))return mockFenceRows(roundId);
  if(!String(url).endsWith('/serial-round-recovery'))return base.request(url,opts);
  const action=JSON.parse(opts.body).action;actions.push(action);if(action==='CLOSE_MOCK_PARKED'){closed=true;throw Error('synthetic lost ACK');}
  if(!closed)return Response.json({ok:true,outcome:'OPEN',servedVersion:version});
  return Response.json(corrupt({ok:true,outcome:'CLOSED',selected:4,members:ids,mockOracleAndFenceOnly:true,recordedResultsAreCurrentProviderProof:false,readRevalidatesRecordedIntegrity:false,results,receipts:[{jobId:ids[1],proof:'f'.repeat(64),proofAlgorithm:'pilot-finish-v2',workerVersion:version,verifiedAt:'2026-11-22T00:00:00.000Z'}],servedVersion:version}));
 };
 const coordinator={proveQuiescence:async ctx=>({...ctx,state:'QUIESCENT_FENCED',fenceDigest:'f'.repeat(64),fenceGeneration:1,nonce:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})};
 const result=await runNormalPilot(phase,fetcher,undefined,coordinator);assert.equal(result.outcome,'PILOT_MOCK_ROUND_RECORDED');assert.deepEqual(result.jobs.map(x=>x.category),['PARKED','VERIFIED','NOT_STARTED','RECONCILE']);assert.deepEqual(actions,['READ','CLOSE_MOCK_PARKED','READ']);
 assert.deepEqual(await runNormalPilot({...phase,PILOT_PHASE:'RECOVER_ROUND'},fetcher),result);
 assert.deepEqual(actions.slice(3),['READ']);
 const dir=mkdtempSync(join(tmpdir(),'mock-round-summary-'));try{const path=join(dir,'summary');summarize('CLOSE_MOCK_ROUND',result.outcome,result,path);const summary=readFileSync(path,'utf8');assert.match(summary,/จำลอง/);assert.match(summary,/NOT_STARTED/);assert.doesNotMatch(summary,/undefined/);}finally{rmSync(dir,{recursive:true,force:true});}
 for(const change of [x=>({...x,members:[ids[1],ids[0],...ids.slice(2)]}),x=>({...x,receipts:[]}),x=>({...x,results:x.results.map((r,i)=>i===0?{...r,successorJobId:ids[2]}:r)})]){corrupt=change;await assert.rejects(runNormalPilot({...phase,PILOT_PHASE:'READ_ROUND'},fetcher),/PILOT_ROUND_UNVERIFIED/);}
});

test('fresh round reconciles lost B or C reservation responses',async t=>{
 let roundId;
 for(const lost of ['B','C']){
  const p=serialHarness(t,{fail(body,{record,serving}){
   if(body.action==='OPEN_INITIAL'){roundId=body.roundId;return serving(body,'OPEN');}
   if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[]});
   if(body.action==='READ')return serving(body,'OPEN',{fingerprint,members:[jobId,nextId],selected:2});
   if(body.action==='HANDOVER_ONE'){
    assert.equal(body.roundId,roundId);record(body.jobId,undefined,undefined,roundId);
    if(lost==='B')throw Error('synthetic lost B response');
    return serving(body,'RESERVED');
   }
   if(body.action==='ADVANCE_ONE'){
    assert.equal(body.roundId,roundId);record(body.nextJobId,body.jobId,body.proof,roundId);
    if(lost==='C')throw Error('synthetic lost C response');
    return serving(body,'RESERVED');
   }
  }});
  await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},p.request),/PILOT_ROUND_REQUIRES_RECONCILIATION/);
  assert.equal(p.actions.filter(x=>x.action==='HANDOVER_ONE').length,1);
  assert.equal(p.actions.filter(x=>x.action==='ADVANCE_ONE').length,1);
  assert.equal(p.db.prepare("SELECT count(*) n FROM admin_audit WHERE action='ISSUE296_SERIAL_EXPENSE_HANDOVER'").get().n,1);
 }
});

test('round-mode reconciles a lost OPEN acknowledgement against the exact sealed snapshot',async t=>{
 let saved;
 const p=serialHarness(t,{fail(body,{record,serving}){
  if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[]});
  if(body.action==='OPEN_INITIAL'){saved={roundId:body.roundId,fingerprint:body.fingerprint,members:body.jobs,selected:body.jobs.length};throw Error('synthetic lost open response');}
  if(body.action==='READ')return serving(body,'OPEN',saved);
  if(body.action==='HANDOVER_ONE'){assert.equal(body.roundId,saved.roundId);record(body.jobId,undefined,undefined,saved.roundId);return serving(body,'RESERVED');}
  if(body.action==='ADVANCE_ONE'){record(body.nextJobId,body.jobId,body.proof,saved.roundId);return serving(body,'RESERVED');}
 }});
 await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},p.request),/PILOT_ROUND_REQUIRES_RECONCILIATION/);
 assert.equal(p.actions.filter(x=>x.action==='OPEN_INITIAL').length,1);
 assert.equal(p.actions.filter(x=>x.action==='READ').length,1);
});

test('round-mode resumes at the durable B or C tip and rejects a chain outside the sealed snapshot',async t=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 for(const chain of [[jobId],[jobId,nextId]]){
  const p=serialHarness(t,{chain,fail(body,{record,serving}){
   if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[{roundId,selectedCount:2}]});
   if(body.action==='READ')return serving(body,'OPEN',{fingerprint,members:[jobId,nextId],selected:2});
   if(body.action==='ADVANCE_ONE'){record(body.nextJobId,body.jobId,body.proof,roundId);return serving(body,'RESERVED');}
  }});
  p.db.prepare("UPDATE admin_audit SET after_json=json_set(after_json,'$.roundId',?)").run(roundId);
  await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},p.request),/PILOT_RECEIPT_NEEDS_RECONCILIATION/);
  assert.equal(p.actions.filter(x=>x.action==='HANDOVER_ONE').length,0);
  assert.equal(p.actions.filter(x=>x.action==='RECORD_VERIFIED'||x.action==='ADVANCE_ONE').length,0);
 }
 const bad=serialHarness(t,{chain:[jobId],fail(body,{serving}){
  if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[{roundId,selectedCount:1}]});
  if(body.action==='READ')return serving(body,'OPEN',{fingerprint,members:[nextId],selected:1});
 }});
 bad.db.prepare("UPDATE admin_audit SET after_json=json_set(after_json,'$.roundId',?)").run(roundId);
 await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},bad.request),/PILOT_ROUND_CHAIN_UNVERIFIED/);
 assert.equal(bad.actions.filter(x=>x.action==='HANDOVER_ONE'||x.action==='ADVANCE_ONE').length,0);
});

test('round mode stops if the round closes during read or another writer advances beyond the attempted edge',async t=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 const closed=serialHarness(t,{fail(body,{serving}){
  if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[{roundId,selectedCount:2}]});
  if(body.action==='READ')return serving(body,'CLOSED',{fingerprint,members:[jobId,nextId],selected:2});
 }});
 await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},closed.request),/PILOT_RESULT_UNVERIFIED/);
 assert.equal(closed.actions.filter(x=>x.action==='HANDOVER_ONE'||x.action==='ADVANCE_ONE').length,0);
 let freshRound;const ahead=serialHarness(t,{selected:[jobId,nextId,laterId],fail(body,{record,serving,proofFor}){
  if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[]});
  if(body.action==='OPEN_INITIAL'){freshRound=body.roundId;return serving(body,'OPEN');}
  if(body.action==='READ')return serving(body,'OPEN',{fingerprint,members:[jobId,nextId,laterId],selected:3});
  if(body.action==='HANDOVER_ONE'){record(body.jobId,undefined,undefined,freshRound);return serving(body,'RESERVED');}
  if(body.action==='ADVANCE_ONE'){record(body.nextJobId,body.jobId,body.proof,freshRound);record(laterId,body.nextJobId,proofFor(body.nextJobId),freshRound);throw Error('synthetic response loss');}
 }});
 await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},ahead.request),/PILOT_RESPONSE_UNKNOWN_NO_RETRY/);
 assert.equal(ahead.actions.filter(x=>x.action==='ADVANCE_ONE').length,1);
});

test('round-mode progress extends observation for multiple verified DETAIL stages without granting a successor early',async t=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',scopeProof='e'.repeat(64);let statuses=0,progress=0,waits=0;
 const p=serialHarness(t,{selected:[jobId],chain:[jobId],fail(body,{serving}){
  if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[{roundId,selectedCount:1}]});
  if(body.action==='READ')return serving(body,'OPEN',{fingerprint,members:[jobId],selected:1});
  if(body.action==='FINISH_STATUS'&&statuses++<17)return serving(body,'IN_PROGRESS');
  if(body.action==='FINISH_PROGRESS'){
   const count=++progress;return serving(body,'PROGRESS',{verifiedStages:count,stageProofs:Array.from({length:count},(_,i)=>createHash('sha256').update(String(i)).digest('hex')),scopeProof});
  }
 }});
 p.db.prepare("UPDATE admin_audit SET after_json=json_set(after_json,'$.roundId',?)").run(roundId);
 await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},p.request,async()=>{waits++;}),/PILOT_RECEIPT_NEEDS_RECONCILIATION/);
 assert.equal(waits,17);assert.equal(p.actions.filter(x=>x.action==='ADVANCE_ONE').length,0);
});

test('round-mode progress stops on inactivity, replaced evidence, scope drift, and the absolute observation cap',async t=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 for(const mode of ['idle','replaced','scope','cap']){
  let seen=0;
  const p=serialHarness(t,{selected:[jobId],chain:[jobId],fail(body,{serving}){
   if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[{roundId,selectedCount:1}]});
   if(body.action==='READ')return serving(body,'OPEN',{fingerprint,members:[jobId],selected:1});
   if(body.action==='FINISH_STATUS')return serving(body,'IN_PROGRESS');
   if(body.action==='FINISH_PROGRESS'){
    const n=++seen,count=mode==='cap'?n:1;
    const stageProofs=Array.from({length:count},(_,i)=>createHash('sha256').update(String(mode==='replaced'&&n>1?999:i)).digest('hex'));
    return serving(body,'PROGRESS',{verifiedStages:count,stageProofs,scopeProof:mode==='scope'&&n>1?'d'.repeat(64):'e'.repeat(64)});
   }
  }});
  p.db.prepare("UPDATE admin_audit SET after_json=json_set(after_json,'$.roundId',?)").run(roundId);
  const expected=mode==='idle'?'PILOT_OBSERVATION_TIMEOUT_IN_PROGRESS':mode==='cap'?'PILOT_ROUND_TIME_BUDGET':'PILOT_PROGRESS_CHANGED';
  await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},p.request,async()=>{}),new RegExp(expected));
  assert.equal(p.actions.filter(x=>x.action==='ADVANCE_ONE').length,0);
 }
});

test('round-mode deadline is checked after provider readback before a successor can be reserved',async t=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',realNow=Date.now;let fake=realNow()+5000;
 const p=serialHarness(t,{chain:[jobId],fail(body,{serving}){
  if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[{roundId,selectedCount:2}]});
  if(body.action==='READ')return serving(body,'OPEN',{fingerprint,members:[jobId,nextId],selected:2});
  if(body.action==='READBACK'){fake+=120*60000+1;return serving(body,'MATCHED');}
 }});
 p.db.prepare("UPDATE admin_audit SET after_json=json_set(after_json,'$.roundId',?)").run(roundId);
 try{Date.now=()=>fake;await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},p.request),/PILOT_ROUND_TIME_BUDGET/);}
 finally{Date.now=realNow;}
 assert.equal(p.actions.filter(x=>x.action==='ADVANCE_ONE').length,0);
});

test('historical read accepts a prior worker only for read-only observation and never reserves a successor',async t=>{
 const oldVersion='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const p=serialHarness(t,{selected:[],chain:[jobId],fail(body,{serving}){
  if(body.action==='READ_HISTORICAL')return serving(body,'MATCHED_READ_ONLY');
 }});
 p.db.prepare("UPDATE admin_audit SET after_json=json_set(after_json,'$.version',?)").run(oldVersion);
 assert.equal(await runNormalPilot({...env,PILOT_PHASE:'READ_HISTORICAL'},p.request),'PILOT_HISTORICAL_DAILY_MATCHED_READ_ONLY');
 assert.deepEqual(p.actions.map(x=>x.action),['READ_HISTORICAL']);
 const strict=serialHarness(t,{selected:[],chain:[jobId]});strict.db.prepare("UPDATE admin_audit SET after_json=json_set(after_json,'$.version',?)").run(oldVersion);
 await assert.rejects(runNormalPilot({...env,PILOT_PHASE:'FINISH_PILOT'},strict.request),/PILOT_SERIAL_CHAIN_UNVERIFIED/);
 assert.equal(strict.actions.length,0);
});

test('round-mode reconciles a lost verified-receipt response only against the exact durable proof',async t=>{
 let roundId;
 for(const matches of [true,false]){
  let receipt=null;
  const p=serialHarness(t,{fail(body,{record,serving}){
   if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[]});
   if(body.action==='OPEN_INITIAL'){roundId=body.roundId;return serving(body,'OPEN');}
   if(body.action==='READ')return serving(body,'OPEN',{fingerprint,members:[jobId,nextId],selected:2,receipts:receipt?[receipt]:[]});
   if(body.action==='HANDOVER_ONE'){record(body.jobId,undefined,undefined,roundId);return serving(body,'RESERVED');}
   if(body.action==='RECORD_VERIFIED'&&body.jobId===jobId){receipt={jobId,proof:matches?body.proof:'f'.repeat(64),proofAlgorithm:'pilot-finish-v2',workerVersion:version};throw Error('synthetic lost receipt response');}
   if(body.action==='ADVANCE_ONE'){record(body.nextJobId,body.jobId,body.proof,roundId);return serving(body,'RESERVED');}
  }});
  await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},p.request),matches?/PILOT_ROUND_REQUIRES_RECONCILIATION/:/PILOT_RESPONSE_UNKNOWN_NO_RETRY/);
  assert.equal(p.actions.filter(x=>x.action==='RECORD_VERIFIED'&&x.jobId===jobId).length,1);
  assert.equal(p.actions.filter(x=>x.action==='ADVANCE_ONE').length,matches?1:0);
 }
});

test('round-mode records and closes an empty selection without touching the old job or sending queue work',async t=>{
 const p=serialHarness(t,{selected:[],fail(body,{serving}){
  if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[]});
  if(body.action==='OPEN_EMPTY')return serving(body,'OPEN');
  if(body.action==='CLOSE_UNVERIFIED')return serving(body,'CLOSED');
 }});
 assert.deepEqual(await runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},p.request),{outcome:'PILOT_ROUND_EMPTY',selected:0});
 assert.deepEqual(p.actions.map(x=>x.action),['LIST_OPEN','OPEN_EMPTY','CLOSE_UNVERIFIED']);
});

test('empty round recovers lost open and close acknowledgements without resending either mutation',async t=>{
 let roundId,closed=false;
 const p=serialHarness(t,{selected:[],fail(body,{serving}){
  if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[]});
  if(body.action==='OPEN_EMPTY'){roundId=body.roundId;throw Error('synthetic lost open');}
  if(body.action==='CLOSE_UNVERIFIED'){closed=true;throw Error('synthetic lost close');}
  if(body.action==='READ')return serving(body,closed?'CLOSED':'OPEN',{fingerprint:'0'.repeat(64),selected:0,members:[],results:[]});
 }});
 assert.deepEqual(await runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},p.request),{outcome:'PILOT_ROUND_EMPTY',selected:0});
 assert.equal(p.actions.filter(x=>x.action==='OPEN_EMPTY').length,1);assert.equal(p.actions.filter(x=>x.action==='CLOSE_UNVERIFIED').length,1);assert.equal(p.actions.filter(x=>x.action==='READ').length,2);assert.ok(roundId);
});

test('local RUN_SERIAL holds B and uses the injected coordinator only once',async t=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',nonce='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',epoch='normal_pilot296_cccccccc-cccc-4ccc-8ccc-cccccccccccc',payload='d'.repeat(64),claim='e'.repeat(64);
 for(const mode of ['normal','hold-lost','transfer-lost','transfer-absent','restart-b','scope-drift','drift-before-b','drift-after-finish']){
  let calls=0,holder=false,liveRoundId=roundId;const p=serialHarness(t,{fail(body,{record,serving}){
   if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:mode==='restart-b'?[{roundId,selectedCount:2}]:[]});
   if(body.action==='OPEN_INITIAL'){liveRoundId=body.roundId;return serving(body,'OPEN');}
   if(body.action==='READ')return serving(body,'OPEN',{fingerprint,members:[jobId,nextId],selected:2,observations:holder?[{jobId,jobState:'REVIEW',holdReason:'SERIAL_PILOT_B_REVIEW'}]:[]});
   if(body.action==='HANDOVER_ONE'){record(body.jobId,undefined,undefined,liveRoundId);return serving(body,'RESERVED');}
   if(body.action==='INSPECT'&&mode==='drift-before-b'){if(config.PILOT_LOCAL_MOCK==='false')return serving(body,'INSPECTED',{fingerprint,projectionState:'VERIFIED',preimageDigest});config.PILOT_LOCAL_MOCK='false';}
   if(body.action==='FINISH_STATUS'&&mode==='drift-after-finish')config.PILOT_LOCAL_MOCK='false';
   if(body.action==='HOLD_RESERVED'){holder=true;if(mode==='hold-lost')throw Error('lost');return serving(body,'RECONCILIATION_REQUIRED');}
   if(body.action==='CLOSE_MOCK_PARKED')return serving(body,'CLOSED',{selected:2,members:[jobId,nextId],mockOracleAndFenceOnly:true,recordedResultsAreCurrentProviderProof:false,readRevalidatesRecordedIntegrity:false,results:[{jobId,category:'PARKED',evidence:'MOCK_ATTESTED_HANDOFF',successorJobId:nextId},{jobId:nextId,category:'VERIFIED',evidence:'VERIFIED_RECEIPT',successorJobId:null}],receipts:[{jobId:nextId,proof:'f'.repeat(64),proofAlgorithm:'pilot-finish-v2',workerVersion:version,verifiedAt:'2026-11-22T00:00:00.000Z'}]});
  }});
  if(mode==='restart-b')p.db.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?)').run('issue296:parked:synthetic','ISSUE296_PAUSED_NOTICE_HANDOVER',jobId,fingerprint,JSON.stringify({book:'test-book'}),JSON.stringify({version,roundId}));
  const config={...serialEnv,PILOT_ROUND_MODE:'true',PILOT_LOCAL_MOCK:'true',MALIPANG_WORKER_URL:'https://localhost/'};
  const coordinator={async prepare(ctx){return {...ctx,nonce,payloadDigest:payload,claimDigest:claim};},async reserve(){calls++;if(mode!=='transfer-absent')p.db.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?)').run('issue296:serial:'+jobId,'ISSUE296_SERIAL_EXPENSE_HANDOVER',nextId,fingerprint,JSON.stringify({book:'test-book',predecessorJobId:jobId,proof:payload}),JSON.stringify({version,roundId:liveRoundId,epoch,attestationNonce:nonce}));if(mode==='scope-drift')config.PILOT_LOCAL_MOCK='false';if(mode==='transfer-lost'||mode==='transfer-absent')throw Error('lost');},async inspect(expected){return {...expected,outcome:'RESERVATION_RECORDED',claimDigest:claim};}};
  if(['transfer-absent','restart-b','scope-drift','drift-before-b','drift-after-finish'].includes(mode)){
   const expected=mode==='restart-b'?/PILOT_MOCK_HANDOFF_NEEDS_RECONCILIATION/:mode==='transfer-absent'?/PILOT_MOCK_HANDOFF_UNVERIFIED/:mode==='scope-drift'?/PILOT_RESPONSE_UNKNOWN_NO_RETRY/:/PILOT_MOCK_SCOPE_CHANGED/;
   await assert.rejects(runNormalPilot(config,p.request,async()=>{},coordinator),error=>{
    assert.match(error.message,expected);
    if(['restart-b','transfer-absent','scope-drift','drift-after-finish'].includes(mode)){
     assert.deepEqual(error.serialProgress,{roundId:liveRoundId,jobId,successorJobId:nextId});
     const dir=mkdtempSync(join(tmpdir(),'mock-unknown-'));try{const path=join(dir,'summary');summarize('RUN_SERIAL',error.message,error.serialProgress,path);const summary=readFileSync(path,'utf8');assert.ok(summary.includes(liveRoundId)&&summary.includes(jobId)&&summary.includes(nextId));assert.match(summary,/ห้ามจองหรือส่งซ้ำ/);}finally{rmSync(dir,{recursive:true,force:true});}
    }
    return true;
   });
   assert.equal(calls,['restart-b','drift-before-b'].includes(mode)?0:1);assert.ok(!p.actions.some(x=>x.action==='CLOSE_MOCK_PARKED'));
   if(mode==='drift-before-b'){assert.ok(!p.actions.some(x=>['SETTLE','HANDOVER_ONE'].includes(x.action)));assert.equal(p.actions.filter(x=>x.action==='INSPECT').length,1);}
   if(mode==='drift-after-finish')assert.ok(!p.actions.some(x=>x.action==='RECORD_VERIFIED'));
  }else{
   const result=await runNormalPilot(config,p.request,async()=>{},coordinator);assert.equal(result.outcome,'PILOT_MOCK_ROUND_RECORDED');assert.equal(calls,1);
   assert.equal(p.actions.filter(x=>x.action==='HOLD_RESERVED').length,1);assert.equal(p.actions.filter(x=>x.action==='CLOSE_MOCK_PARKED').length,1);
  }
 }
});

test('local RUN_SERIAL does not reserve B when the snapshot has no C',async t=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',p=serialHarness(t,{selected:[jobId],fail(body,{serving}){
  if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[{roundId,selectedCount:1}]});
  if(body.action==='READ')return serving(body,'OPEN',{fingerprint,members:[jobId],selected:1});
 }});
 const local={...serialEnv,PILOT_ROUND_MODE:'true',PILOT_LOCAL_MOCK:'true',MALIPANG_WORKER_URL:'https://localhost/'};
 const coordinator={prepare:async()=>assert.fail('prepare'),reserve:async()=>assert.fail('reserve'),inspect:async()=>assert.fail('inspect')};
 await assert.rejects(runNormalPilot(local,p.request,async()=>{},coordinator),/PILOT_ROUND_UNVERIFIED/);
 assert.ok(!p.actions.some(x=>['HANDOVER_ONE','HOLD_RESERVED'].includes(x.action)));
});

test('local empty round never treats a scope change as an acknowledged write',async t=>{
 for(const mode of ['before-open','after-open']){
  const p=serialHarness(t,{selected:[],fail(body,{serving}){
   if(body.action==='LIST_OPEN'){if(mode==='before-open')local.PILOT_LOCAL_MOCK='false';return serving(body,'OPEN_ROUNDS',{rounds:[]});}
   if(body.action==='OPEN_EMPTY'){local.PILOT_LOCAL_MOCK='false';return serving(body,'OPEN');}
   if(body.action==='READ')return serving(body,'CLOSED',{fingerprint:'0'.repeat(64),members:[],results:[],selected:0});
  }});
  const local={...serialEnv,PILOT_ROUND_MODE:'true',PILOT_LOCAL_MOCK:'true',MALIPANG_WORKER_URL:'https://localhost/'};
  const coordinator={prepare:async()=>assert.fail('prepare'),reserve:async()=>assert.fail('reserve'),inspect:async()=>assert.fail('inspect')};
  await assert.rejects(runNormalPilot(local,p.request,async()=>{},coordinator),mode==='before-open'?/PILOT_MOCK_SCOPE_CHANGED/:/PILOT_RESPONSE_UNKNOWN_NO_RETRY/);
  assert.equal(p.actions.filter(x=>x.action==='OPEN_EMPTY').length,mode==='before-open'?0:1);
  assert.equal(p.actions.filter(x=>x.action==='CLOSE_UNVERIFIED').length,0);assert.equal(p.actions.filter(x=>x.action==='READ').length,0);
 }
});

test('local mock close treats scope drift after dispatch as unknown without another request',async()=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',local={...env,...gates,PILOT_PHASE:'CLOSE_MOCK_ROUND',PILOT_ROUND_ID:roundId,PILOT_LOCAL_MOCK:'true',MALIPANG_WORKER_URL:'https://localhost/'};
 const base=provider(),actions=[];
 const fetcher=async(url,opts)=>{if(String(url).includes('/d1/database/'))return mockFenceRows(roundId);if(!String(url).endsWith('/serial-round-recovery'))return base.request(url,opts);const body=JSON.parse(opts.body);actions.push(body.action);if(body.action==='READ')return Response.json({ok:true,outcome:'OPEN',servedVersion:version});local.PILOT_LOCAL_MOCK='false';throw Error('synthetic post-commit loss');};
 const coordinator={proveQuiescence:async ctx=>({...ctx,state:'QUIESCENT_FENCED',fenceDigest:'f'.repeat(64),fenceGeneration:1,nonce:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'})};
 await assert.rejects(runNormalPilot(local,fetcher,undefined,coordinator),/PILOT_RESPONSE_UNKNOWN_NO_RETRY/);
 assert.deepEqual(actions,['READ','CLOSE_MOCK_PARKED']);
});

test('round restart never repeats record or transition while an earlier request may still finish',async t=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',proof=createHash('sha256').update(jobId).digest('hex');
 for(const mode of ['matching','missing','duplicate','wrong-proof','wrong-worker','wrong-algorithm']){
  const receipt={jobId,proof,proofAlgorithm:'pilot-finish-v2',workerVersion:version};
  const receipts=mode==='missing'?[]:mode==='duplicate'?[receipt,receipt]:[{...receipt,...(mode==='wrong-proof'?{proof:'f'.repeat(64)}:mode==='wrong-worker'?{workerVersion:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}:mode==='wrong-algorithm'?{proofAlgorithm:'legacy'}:{})}];
  const p=serialHarness(t,{chain:[jobId],fail(body,{serving}){
   if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[{roundId,selectedCount:2}]});
   if(body.action==='READ')return serving(body,'OPEN',{fingerprint,members:[jobId,nextId],selected:2,receipts});
  }});
  p.db.prepare("UPDATE admin_audit SET after_json=json_set(after_json,'$.roundId',?)").run(roundId);
  await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},p.request),mode==='matching'?/PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION/:/PILOT_RECEIPT_NEEDS_RECONCILIATION/,mode);
  assert.equal(p.actions.filter(x=>['RECORD_VERIFIED','ADVANCE_ONE','CLOSE_VERIFIED'].includes(x.action)).length,0,mode);
 }
});

test('a discovered OPEN round never resends handover or empty close after restart',async t=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
 for(const members of [[],[jobId,nextId]]){
  const p=serialHarness(t,{selected:members,fail(body,{serving}){
   if(body.action==='LIST_OPEN')return serving(body,'OPEN_ROUNDS',{rounds:[{roundId,selectedCount:members.length}]});
   if(body.action==='READ')return serving(body,'OPEN',{fingerprint:members.length?fingerprint:'0'.repeat(64),members,selected:members.length});
  }});
  await assert.rejects(runNormalPilot({...serialEnv,PILOT_ROUND_MODE:'true'},p.request),members.length?/PILOT_HANDOVER_NEEDS_RECONCILIATION/:/PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION/);
  assert.equal(p.actions.filter(x=>['HANDOVER_ONE','CLOSE_UNVERIFIED','ADVANCE_ONE'].includes(x.action)).length,0);
 }
});

test('restarted OPEN round explains why no transition may be resent',()=>{
 for(const code of ['PILOT_HANDOVER_NEEDS_RECONCILIATION','PILOT_RECEIPT_NEEDS_RECONCILIATION','PILOT_MOCK_RECEIPT_NEEDS_RECONCILIATION','PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION','PILOT_ROUND_CLOSE_NEEDS_RECONCILIATION']){
  const message=describeResult('RUN_SERIAL',code);assert.match(message,/OPEN/);assert.match(message,/ห้ามส่ง/);assert.match(message,/อาจยังไม่สิ้นสุด/);
 }
});

test('round recovery observes OPEN but never repeats a close that may still commit',async()=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',base=provider(),actions=[];let pending=true;
 const phase={...env,...gates,PILOT_PHASE:'RECOVER_ROUND',PILOT_ROUND_ID:roundId};
 const fetcher=async(url,opts)=>{if(!String(url).endsWith('/serial-round-recovery'))return base.request(url,opts);const body=JSON.parse(opts.body);actions.push(body.action);assert.equal(body.action,'READ');return Response.json({ok:true,outcome:pending?'OPEN':'CLOSED',servedVersion:version,selected:0,results:[],observations:[],observationsAreProof:false,observationsAtomicWithRound:false,observedAt:'2026-11-22T00:00:00.000Z'});};
 await assert.rejects(runNormalPilot(phase,fetcher),error=>error.message==='PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION'&&error.serialProgress.roundId===roundId);
 pending=false;assert.equal((await runNormalPilot(phase,fetcher)).outcome,'PILOT_ROUND_EMPTY');assert.deepEqual(actions,['READ','READ']);
});

test('local mock close requires exact quiescence before dispatch',async()=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',phase={...env,...gates,PILOT_PHASE:'CLOSE_MOCK_ROUND',PILOT_ROUND_ID:roundId,PILOT_LOCAL_MOCK:'true',MALIPANG_WORKER_URL:'https://localhost/'},base=provider();
 for(const mode of ['missing','reject','wrong-round','wrong-version','wrong-fence','wrong-nonce','other-fence','other-nonce','other-generation','d1-error','d1-empty','d1-duplicate','query-drift','drift']){
  const actions=[],local={...phase};const fetcher=async(url,opts)=>{if(String(url).includes('/d1/database/')){if(mode==='d1-error')return new Response('',{status:503});const result=await mockFenceRows(roundId).json();if(mode==='d1-empty')result.result[0].results=[];if(mode==='d1-duplicate')result.result[0].results.push({...result.result[0].results[0]});if(mode==='query-drift')local.PILOT_LOCAL_MOCK='false';return Response.json(result);}if(!String(url).endsWith('/serial-round-recovery'))return base.request(url,opts);const action=JSON.parse(opts.body).action;actions.push(action);return Response.json({ok:true,outcome:'OPEN',servedVersion:version});};
  const coordinator=mode==='missing'?undefined:{async proveQuiescence(ctx){if(mode==='reject')throw Error('unknown');if(mode==='drift')local.PILOT_LOCAL_MOCK='false';return {...ctx,state:'QUIESCENT_FENCED',fenceDigest:mode==='wrong-fence'?'bad':mode==='other-fence'?'e'.repeat(64):'f'.repeat(64),fenceGeneration:mode==='other-generation'?2:1,nonce:mode==='wrong-nonce'?'bad':mode==='other-nonce'?'cccccccc-cccc-4ccc-8ccc-cccccccccccc':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',...(mode==='wrong-round'?{roundId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}:mode==='wrong-version'?{workerVersion:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}:{})};}};
  await assert.rejects(runNormalPilot(local,fetcher,undefined,coordinator),mode==='drift'?/PILOT_MOCK_SCOPE_CHANGED/:mode==='query-drift'?/PILOT_RESPONSE_UNKNOWN_NO_RETRY/:mode==='d1-error'?/PILOT_CLOUDFLARE_UNAVAILABLE/:/PILOT_MOCK_QUIESCENCE_REQUIRED/,mode);assert.deepEqual(actions,['READ'],mode);
 }
});

test('reconciliation summary identifies the original round without suggesting retry',()=>{
 const roundId='aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',dir=mkdtempSync(join(tmpdir(),'serial-reconcile-summary-'));
 try{for(const phase of ['RUN_SERIAL','RECOVER_ROUND','CLOSE_MOCK_ROUND']){
  const path=join(dir,phase);summarize(phase,'PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION',{roundId},path);const text=readFileSync(path,'utf8');assert.ok(text.includes(roundId),phase);assert.match(text,/อย่าส่งซ้ำ/,phase);
 }}finally{rmSync(dir,{recursive:true,force:true});}
});

test('experimental round mode requires local durable identity before any mutation',async t=>{
 for(const mode of ['missing-store','nonlocal','missing-flag','sync-failure','scope-drift']){
  const input={...serialEnv,PILOT_ROUND_MODE:'true',PILOT_LOCAL_IDENTITY:'true',MALIPANG_WORKER_URL:mode==='nonlocal'?'https://outside.invalid/':'https://localhost/'};
  if(mode==='missing-flag')delete input.PILOT_LOCAL_IDENTITY;
  const p=serialHarness(t),store=mode==='missing-store'?undefined:{async claim(){if(mode==='sync-failure')throw Error('synthetic fsync');if(mode==='scope-drift')input.PILOT_LOCAL_IDENTITY='false';return {state:'FRESH',roundId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'};}};
  await assert.rejects(runPilot(input,p.request,async()=>{},undefined,store),mode==='scope-drift'?/PILOT_MOCK_SCOPE_CHANGED/:mode==='sync-failure'?/PILOT_DURABLE_IDENTITY_UNVERIFIED/:/PILOT_DURABLE_IDENTITY_REQUIRED/,mode);
  assert.equal(p.actions.filter(x=>['INSPECT','PROBE','SETTLE','OPEN_INITIAL','OPEN_EMPTY','HANDOVER_ONE'].includes(x.action)).length,0,mode);
 }
});

test('missing or ambiguous local identity explains the safe next step',()=>{
 for(const code of ['PILOT_DURABLE_IDENTITY_REQUIRED','PILOT_DURABLE_IDENTITY_UNVERIFIED']){const message=describeResult('RUN_SERIAL',code);assert.match(message,/identity store/);assert.match(message,/ห้ามสร้างรอบใหม่/);assert.match(message,/directory เดิม/);}
});

test('existing identity summary does not claim an unseen round is open',()=>{const text=describeResult('RUN_SERIAL','PILOT_ROUND_IDENTITY_NEEDS_RECONCILIATION');assert.match(text,/สถานะรอบ.*ไม่ชัด/);assert.doesNotMatch(text,/ยัง OPEN/);assert.match(text,/ห้ามสร้างรอบใหม่/);});
