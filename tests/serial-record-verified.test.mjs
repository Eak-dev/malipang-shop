import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),serial=require('../dist/admin/serial-expense-handover.js'),readback=require('../dist/admin/normal-pilot-readback.js');
const version='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',jobId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',roundId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',fingerprint='d'.repeat(64);
const row={audit_count:1,target_count:1,audit_id:'audit',job:'COMPLETED',epoch:'COMPLETE',unleased:1,clean:1,all_written:1,claim:null,unfinished:0,open_failure:0,revision_valid:1,revision:7,epoch_id:'normal_pilot296_test',proof_inputs:'synthetic'};
const proof=createHash('sha256').update(JSON.stringify(['pilot-finish-v2',version,jobId,fingerprint,row.revision,row.proof_inputs])).digest('hex');
const action={action:'RECORD_VERIFIED',jobId,roundId,fingerprint,proof,ownerSupervising:true,externalWritersFenced:true};
function fixture({lost=false,readOk=true,drift=false}={}){
 let saved=null,writes=0;const current={...row};
 const db={prepare(sql){return {bind(...args){return {sql,args,async all(){return {success:true,results:sql.includes('FROM serial_pilot_verified_evidence v')?(saved?[saved]:[]):[{...current}]};}};}};},async batch(){writes++;if(drift)throw Error('synthetic CAS failure');saved={proof,worker_version:version,proof_algorithm:'pilot-finish-v2'};if(lost)throw Error('synthetic lost ACK');return [{success:true},{success:true}];}};
 return {env:{DB:db,GOOGLE_SPREADSHEET_ID:'book',CONTINUOUS_DAILY_SHEET_ID:'1',CONTINUOUS_DAILY_SHEET:'daily',CONTINUOUS_RAW_SHEET_ID:'2',CONTINUOUS_RAW_SHEET:'raw',CONTINUOUS_DETAIL_SHEET_ID:'3',CONTINUOUS_DETAIL_SHEET:'detail'},current,get writes(){return writes;},readOk};
}
test('verified receipt requires readback and reconciles a lost D1 response without another write',async()=>{
 const old=readback.verifyNormalPilotRow;
 try{
  const h=fixture({lost:true});readback.verifyNormalPilotRow=async()=>true;
  assert.deepEqual(await serial.recordVerifiedPilot(h.env,action,version,()=>true),{ok:true,outcome:'RECORDED'});assert.equal(h.writes,1);
  assert.deepEqual(await serial.recordVerifiedPilot(h.env,action,version,()=>true),{ok:true,outcome:'RECORDED'});assert.equal(h.writes,1);
  const absent=fixture();readback.verifyNormalPilotRow=async()=>false;assert.equal((await serial.recordVerifiedPilot(absent.env,action,version,()=>true)).outcome,'HELD');assert.equal(absent.writes,0);
  const changed=fixture();readback.verifyNormalPilotRow=async()=>{changed.current.revision++;return true;};assert.equal((await serial.recordVerifiedPilot(changed.env,action,version,()=>true)).outcome,'HELD');assert.equal(changed.writes,0);
  const drift=fixture({drift:true});readback.verifyNormalPilotRow=async()=>true;assert.equal((await serial.recordVerifiedPilot(drift.env,action,version,()=>true)).outcome,'UNCERTAIN');assert.equal(drift.writes,1);
 }finally{readback.verifyNormalPilotRow=old;}
});
