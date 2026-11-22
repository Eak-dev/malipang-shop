import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pilotInputs,runNormalPilot} from '../scripts/prod-normal-queue-pilot.mjs';

const version='01234567-89ab-cdef-0123-456789abcdef', sha='a'.repeat(40);
const env={GITHUB_SHA:sha,EXPECTED_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',
  PILOT_PHASE:'PROBE',EXPECTED_WORKER_VERSION_SHA256:createHash('sha256').update(version).digest('hex'),
  CLOUDFLARE_API_TOKEN:'cf-test',CLOUDFLARE_ACCOUNT_ID:'synthetic',MALIPANG_ADMIN_TOKEN:'admin-test',
  MALIPANG_WORKER_URL:'https://worker.invalid'};
const fingerprint='b'.repeat(64),preimageDigest='c'.repeat(64),jobId='12345678-1234-1234-1234-123456789abc';
const gates={BACKUP_RUN_ID:'123',GITHUB_TOKEN:'gh-test',EXTERNAL_WRITERS_FENCED:'true',OWNER_SUPERVISING:'true'};

function provider({state='IN_FLIGHT',rows=[],outcome='MATCHED',missingAck=false}={}){
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
    if(missingAck&&['SETTLE','HANDOVER_ONE'].includes(body.action))throw Error('sensitive test value');
    const results={PROBE:'MATCHED',SETTLE:'SETTLED',HANDOVER_ONE:'RESERVED',INSPECT_HANDOVER:'ADOPTED',READBACK:outcome};
    return reply({ok:true,outcome:results[body.action],fingerprint,preimageDigest,servedVersion:version});
  };
  return {calls,request};
}

test('mutation requires verified backup, correct revision, first attempt and active owner fence',()=>{
  for(const phase of ['SETTLE','HANDOVER_ONE']){
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
  assert.equal(await runNormalPilot(phase,p.request),'PILOT_ONE_RESERVED');
  assert.deepEqual(p.calls.map(c=>c.action),['INSPECT','HANDOVER_ONE']);
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

test('inspect reads the audit before consulting the Worker and never selects a new candidate',async()=>{
  const phase={...env,PILOT_PHASE:'INSPECT_HANDOVER'};
  const empty=provider();
  assert.equal(await runNormalPilot(phase,empty.request),'PILOT_NO_HANDOVER_RECORDED');
  assert.deepEqual(empty.calls,[]);
  const p=provider({rows:[{job_id:jobId,fingerprint}]});
  assert.equal(await runNormalPilot(phase,p.request),'PILOT_ADOPTED');
  assert.deepEqual(p.calls,[{action:'INSPECT_HANDOVER',jobId,fingerprint}]);
});
