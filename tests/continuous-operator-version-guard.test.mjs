import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {handleAdmin}=require('../dist/admin/handler.js');
const cutover=require('../dist/admin/continuous-cutover-operator.js');
const canary=require('../dist/admin/continuous-canary-operator.js');
const recovery=require('../dist/admin/canary-unwritten-dispatch.js');
const version='12345678-1234-4234-8234-123456789abc',other='87654321-4321-4321-8321-cba987654321',token='x'.repeat(40);
function fixture(){
 let calls=0;const old={cutover:cutover.operateContinuousCutover,canary:canary.operateContinuousCanary,recovery:recovery.stepCanaryUnwrittenRecovery};
 cutover.operateContinuousCutover=async(_env,action)=>{calls++;if(action==='FAIL')throw Error('TEST_FAILURE');return{ok:true,action}};
 canary.operateContinuousCanary=async(_env,action)=>{calls++;if(action==='FAIL')throw Error('TEST_FAILURE');return{ok:true,action}};
 recovery.stepCanaryUnwrittenRecovery=async()=>{calls++;return'IN_PROGRESS'};
 const env={ADMIN_TOKEN:token,CF_VERSION_METADATA:{id:version},CANARY_UNWRITTEN_RECOVERY_ENABLED:'true'};
 const request=(path,{expected=version,auth=`Bearer ${token}`,action='START'}={})=>new Request(`https://worker.invalid/admin/stable-sync/${path}`,{method:'POST',headers:{...(expected===null?{}:{'x-malipang-expected-worker-version':expected}),authorization:auth,'content-type':'application/json'},body:JSON.stringify({action})});
 return{env,request,get calls(){return calls},close(){cutover.operateContinuousCutover=old.cutover;canary.operateContinuousCanary=old.canary;recovery.stepCanaryUnwrittenRecovery=old.recovery}};
}
for(const path of ['continuous-cutover','continuous-canary','canary-unwritten-recovery','scoped-hold-incident']){
 test(`${path} checks auth before version and refuses absent or mismatched pins before operation`,async()=>{const h=fixture();try{
  assert.equal((await handleAdmin(h.request(path,{auth:'Bearer wrong'}),h.env,{})).status,401);
  for(const expected of [null,'invalid',other]){const response=await handleAdmin(h.request(path,{expected}),h.env,{});assert.equal(response.status,409);assert.deepEqual(await response.json(),{ok:false,error:'WORKER_VERSION_MISMATCH',servedVersion:version});}
  h.env.CF_VERSION_METADATA=undefined;let response=await handleAdmin(h.request(path),h.env,{});assert.equal(response.status,503);assert.deepEqual(await response.json(),{ok:false,error:'WORKER_VERSION_UNAVAILABLE',servedVersion:null});
  h.env.CF_VERSION_METADATA={id:'invalid'};response=await handleAdmin(h.request(path),h.env,{});assert.equal(response.status,503);assert.equal(h.calls,0);
 }finally{h.close()}});
 if(path!=='canary-unwritten-recovery'&&path!=='scoped-hold-incident')test(`${path} returns the runtime version on success and failure`,async()=>{const h=fixture();try{
  let response=await handleAdmin(h.request(path),h.env,{});assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,action:'START',servedVersion:version});
  response=await handleAdmin(h.request(path,{action:'FAIL'}),h.env,{});assert.equal(response.status,400);assert.deepEqual(await response.json(),{ok:false,error:'TEST_FAILURE',servedVersion:version});assert.equal(h.calls,2);
 }finally{h.close()}});
}
test('unwritten recovery is default off, accepts only a specific phase and never exposes target IDs',async()=>{const h=fixture();try{
 h.env.CANARY_UNWRITTEN_RECOVERY_ENABLED=undefined;
 assert.equal((await handleAdmin(h.request('canary-unwritten-recovery',{action:'TIME'}),h.env,{})).status,404);assert.equal(h.calls,0);
 h.env.CANARY_UNWRITTEN_RECOVERY_ENABLED='true';
 assert.equal((await handleAdmin(h.request('canary-unwritten-recovery',{action:'OTHER'}),h.env,{})).status,400);assert.equal(h.calls,0);
 const response=await handleAdmin(h.request('canary-unwritten-recovery',{action:'TIME'}),h.env,{});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,action:'TIME',outcome:'IN_PROGRESS',servedVersion:version});assert.equal(h.calls,1);
}finally{h.close()}});
