import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {grantSyntheticOpenPeriods,syntheticCorrectionHeaders,syntheticCorrectionHeaderDigest,syntheticCorrectionReport} from './helpers/owner-correction-periods.mjs';
import {commitOwnerCorrection,createOwnerCorrectionDraft,loadOwnerExpense} from '../dist/expense/owner-correction-repository.js';
import {claimOwnerCorrectionLease} from '../dist/sheets/owner-correction-lease.js';
import {advanceOwnerCorrectionSyncPhase,armOwnerCorrectionDispatch,finalizeOwnerCorrectionSync} from '../dist/sheets/owner-correction-sync-state.js';
import {recoverOwnerCorrectionRebind,recoverOwnerCorrectionValues} from '../dist/sheets/owner-correction-recover-state.js';

async function setup(move){
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-28T10:00:00Z');
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_phase','msg_phase','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_phase'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',now);
  const patches=[{metadataId:1,cells:[{columnIndex:21,value:'transport'}]},{metadataId:2,cells:[{columnIndex:6,value:'transport'}]}],originalRows=[{metadataId:1,values:Array(22).fill(null)},{metadataId:2,values:[null,null,null,null,null,null,'general']}];
  if(move){patches.push({metadataId:3,cells:[{columnIndex:21,value:'transport'}]});originalRows.push({metadataId:3,values:Array(22).fill(null)});}
  const plan={expenseId:'exp_phase',dailyMetadataId:1,rawMetadataId:2,patches,originalRows,rebind:move?{sourceMetadataId:1,reservationMetadataId:3,sheetId:100,correctionId:id}:null,headerDigest:syntheticCorrectionHeaderDigest,reportBaseline:syntheticCorrectionReport(before)};
  const evidence={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false,periodHeaders:syntheticCorrectionHeaders()};await grantSyntheticOpenPeriods(h,id,evidence.periodHeaders);
  assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now,plan),2);
  const job={expenseId:'exp_phase',version:2},token=await claimOwnerCorrectionLease(h.env,job,now);assert.ok(token);
  return {...h,id,job,token,now};
}
test('sync phases require the active lease and cannot skip required verification',async()=>{
  const h=await setup(false);try{
    assert.equal(await armOwnerCorrectionDispatch(h.env,h.job,h.id,'wrong','VALUES',h.now),null);
    assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,h.token,'PREPARED','IDENTITY_VERIFIED',h.now),false);
    const token=await armOwnerCorrectionDispatch(h.env,h.job,h.id,h.token,'VALUES',h.now);assert.ok(token);assert.notEqual(token,h.token);
    assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,h.token,'PREPARED','VALUES_IN_FLIGHT',h.now),false);
    assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,token,'VALUES_IN_FLIGHT','VALUES_VERIFIED',h.now),true);
    assert.equal(await armOwnerCorrectionDispatch(h.env,h.job,h.id,token,'REBIND',h.now),null);
    assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,token,'VALUES_VERIFIED','IDENTITY_VERIFIED',h.now),true);
    assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,token,'IDENTITY_VERIFIED','RECONCILED',h.now),false);
  }finally{h.close()}
});
test('completion requires clean reconciliation of every projection and exactly one job',async()=>{
  const h=await setup(false);try{
    const token=await armOwnerCorrectionDispatch(h.env,h.job,h.id,h.token,'VALUES',h.now);assert.ok(token);
    assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,token,'VALUES_IN_FLIGHT','VALUES_VERIFIED',h.now),true);
    assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,token,'VALUES_VERIFIED','IDENTITY_VERIFIED',h.now),true);
    const evidence={expenseId:'exp_phase',version:2,dailyMatches:true,rawMatches:true,detailsMatch:true,reportsMatch:true,duplicateCount:0,lostCount:0};
    assert.equal(await finalizeOwnerCorrectionSync(h.env,h.job,h.id,token,{...evidence,reportsMatch:false},h.now),false);
    assert.equal(await finalizeOwnerCorrectionSync(h.env,h.job,h.id,token,{...evidence,duplicateCount:1},h.now),false);
    assert.equal(await finalizeOwnerCorrectionSync(h.env,h.job,h.id,'wrong',evidence,h.now),false);
    assert.equal(await finalizeOwnerCorrectionSync(h.env,h.job,h.id,token,evidence,h.now),true);
    assert.equal(await finalizeOwnerCorrectionSync(h.env,h.job,h.id,token,evidence,h.now),false);
    assert.equal(h.sqlite.prepare('SELECT phase FROM expense_owner_correction_sync').get().phase,'RECONCILED');
    assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION'").get().status,'COMPLETED');
    assert.ok(h.sqlite.prepare('SELECT reconciled_at FROM expense_owner_corrections').get().reconciled_at);
  }finally{h.close()}
});
test('a reconciliation transaction failure never marks only part of the job complete',async()=>{
  for(let failAt=0;failAt<4;failAt++){
    const h=await setup(false);try{
      const token=await armOwnerCorrectionDispatch(h.env,h.job,h.id,h.token,'VALUES',h.now);assert.ok(token);
      await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,token,'VALUES_IN_FLIGHT','VALUES_VERIFIED',h.now);
      await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,token,'VALUES_VERIFIED','IDENTITY_VERIFIED',h.now);
      const e={expenseId:'exp_phase',version:2,dailyMatches:true,rawMatches:true,detailsMatch:true,reportsMatch:true,duplicateCount:0,lostCount:0};
      h.DB.failAt=failAt;await assert.rejects(finalizeOwnerCorrectionSync(h.env,h.job,h.id,token,e,h.now),/fixture batch failure/);
      assert.equal(h.sqlite.prepare('SELECT phase FROM expense_owner_correction_sync').get().phase,'IDENTITY_VERIFIED');
      assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION'").get().status,'PROCESSING');
      assert.equal(h.sqlite.prepare('SELECT reconciled_at FROM expense_owner_corrections').get().reconciled_at,null);
    }finally{h.close()}
  }
});
test('rebind recovery checks marker identities after the uncertain-write deadline',async()=>{
  for(const outcome of ['BEFORE','AFTER','CONFLICT']){
    const h=await setup(true);try{
      const a=await armOwnerCorrectionDispatch(h.env,h.job,h.id,h.token,'VALUES',h.now);assert.ok(a);
      assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,a,'VALUES_IN_FLIGHT','VALUES_VERIFIED',h.now),true);
      const b=await armOwnerCorrectionDispatch(h.env,h.job,h.id,a,'REBIND',h.now);assert.ok(b);
      const source={metadataId:1,metadataKey:'malipang_expense_daily',metadataValue:'exp_phase',sheetId:100,rowIndex:10};
      const reservation={metadataId:3,metadataKey:'malipang_correction_reservation',metadataValue:h.id,sheetId:100,rowIndex:20};
      const input={source,reservation,sourceRowIndex:10,destinationRowIndex:20,valuesVerified:true};
      if(outcome==='AFTER'){input.source=null;input.reservation={...reservation,metadataKey:'malipang_expense_daily',metadataValue:'exp_phase'};}
      if(outcome==='CONFLICT')input.valuesVerified=false;
      assert.equal(await recoverOwnerCorrectionRebind(h.env,h.job,h.id,b,input,h.now+1000),'WAIT');
      const later=h.now+15*60_000+1,token=await claimOwnerCorrectionLease(h.env,h.job,later);assert.ok(token);
      const result=await recoverOwnerCorrectionRebind(h.env,h.job,h.id,token,input,later);
      assert.equal(result,outcome==='BEFORE'?'RETRY':outcome==='AFTER'?'ADVANCE':'REVIEW');
    }finally{h.close()}
  }
});
test('a moved row cannot skip rebind, and a changed expense version fences the next step',async()=>{
  const h=await setup(true);try{
    const valuesToken=await armOwnerCorrectionDispatch(h.env,h.job,h.id,h.token,'VALUES',h.now);assert.ok(valuesToken);
    assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,valuesToken,'VALUES_IN_FLIGHT','VALUES_VERIFIED',h.now),true);
    assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,valuesToken,'VALUES_VERIFIED','IDENTITY_VERIFIED',h.now),false);
    const rebindToken=await armOwnerCorrectionDispatch(h.env,h.job,h.id,valuesToken,'REBIND',h.now);assert.ok(rebindToken);
    h.sqlite.prepare("UPDATE expense_events SET version=3 WHERE expense_id='exp_phase'").run();
    assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,rebindToken,'REBIND_IN_FLIGHT','IDENTITY_VERIFIED',h.now),false);
  }finally{h.close()}
});
test('failure while arming dispatch leaves both the old lease and phase intact',async()=>{
  for(let failAt=0;failAt<3;failAt++){
    const h=await setup(false);try{
      h.DB.failAt=failAt;await assert.rejects(armOwnerCorrectionDispatch(h.env,h.job,h.id,h.token,'VALUES',h.now),/fixture batch failure/);
      assert.equal(h.sqlite.prepare('SELECT phase FROM expense_owner_correction_sync').get().phase,'PREPARED');
      assert.equal(h.sqlite.prepare("SELECT lease_token FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION'").get().lease_token,h.token);
    }finally{h.close()}
  }
});
test('unknown result after arming keeps the new lease and records a safe recovery deadline',async()=>{
  const h=await setup(false);try{
    h.DB.failAfterCommit=true;await assert.rejects(armOwnerCorrectionDispatch(h.env,h.job,h.id,h.token,'VALUES',h.now),/fixture crash after commit/);h.DB.failAfterCommit=false;
    const state=h.sqlite.prepare('SELECT phase,not_before,dispatch_id FROM expense_owner_correction_sync').get();
    const lease=h.sqlite.prepare("SELECT lease_token,lease_until FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION'").get();
    assert.equal(state.phase,'VALUES_IN_FLIGHT');assert.ok(state.dispatch_id);assert.equal(state.not_before,lease.lease_until);assert.notEqual(lease.lease_token,h.token);
  }finally{h.close()}
});
test('recovery waits for the old deadline and distinguishes retry, success and conflict',async()=>{
  for(const outcome of ['BEFORE','AFTER','CONFLICT']){
    const h=await setup(false);try{
      const token=await armOwnerCorrectionDispatch(h.env,h.job,h.id,h.token,'VALUES',h.now);assert.ok(token);
      const daily=Array(22).fill(null),raw=[null,null,null,null,null,null,'general'];
      if(outcome!=='BEFORE')daily[21]='transport';if(outcome==='AFTER')raw[6]='transport';
      const observed=new Map([[1,daily],[2,raw]]);
      assert.equal(await recoverOwnerCorrectionValues(h.env,h.job,h.id,token,observed,true,h.now+1000),'WAIT');
      const later=h.now+15*60_000+1,newToken=await claimOwnerCorrectionLease(h.env,h.job,later);assert.ok(newToken);
      assert.equal(await advanceOwnerCorrectionSyncPhase(h.env,h.job,h.id,newToken,'VALUES_IN_FLIGHT','VALUES_VERIFIED',later),false,'a reclaimed lease must use state recovery');
      const actual=await recoverOwnerCorrectionValues(h.env,h.job,h.id,newToken,observed,true,later);
      assert.equal(actual,outcome==='BEFORE'?'RETRY':outcome==='AFTER'?'ADVANCE':'REVIEW');
      assert.equal(h.sqlite.prepare('SELECT phase FROM expense_owner_correction_sync').get().phase,outcome==='BEFORE'?'PREPARED':outcome==='AFTER'?'VALUES_VERIFIED':'REVIEW');
    }finally{h.close()}
  }
});
