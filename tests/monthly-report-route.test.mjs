import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),operator=require('../dist/sheets/monthly-report-operator.js'),{handleAdmin}=require('../dist/admin/handler.js');
const version='01234567-89ab-cdef-0123-456789abcdef',secret='a'.repeat(40),hash=createHash('sha256').update(version).digest('hex'),candidate='b'.repeat(64);
function request(body,expected=version,auth=secret){return new Request('https://synthetic.invalid/admin/stable-sync/monthly-report',{method:'POST',headers:{authorization:`Bearer ${auth}`,'x-malipang-expected-worker-version':expected,'content-type':'application/json'},body:JSON.stringify(body)});}
test('route is version pinned, authenticated, default-off and accepts only opaque inputs',async()=>{const env={ADMIN_TOKEN:secret,CF_VERSION_METADATA:{id:version}},old=operator.operateMonthlyReport;let calls=0;
 try{operator.operateMonthlyReport=async(_env,action,w,c)=>{calls++;assert.equal(w,hash);return action==='APPEND_ONE'?{status:'DONE'}:{status:'READY',ready:1,held:0,candidate};};
 assert.equal((await handleAdmin(request({action:'PREVIEW'},version,'wrong'),env,{})).status,401);assert.equal((await handleAdmin(request({action:'PREVIEW'},'bad'),env,{})).status,409);assert.equal((await handleAdmin(request({action:'PREVIEW'}),env,{})).status,404);assert.equal(calls,0);
 env.MONTHLY_REPORT_OPERATOR_ENABLED='true';for(const body of [{action:'APPEND_ONE'}, {action:'PREVIEW',candidate},{action:'APPEND_ONE',candidate,expenseId:'private'}, {action:'UNKNOWN'}])assert.equal((await handleAdmin(request(body),env,{})).status,400);
 const preview=await handleAdmin(request({action:'PREVIEW'}),env,{});assert.equal(preview.status,200);assert.deepEqual(await preview.json(),{ok:true,action:'PREVIEW',status:'READY',ready:1,held:0,candidate,servedVersion:version});
 const write=await handleAdmin(request({action:'APPEND_ONE',candidate}),env,{});assert.equal(write.status,200);assert.equal((await write.json()).status,'DONE');assert.equal(calls,2);
 }finally{operator.operateMonthlyReport=old;}
});
