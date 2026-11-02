import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
const require=createRequire(import.meta.url),{reserveDailyPosting}=require('../dist/sheets/owner-correction-daily-posting-reservation.js'),{activateDailyIdentityLatch}=require('../dist/sheets/owner-correction-daily-identity-guard.js'),{dispatchDailyPostingMarker:dispatch,recoverDailyPostingMarker:recover}=require('../dist/sheets/owner-correction-daily-posting-marker.js'),fence=require('../dist/sheets/owner-correction-daily-write-fence.js');
async function setup(){
 const h=ownerOrderFixture(),now=Date.now();Object.assign(h.env,{SHEET_EXPENSE_DAILY:'daily',OWNER_EXPENSE_CORRECTION_ENABLED:'true',EXTERNAL_API_TIMEOUT_MS:'1000'});
 h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,updated_at,version) VALUES('exp_post','msg_post','fixture_staff','Synthetic',10000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','2026-10-28','2026-10-28',1)`).run();
 h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_token,lease_until) VALUES('job_post','EXPENSE','exp_post',1,'trace_post','PROCESSING',1,'2026-10-28','lease_post','2099-01-01')`).run();
 const token=await fence.claimCorrectionDailyWriteFence(h.env,'daily',now);assert.equal(await activateDailyIdentityLatch(h.env,'daily',token,now),true);
 const snapshot={expenseId:'exp_post',version:1,updatedAt:'2026-10-28',description:'Synthetic',category:'general',amountSatang:10000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'},candidate={sheetId:1,rowNumber:10,metadataId:123,headers:[[],[],[]],fenceToken:token,syncToken:'lease_post'};
 const reservation=await reserveDailyPosting(h.env,snapshot,candidate,now);assert.ok(reservation);
 const state={clock:now,marker:null,sent:0,verifies:0,mode:'success'};
 const ports={now:()=>state.clock,verify:async()=>{state.verifies++;return state.mode!=='bad-verifier'&&(state.mode!=='bad-final-verifier'||state.verifies===1)},create:async(_env,rows,before)=>{
  if(state.mode==='before-callback')throw Error('OAuth failure');await before();state.sent++;
  if(state.mode==='lost-before-provider')throw Error('synthetic lost request');state.marker={...rows[0],rowIndex:rows[0].rowIndex};if(state.mode==='lost-after-provider')throw Error('synthetic lost response');return [state.marker];
 }};
 const args={fenceToken:token,syncToken:'lease_post'},observe=async()=>({marker:state.marker?{...state.marker}:null,headerDigest:reservation.headerDigest,completeIdentityAndBlanknessAndProtection:true});
 async function nextFence(){state.clock=now+15*60_000+1;const next=await fence.claimCorrectionDailyWriteFence(h.env,'daily',state.clock);assert.ok(next);return {fenceToken:next,syncToken:'lease_post'}}
 return {...h,now,snapshot,reservation,state,ports,args,observe,nextFence};
}
test('marker dispatch atomically arms the reservation and shared fence before the provider request',async()=>{
 const h=await setup();try{assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.args,h.ports),'PENDING');assert.equal(h.state.sent,1);
 const row=h.sqlite.prepare('SELECT state,dispatch_id,not_before,fence_token FROM daily_identity_posting_reservations').get(),lock=h.sqlite.prepare('SELECT state,dispatch_id,not_before FROM owner_correction_daily_write_fences').get();
 assert.equal(row.state,'IN_FLIGHT');assert.equal(lock.state,'IN_FLIGHT');assert.equal(row.dispatch_id,lock.dispatch_id);assert.equal(row.not_before,lock.not_before);assert.equal(row.fence_token,h.args.fenceToken);
 assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.args,h.ports),'PENDING');assert.equal(h.state.sent,1);assert.equal(await fence.releaseCorrectionDailyWriteFence(h.env,'daily',h.args.fenceToken),false);
 }finally{h.close()}
});
test('stale snapshot, missing job lease or failed final verifier cannot dispatch',async()=>{
 for(const mode of ['job','snapshot','mapping','fence','bad-verifier','bad-final-verifier','before-callback']){const h=await setup();try{
  if(mode==='job')h.args.syncToken='wrong';else if(mode==='snapshot')h.sqlite.prepare(`UPDATE expense_events SET description='changed'`).run();else if(mode==='mapping')h.sqlite.prepare(`UPDATE sheet_row_index SET row_number=11`).run();else if(mode==='fence')h.sqlite.prepare(`UPDATE owner_correction_daily_write_fences SET lease_token='stolen'`).run();else h.state.mode=mode;
  assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.args,h.ports),'REVIEW',mode);assert.equal(h.state.sent,0,mode);assert.equal(h.sqlite.prepare('SELECT state FROM daily_identity_posting_reservations').get().state,'PREPARED',mode);assert.equal(h.sqlite.prepare('SELECT state FROM owner_correction_daily_write_fences').get().state,'OWNED',mode);
 }finally{h.close()}}
});
test('concurrent attempts can dispatch the persisted metadata ID at most once',async()=>{
 const h=await setup();try{const out=await Promise.all([dispatch(h.env,h.snapshot,h.reservation,h.args,h.ports),dispatch(h.env,h.snapshot,h.reservation,h.args,h.ports)]);assert.deepEqual(out,['PENDING','PENDING']);assert.equal(h.state.sent,1);assert.equal(h.state.marker.metadataId,123);}finally{h.close()}
});
test('lost provider response is inspected after the uncertainty window and never resent',async()=>{
 for(const mode of ['lost-before-provider','lost-after-provider']){const h=await setup();try{
  h.state.mode=mode;assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.args,h.ports),'PENDING');assert.equal(h.state.sent,1);
  assert.equal(await recover(h.env,h.snapshot,h.reservation,h.args,{observe:h.observe,now:()=>h.state.clock}),'WAIT');const newArgs=await h.nextFence();
  const result=await recover(h.env,h.snapshot,h.reservation,newArgs,{observe:h.observe,now:()=>h.state.clock});assert.equal(result,mode==='lost-after-provider'?'VERIFIED':'REVIEW');
  assert.equal(await dispatch(h.env,h.snapshot,h.reservation,newArgs,h.ports),mode==='lost-before-provider'?'PENDING':'REVIEW');assert.equal(h.state.sent,1);
 }finally{h.close()}}
});
test('a committed D1 callback with a lost response never triggers another provider request',async()=>{
 const h=await setup();try{h.DB.failAfterCommit=true;assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.args,h.ports),'PENDING');h.DB.failAfterCommit=false;assert.equal(h.state.sent,0);assert.equal(h.sqlite.prepare('SELECT state FROM daily_identity_posting_reservations').get().state,'IN_FLIGHT');
 assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.args,h.ports),'PENDING');assert.equal(h.state.sent,0);const newArgs=await h.nextFence();assert.equal(await recover(h.env,h.snapshot,h.reservation,newArgs,{observe:h.observe,now:()=>h.state.clock}),'REVIEW');
 }finally{h.close()}
});
test('recovery rejects missing, moved, changed or unproven marker evidence and stale leases',async()=>{
 for(const mode of ['missing','moved','wrong-sheet','unproven','changed-observation','changed-expense','wrong-lease']){const h=await setup();try{
  assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.args,h.ports),'PENDING');const args=await h.nextFence();let calls=0;
  const observe=async()=>{const o=await h.observe();if(mode==='missing')o.marker=null;if(mode==='moved')o.marker.rowIndex++;if(mode==='wrong-sheet')o.marker.sheetId++;if(mode==='unproven')o.completeIdentityAndBlanknessAndProtection=false;if(mode==='changed-observation'&&++calls===2)o.headerDigest='different';return o};
  if(mode==='changed-expense')h.sqlite.prepare(`UPDATE expense_events SET description='changed'`).run();if(mode==='wrong-lease')args.syncToken='wrong';
  assert.equal(await recover(h.env,h.snapshot,h.reservation,args,{observe,now:()=>h.state.clock}),'REVIEW',mode);assert.equal(h.sqlite.prepare('SELECT state FROM daily_identity_posting_reservations').get().state,'IN_FLIGHT',mode);assert.equal(h.state.sent,1);
 }finally{h.close()}}
});
test('recovery detects a reused mutable observation changing between reads',async()=>{
 const h=await setup();try{assert.equal(await dispatch(h.env,h.snapshot,h.reservation,h.args,h.ports),'PENDING');const args=await h.nextFence(),shared=await h.observe();let calls=0;
 const observe=async()=>{if(++calls===2)shared.marker.rowIndex++;return shared};
 assert.equal(await recover(h.env,h.snapshot,h.reservation,args,{observe,now:()=>h.state.clock}),'REVIEW');assert.equal(h.sqlite.prepare('SELECT state FROM daily_identity_posting_reservations').get().state,'IN_FLIGHT');assert.equal(h.state.sent,1);
 }finally{h.close()}
});
