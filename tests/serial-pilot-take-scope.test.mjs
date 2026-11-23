import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {takePausedPilot}=createRequire(import.meta.url)('../dist/sheets/parked-notice-adoption.js');
const job={entityType:'EXPENSE',entityKey:'example',entityVersion:1,traceId:'trace'};
function fixture(drift){
 let stable=true,updates=0;
 const env={CF_VERSION_METADATA:{id:'worker'},CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED:'true',CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED:'false',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',STABLE_PHASE1_ENABLED:'true',STABLE_CANCELLATION_PREIMAGE_ENABLED:'true',SHEETS_SYNC_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'\u0e23\u0e32\u0e22\u0e27\u0e31\u0e19\u0e15\u0e48\u0e2d\u0e40\u0e19\u0e37\u0e48\u0e2d\u0e07_\u0e41\u0e1a\u0e1a\u0e23\u0e48\u0e32\u0e07',GOOGLE_SPREADSHEET_ID:'book',SERIAL_ATTESTED_HANDOFF_ENABLED:'true'};
 env.DB={prepare(sql){return{bind(){return{async all(){if(sql.startsWith('UPDATE stable_workbook_claims')){updates++;if(drift==='after-take')stable=false;if(drift==='ack-lost')throw Error('synthetic response lost');return{success:true,results:[{took:1}]};}if(drift==='after-read')stable=false;return{success:true,results:[{token:'token'}]};}};}};}};
 return{env,valid:()=>stable,get updates(){return updates;}};
}
test('scope loss after reading cannot take a reserved pilot',async()=>{
 const f=fixture('after-read');await assert.rejects(()=>takePausedPilot(f.env,job,'lease',f.valid),/PILOT_TAKE_UNCERTAIN/);assert.equal(f.updates,0);
});
test('scope loss after a take is reported as uncertain, not no-op',async()=>{
 const f=fixture('after-take');await assert.rejects(()=>takePausedPilot(f.env,job,'lease',f.valid),/PILOT_TAKE_UNCERTAIN/);assert.equal(f.updates,1);
});
test('a lost take acknowledgement reports uncertainty after the possible commit',async()=>{
 const f=fixture('ack-lost');await assert.rejects(()=>takePausedPilot(f.env,job,'lease',f.valid),/PILOT_TAKE_UNCERTAIN/);assert.equal(f.updates,1);
});
