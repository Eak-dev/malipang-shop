import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {createOwnerCorrectionDraft,loadOwnerExpense} from '../dist/expense/owner-correction-repository.js';
import {ensureOwnerCorrectionCellGuards} from '../dist/sheets/owner-correction-cell-guard-service.js';
import {cleanupOwnerCorrectionCellGuards} from '../dist/sheets/owner-correction-cell-guard-cleanup.js';

async function setup(){
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},clock={now:Date.now()};Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',GOOGLE_SERVICE_ACCOUNT_EMAIL:'synthetic@example.invalid',SHEET_EXPENSE_DAILY:'daily'});
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_cleanup','msg_cleanup','fixture_staff','Synthetic driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_cleanup'),id=await createOwnerCorrectionDraft(h.env,owner,before,'description','Changed driver',clock.now),plan={expenseId:'exp_cleanup',dailyMetadataId:12,rawMetadataId:13,patches:[{metadataId:12,cells:[{columnIndex:3,value:'Changed driver'}]},{metadataId:13,cells:[{columnIndex:2,value:'Changed driver'}]}],originalRows:[],rebind:null};
  const metadata={metadataId:12,metadataKey:'malipang_expense_daily',metadataValue:'exp_cleanup',sheetId:5,rowIndex:20},ranges=[],requests=[];let next=100;
  const ports={now:()=>clock.now,metadata:async()=>({...metadata}),sheetId:async()=>5,ranges:async()=>({sheetId:5,ranges:structuredClone(ranges)}),batch:async(_env,ops,arm)=>{await arm();requests.push(structuredClone(ops));for(const op of ops){if(op.addProtectedRange)ranges.push({...op.addProtectedRange.protectedRange,protectedRangeId:next++,requestingUserCanEdit:true});else if(op.deleteProtectedRange){const index=ranges.findIndex(x=>x.protectedRangeId===op.deleteProtectedRange.protectedRangeId);if(index<0)throw Error('missing guard');ranges.splice(index,1)}}}};
  assert.equal((await ensureOwnerCorrectionCellGuards(h.env,owner,id,before,plan,ports)).kind,'READY');
  return {...h,owner,clock,before,id,plan,metadata,ranges,requests,ports};
}
test('guard cleanup waits until a draft ends and never changes the expense',async()=>{
  const h=await setup();try{
    assert.deepEqual(await cleanupOwnerCorrectionCellGuards(h.env,h.ports),{removed:0,review:0});h.sqlite.prepare("UPDATE expense_owner_corrections SET status='CANCELLED' WHERE correction_id=?").run(h.id);
    assert.deepEqual(await cleanupOwnerCorrectionCellGuards(h.env,h.ports),{removed:1,review:0});assert.equal(h.ranges.length,0);assert.equal(h.sqlite.prepare('SELECT state FROM expense_owner_correction_cell_guards').get().state,'REMOVED');
    assert.equal(h.sqlite.prepare('SELECT description FROM expense_events').get().description,'Synthetic driver');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);
  }finally{h.close()}
});
test('a reconciled correction is eligible and cleanup remains active after feature rollback',async()=>{
  const h=await setup();try{
    h.sqlite.prepare("UPDATE expense_owner_corrections SET status='APPLIED',reconciled_at='now' WHERE correction_id=?").run(h.id);h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';
    assert.deepEqual(await cleanupOwnerCorrectionCellGuards(h.env,h.ports),{removed:1,review:0});assert.equal(h.ranges.length,0);
  }finally{h.close()}
});
test('lost cleanup response does not dispatch a second deletion while the request may be in flight',async()=>{
  const h=await setup();try{
    h.sqlite.prepare("UPDATE expense_owner_corrections SET status='CANCELLED' WHERE correction_id=?").run(h.id);const batch=h.ports.batch;let first=true;
    h.ports.batch=async(...args)=>{await batch(...args);if(first){first=false;throw Error('synthetic timeout')}};
    assert.deepEqual(await cleanupOwnerCorrectionCellGuards(h.env,h.ports),{removed:0,review:1});assert.equal(h.ranges.length,0);assert.equal(h.requests.length,2);
    assert.deepEqual(await cleanupOwnerCorrectionCellGuards(h.env,h.ports),{removed:0,review:0});h.clock.now+=15*60_000+1;
    assert.deepEqual(await cleanupOwnerCorrectionCellGuards(h.env,h.ports),{removed:1,review:0});assert.equal(h.requests.length,2);
  }finally{h.close()}
});
test('altered or overlapping guards are retained for review, not removed',async()=>{
  for(const mode of ['renamed','overlap','replaced']){const h=await setup();try{
    h.sqlite.prepare("UPDATE expense_owner_corrections SET status='CANCELLED' WHERE correction_id=?").run(h.id);
    if(mode==='renamed')h.ranges[0].description='changed';else if(mode==='replaced')h.ranges[0].protectedRangeId=999;else h.ranges.push({...h.ranges[0],protectedRangeId:999,description:'other'});
    assert.deepEqual(await cleanupOwnerCorrectionCellGuards(h.env,h.ports),{removed:0,review:1});assert.equal(h.requests.length,1);assert.ok(h.ranges.length>0);
  }finally{h.close()}}
});
