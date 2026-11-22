import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {pilotInputs,runNormalPilot} from '../scripts/prod-normal-queue-pilot.mjs';

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
      assert.match(JSON.parse(opts.body).sql,/^SELECT /);
      return reply({success:true,result:[{success:true,results:rows}]});
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
  function record(id,previous,proof=proofFor(previous??id)){
    db.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?)').run(
      previous?'issue296:serial:'+previous:'issue296:parked:synthetic',
      previous?'ISSUE296_SERIAL_EXPENSE_HANDOVER':'ISSUE296_PAUSED_NOTICE_HANDOVER',
      id,fingerprint,JSON.stringify({book:'test-book',predecessorJobId:previous,proof}),JSON.stringify({version}));
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
    if(!String(url).startsWith(env.MALIPANG_WORKER_URL))return base.request(url,opts);
    const body=JSON.parse(opts.body);actions.push(body);
    const substitute=fail(body,{db,record,add,actions,serving,proofFor});
    if(substitute)return substitute;
    switch(body.action){
      case 'INSPECT':return serving(body,'INSPECTED',{fingerprint,projectionState:'IN_FLIGHT',preimageDigest:null});
      case 'PROBE':return serving(body,'MATCHED',{fingerprint,preimageDigest});
      case 'SETTLE':return serving(body,'SETTLED',{fingerprint,preimageDigest});
      case 'HANDOVER_ONE':record(body.jobId);return serving(body,'RESERVED');
      case 'FINISH_STATUS':return serving(body,'JOB_COMPLETE',{proof:proofFor(body.jobId)});
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
