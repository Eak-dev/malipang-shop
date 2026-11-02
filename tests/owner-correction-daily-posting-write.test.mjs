import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
const require=createRequire(import.meta.url),{reserveDailyPosting}=require('../dist/sheets/owner-correction-daily-posting-reservation.js'),{activateDailyIdentityLatch}=require('../dist/sheets/owner-correction-daily-identity-guard.js'),{prepareDailyPostingWrite:prepare,dispatchDailyPostingWrite:dispatch,recoverDailyPostingWrite:recover}=require('../dist/sheets/owner-correction-daily-posting-write.js'),fence=require('../dist/sheets/owner-correction-daily-write-fence.js');
async function setup(){
 const h=ownerOrderFixture(),now=Date.now();Object.assign(h.env,{SHEET_EXPENSE_DAILY:'daily',OWNER_EXPENSE_CORRECTION_ENABLED:'true',EXTERNAL_API_TIMEOUT_MS:'1000'});
 h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,updated_at,version) VALUES('exp_post','msg_post','fixture_staff','Synthetic',10000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','2026-10-28','2026-10-28',1)`).run();
 h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_token,lease_until) VALUES('job_post','EXPENSE','exp_post',1,'trace_post','PROCESSING',1,'2026-10-28','lease_post','2099-01-01')`).run();
 const token=await fence.claimCorrectionDailyWriteFence(h.env,'daily',now);assert.equal(await activateDailyIdentityLatch(h.env,'daily',token,now),true);
 const snapshot={expenseId:'exp_post',version:1,updatedAt:'2026-10-28',description:'Synthetic',category:'general',amountSatang:10000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'},headers=[[],[],[]],input={sheetId:1,rowNumber:10,metadataId:123,headers,fenceToken:token,syncToken:'lease_post'};
 const reservation=await reserveDailyPosting(h.env,snapshot,input,now);assert.ok(reservation);h.sqlite.prepare(`UPDATE daily_identity_posting_reservations SET state='VERIFIED' WHERE expense_id='exp_post'`).run();
 const state={clock:now,sent:0,mode:'success',calls:0,observation:{marker:{metadataId:123,metadataKey:'malipang_expense_daily',metadataValue:'exp_post',sheetId:1,rowIndex:9},headerDigest:reservation.headerDigest,sheetYear:2026,monthBlock:{month:10,headerRow:6,totalRow:20},values:[],formulas:[],observedColumnCount:25,completeIdentityAndProtection:true,formulasVerified:true}};
 state.observation.formulas[8]='=G10+H10';state.observation.formulas[17]='=SUM(K10:Q10)';state.observation.formulas[20]='=DATE(2026,B10,C10)';
 const ports={now:()=>state.clock,observe:async()=>{state.calls++;if(state.mode==='bad-final'&&state.calls>4)return null;return structuredClone(state.observation)},patch:async(_env,patches,allowed,before)=>{
  if(state.mode==='before-callback')throw Error('synthetic OAuth failure');await before();state.sent++;assert.equal(patches[0].metadataId,123);assert.ok(patches[0].cells.every(cell=>allowed.includes(cell.columnIndex)));
  if(state.mode==='lost-before-provider')throw Error('synthetic lost request');for(const cell of patches[0].cells)state.observation.values[cell.columnIndex]=cell.value;if(state.mode==='lost-after-provider')throw Error('synthetic lost response');
 }};
 async function nextFence(){state.clock=now+15*60_000+1;const next=await fence.claimCorrectionDailyWriteFence(h.env,'daily',state.clock);assert.ok(next);return {...input,fenceToken:next}}
 return {...h,now,snapshot,reservation,input,state,ports,nextFence};
}
test('prepares only a blank, protected and verified marker with a current job lease',async()=>{
 const h=await setup();try{assert.equal(await prepare(h.env,h.snapshot,h.reservation,h.input,h.ports),'PREPARED');assert.equal(await prepare(h.env,h.snapshot,h.reservation,h.input,h.ports),'PREPARED');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM daily_identity_posting_write_intents').get().n,1);
 h.input.syncToken='wrong';assert.equal(await prepare(h.env,h.snapshot,h.reservation,h.input,h.ports),'REVIEW');assert.equal(h.state.sent,0);
 }finally{h.close()}
});
test('missing proof, occupied/formula cells, wrong period or changed marker are held',async()=>{
 for(const mode of ['unprotected','untrusted-formula','occupied','report-source','short-read','input-formula','month','year','marker','header','reservation']){const h=await setup();try{
  const o=h.state.observation;if(mode==='unprotected')o.completeIdentityAndProtection=false;if(mode==='untrusted-formula')o.formulasVerified=false;if(mode==='occupied')o.values[4]='unrelated';if(mode==='report-source')o.values[23]='old category';if(mode==='short-read')o.observedColumnCount=23;if(mode==='input-formula')o.formulas[7]='=1';if(mode==='month')o.monthBlock.month=9;if(mode==='year')o.sheetYear=2025;if(mode==='marker')o.marker.rowIndex++;if(mode==='header')o.headerDigest='changed';if(mode==='reservation')h.sqlite.prepare(`UPDATE daily_identity_posting_reservations SET state='PREPARED'`).run();
  assert.equal(await prepare(h.env,h.snapshot,h.reservation,h.input,h.ports),'REVIEW',mode);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM daily_identity_posting_write_intents').get().n,0);assert.equal(h.state.sent,0);
 }finally{h.close()}}
});
test('dispatch atomically arms intent, fence and job lease before patching metadata',async()=>{
 const h=await setup();try{assert.equal(await prepare(h.env,h.snapshot,h.reservation,h.input,h.ports),'PREPARED');assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.input,h.ports),'PENDING');assert.equal(h.state.sent,1);
 const row=h.sqlite.prepare('SELECT state,dispatch_id,not_before FROM daily_identity_posting_write_intents').get(),lock=h.sqlite.prepare('SELECT state,dispatch_id,not_before FROM owner_correction_daily_write_fences').get(),job=h.sqlite.prepare('SELECT lease_until FROM sync_jobs').get();
 assert.equal(row.state,'IN_FLIGHT');assert.equal(lock.state,'IN_FLIGHT');assert.equal(row.dispatch_id,lock.dispatch_id);assert.equal(row.not_before,lock.not_before);assert.ok(job.lease_until>=row.not_before);assert.equal(job.lease_until,'2099-01-01');
 assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.input,h.ports),'PENDING');assert.equal(h.state.sent,1);
 }finally{h.close()}
});
test('stale job, changed mapping or failed final observation never dispatch',async()=>{
 for(const mode of ['job','mapping','changed-expense','bad-final','before-callback']){const h=await setup();try{
  assert.equal(await prepare(h.env,h.snapshot,h.reservation,h.input,h.ports),'PREPARED');if(mode==='job')h.input.syncToken='wrong';else if(mode==='mapping')h.sqlite.prepare(`UPDATE sheet_row_index SET row_number=11`).run();else if(mode==='changed-expense')h.sqlite.prepare(`UPDATE expense_events SET amount_satang=20000`).run();else h.state.mode=mode;
  assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.input,h.ports),'REVIEW',mode);assert.equal(h.state.sent,0);assert.equal(h.sqlite.prepare('SELECT state FROM daily_identity_posting_write_intents').get().state,'PREPARED');
 }finally{h.close()}}
});
test('concurrent dispatch attempts patch the metadata once',async()=>{
 const h=await setup();try{assert.equal(await prepare(h.env,h.snapshot,h.reservation,h.input,h.ports),'PREPARED');const result=await Promise.all([dispatch(h.env,h.snapshot,h.reservation,h.input,h.ports),dispatch(h.env,h.snapshot,h.reservation,h.input,h.ports)]);assert.deepEqual(result,['PENDING','PENDING']);assert.equal(h.state.sent,1);}finally{h.close()}
});
test('lost write response requires delayed independent reconciliation and never blind resend',async()=>{
 for(const mode of ['lost-before-provider','lost-after-provider']){const h=await setup();try{
  assert.equal(await prepare(h.env,h.snapshot,h.reservation,h.input,h.ports),'PREPARED');h.state.mode=mode;assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.input,h.ports),'PENDING');assert.equal(h.state.sent,1);
  assert.equal(await recover(h.env,h.snapshot,h.reservation,h.input,h.ports),'WAIT');const next=await h.nextFence();assert.equal(await recover(h.env,h.snapshot,h.reservation,next,h.ports),mode==='lost-after-provider'?'VALUES_VERIFIED':'REVIEW');
  assert.equal(await dispatch(h.env,h.snapshot,h.reservation,next,h.ports),mode==='lost-after-provider'?'REVIEW':'PENDING');assert.equal(h.state.sent,1);
 }finally{h.close()}}
});
test('lost D1 commit response does not permit a second write',async()=>{
 const h=await setup();try{assert.equal(await prepare(h.env,h.snapshot,h.reservation,h.input,h.ports),'PREPARED');h.DB.failAfterCommit=true;assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.input,h.ports),'PENDING');h.DB.failAfterCommit=false;assert.equal(h.state.sent,0);assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.input,h.ports),'PENDING');
 const next=await h.nextFence();assert.equal(await recover(h.env,h.snapshot,h.reservation,next,h.ports),'REVIEW');assert.equal(h.state.sent,0);
 }finally{h.close()}
});
test('changed values, formulas, metadata, report proof or job lease remain for review',async()=>{
 for(const mode of ['value','unrelated','formula','marker','unproven','wrong-lease','unstable']){const h=await setup();try{
  assert.equal(await prepare(h.env,h.snapshot,h.reservation,h.input,h.ports),'PREPARED');assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.input,h.ports),'PENDING');const next=await h.nextFence();
  if(mode==='value')h.state.observation.values[7]=999;if(mode==='unrelated')h.state.observation.values[4]='other';if(mode==='formula')h.state.observation.formulas[8]='=1';if(mode==='marker')h.state.observation.marker.rowIndex++;if(mode==='unproven')h.state.observation.completeIdentityAndProtection=false;if(mode==='wrong-lease')next.syncToken='wrong';
  if(mode==='unstable'){const shared=structuredClone(h.state.observation);let calls=0;h.ports.observe=async()=>{if(++calls===2)shared.marker.rowIndex++;return shared}}
  assert.equal(await recover(h.env,h.snapshot,h.reservation,next,h.ports),'REVIEW',mode);assert.equal(h.sqlite.prepare('SELECT state FROM daily_identity_posting_write_intents').get().state,'IN_FLIGHT');assert.equal(h.state.sent,1);
 }finally{h.close()}}
});
