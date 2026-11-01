import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {commitOwnerCorrection,createOwnerCorrectionDraft,loadOwnerExpense,ownerCorrectionStatus} from '../dist/expense/owner-correction-repository.js';
import {processOwnerCorrectionJob} from '../dist/sheets/owner-correction-worker.js';
import {inspectOwnerCorrectionTargets} from '../dist/sheets/owner-correction-inspection.js';

async function setup(move=false){
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},clock={now:Date.parse('2026-10-28T10:00:00Z')};
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_worker','msg_worker','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_worker'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',clock.now);
  const daily=Array(23).fill(null);Object.assign(daily,{1:10,2:28,3:'Driver',7:2000,21:'general',22:'บัญชีร้าน'});const raw=['exp_worker','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED'];
  const patches=[{metadataId:1,cells:[{columnIndex:21,value:move?'':'transport'}]},{metadataId:2,cells:[{columnIndex:6,value:'transport'}]}],originalRows=[{metadataId:1,values:daily},{metadataId:2,values:raw}];
  if(move){patches.push({metadataId:3,cells:[{columnIndex:21,value:'transport'}]});originalRows.push({metadataId:3,values:Array(22).fill(null)});}
  const plan={expenseId:'exp_worker',dailyMetadataId:1,rawMetadataId:2,patches,originalRows,rebind:move?{sourceMetadataId:1,reservationMetadataId:3,sheetId:100,correctionId:id}:null};
  const e={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,syncInProgress:false};
  assert.equal(await commitOwnerCorrection(h.env,owner,id,e,'trace',clock.now,plan),2);
  const rows=new Map(originalRows.map(row=>[row.metadataId,[...row.values]])),stats={patches:0,rebinds:0,failAfterWrite:false,failBeforeWrite:false,failAfterRebind:false,failBeforeRebind:false},meta={moved:false};
  const ports={now:()=>clock.now,inspect:async()=>({identitiesVerified:true,rows:new Map([...rows].map(([key,value])=>[key,[...value]]))}),
    patch:async(p,beforeDispatch)=>{await beforeDispatch();stats.patches++;if(stats.failBeforeWrite){stats.failBeforeWrite=false;throw new Error('synthetic timeout before write');}for(const row of p.patches)for(const cell of row.cells)rows.get(row.metadataId)[cell.columnIndex]=cell.value;if(stats.failAfterWrite){stats.failAfterWrite=false;throw new Error('synthetic timeout after write');}},
    inspectRebind:async()=>({source:meta.moved?null:{metadataId:1,metadataKey:'malipang_expense_daily',metadataValue:'exp_worker',sheetId:100,rowIndex:10},reservation:{metadataId:3,metadataKey:meta.moved?'malipang_expense_daily':'malipang_correction_reservation',metadataValue:meta.moved?'exp_worker':id,sheetId:100,rowIndex:20},sourceRowIndex:10,destinationRowIndex:20,valuesVerified:true}),
    rebind:async(_p,_inspection,beforeDispatch)=>{await beforeDispatch();stats.rebinds++;if(stats.failBeforeRebind){stats.failBeforeRebind=false;throw new Error('synthetic timeout before rebind');}meta.moved=true;if(stats.failAfterRebind){stats.failAfterRebind=false;throw new Error('synthetic timeout after rebind');}},
    reconcile:async()=>({expenseId:'exp_worker',version:2,dailyMatches:true,rawMatches:true,detailsMatch:true,reportsMatch:true,duplicateCount:0,lostCount:0})};
  return {...h,owner,id,job:{expenseId:'exp_worker',version:2},clock,rows,stats,ports};
}
test('orchestrator completes a verified correction once and exposes reconciled status',async()=>{
  const h=await setup();try{assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'COMPLETED');assert.equal(h.stats.patches,1);assert.equal(await ownerCorrectionStatus(h.env,h.owner,h.id,h.clock.now),'COMPLETED');assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'IGNORED');}finally{h.close()}
});
test('orchestration can use real identity inspection logic against independently read rows',async()=>{
  const h=await setup();try{
    Object.assign(h.env,{SHEET_EXPENSE_DAILY:'daily',SHEET_EXPENSE_RAW:'raw',SHEET_PURCHASE_DETAILS:'detail'});
    const metadata=[{metadataId:1,metadataKey:'malipang_expense_daily',metadataValue:'exp_worker',sheetId:1,rowIndex:10},{metadataId:2,metadataKey:'malipang_expense_raw',metadataValue:'exp_worker',sheetId:2,rowIndex:1}];
    const ports={sheetId:async(_env,name)=>({daily:1,raw:2,detail:3})[name],metadata:async(_env,key)=>metadata.filter(item=>item.metadataKey===key),rows:async()=>new Map([...h.rows].map(([key,value])=>[key,[...value]]))};
    h.ports.inspect=plan=>inspectOwnerCorrectionTargets(h.env,plan,ports);
    assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'COMPLETED');assert.equal(h.stats.patches,1);
  }finally{h.close()}
});
test('timeout after an applied write is recovered after the lease without a second write',async()=>{
  const h=await setup();try{h.stats.failAfterWrite=true;assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'BUSY');assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'BUSY');h.clock.now+=15*60_000+1;assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'COMPLETED');assert.equal(h.stats.patches,1);}finally{h.close()}
});
test('timeout before a write is safely retried only after the uncertainty deadline',async()=>{
  const h=await setup();try{h.stats.failBeforeWrite=true;assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'BUSY');h.clock.now+=15*60_000+1;assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'COMPLETED');assert.equal(h.stats.patches,2);}finally{h.close()}
});
test('unexpected sheet values stop the job for review without a write',async()=>{
  const h=await setup();try{h.rows.get(2)[6]='rent';assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'REVIEW');assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'REVIEW');assert.equal(h.stats.patches,0);assert.equal(await ownerCorrectionStatus(h.env,h.owner,h.id,h.clock.now),'SYNC_REVIEW');}finally{h.close()}
});
test('a report mismatch holds the job for review rather than reporting completion',async()=>{
  const h=await setup();try{
    h.ports.reconcile=async()=>({expenseId:'exp_worker',version:2,dailyMatches:true,rawMatches:true,detailsMatch:true,reportsMatch:false,duplicateCount:0,lostCount:0});
    assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'REVIEW');assert.equal(await ownerCorrectionStatus(h.env,h.owner,h.id,h.clock.now),'SYNC_REVIEW');
    assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION'").get().status,'REVIEW');
    assert.equal(h.sqlite.prepare('SELECT reconciled_at FROM expense_owner_corrections').get().reconciled_at,null);
  }finally{h.close()}
});
test('moving a row applies values and rebinds exactly once',async()=>{
  const h=await setup(true);try{assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'COMPLETED');assert.equal(h.stats.patches,1);assert.equal(h.stats.rebinds,1);}finally{h.close()}
});
test('a rebind timeout is resolved by re-reading markers before any retry',async()=>{
  for(const after of [false,true]){
    const h=await setup(true);try{
      if(after)h.stats.failAfterRebind=true;else h.stats.failBeforeRebind=true;
      assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'BUSY');h.clock.now+=15*60_000+1;
      assert.equal(await processOwnerCorrectionJob(h.env,h.job,h.ports),'COMPLETED');assert.equal(h.stats.patches,1);assert.equal(h.stats.rebinds,after?1:2);
    }finally{h.close()}
  }
});
