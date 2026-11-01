import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {planDailyCategoryScan} from '../dist/sheets/daily-category-scan.js';
import {seedDailyCategoryBaseline,registerDailyCategoryProjectionTarget,requestDailyCategoryChange,approveDailyCategoryChange} from '../dist/sheets/daily-category-repository.js';
import {planDailyCategoryProjection} from '../dist/sheets/daily-category-projection.js';
import {buildMetadataColumnWriteRequest} from '../dist/sheets/client.js';
import {preflightDailyCategoryProjection,runDailyCategoryProjection} from '../dist/sheets/daily-category-projection-runner.js';

test('dropdown request, owner approval and category-only projection preserve the original expense',async()=>{
  const h=ownerOrderFixture(),now='2026-02-13T10:00:00.000Z';
  try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_flow','msg_flow','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED',?,1)`).run(now);
    const expense={expenseId:'exp_flow',postingYear:2026,postingMonth:10,postingDay:28,description:'Driver',amountSatang:200000,amountColumn:7,category:'general',version:1,fingerprint:'fixture',transactionDate:'2026-10-28'};
    const values=Array(23).fill(null);values[1]=10;values[2]=28;values[3]='Driver';values[7]=2000;values[21]='general';
    const sheet={rowNumber:100,sheetYear:2026,values,metadataId:11,metadataExpenseId:'exp_flow'};
    assert.equal(planDailyCategoryScan([expense],[sheet],new Map())[0].observation.kind,'BASELINE');
    const row={expenseId:'exp_flow',rowNumber:100,metadataId:11,fingerprint:'fixture',category:'general',expenseVersion:1};
    assert.equal(await seedDailyCategoryBaseline(h.env,row),true);
    assert.equal(await registerDailyCategoryProjectionTarget(h.env,{expenseId:'exp_flow',targetType:'RAW',itemId:'',metadataId:21,expenseVersion:1}),true);
    assert.equal(await registerDailyCategoryProjectionTarget(h.env,{expenseId:'exp_flow',targetType:'ITEM',itemId:'not-owned',metadataId:22,expenseVersion:1}),false);
    sheet.values[21]='transport';const baseline={category:'general',version:1,rowNumber:100,metadataId:11,fingerprint:'fixture'};
    assert.equal(planDailyCategoryScan([expense],[sheet],new Map([['exp_flow',baseline]]))[0].observation.kind,'OWNER_REVIEW');
    const requestId=await requestDailyCategoryChange(h.env,row,'transport');assert.ok(requestId);
    assert.equal(h.sqlite.prepare("SELECT category FROM expense_events WHERE expense_id='exp_flow'").get().category,'general');
    h.env.SHEET_EXPENSE_RAW='raw';h.env.SHEET_PURCHASE_DETAILS='detail';
    const rawBefore=['exp_flow',null,null,null,null,null,'general','CONFIRMED'];
    const prePorts={sheetId:async(_env,name)=>name==='raw'?1:2,search:async(_env,key)=>key==='malipang_expense_raw'?[{metadataId:21,metadataKey:key,metadataValue:'exp_flow',sheetId:1,rowIndex:5}]:[],read:async()=>new Map([[21,rawBefore]]),write:async()=>{throw new Error('preflight must not write')}};
    await preflightDailyCategoryProjection(h.env,{expenseId:'exp_flow',version:1,fromCategory:'general',toCategory:'transport'},prePorts);
    rawBefore[6]='transport';await assert.rejects(preflightDailyCategoryProjection(h.env,{expenseId:'exp_flow',version:1,fromCategory:'general',toCategory:'transport'},prePorts),/TARGET_CHANGED/);rawBefore[6]='general';
    assert.equal(await approveDailyCategoryChange(h.env,{requestId,row,observedCategory:'transport',owner:{employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},traceId:'fixture'}),2);
    const raw={metadataId:21,sheetId:1,metadataKey:'malipang_expense_raw',metadataValue:'exp_flow',values:['exp_flow',null,null,null,null,null,'general','CONFIRMED']};
    const writes=planDailyCategoryProjection({expenseId:'exp_flow',expenseVersion:2,jobVersion:2,status:'CONFIRMED',fromCategory:'general',toCategory:'transport',currentCategory:'transport',rawSheetId:1,detailSheetId:2,raw,details:[],expectedItemIds:[]});
    assert.deepEqual(buildMetadataColumnWriteRequest(writes).data[0].values,[[null,null,null,null,null,null,'transport']]);
    h.sqlite.prepare("UPDATE sync_jobs SET status='PROCESSING',lease_token='fixture_lease',lease_until='9999-01-01T00:00:00Z' WHERE entity_type='EXPENSE_CATEGORY'").run();
    let dispatched=0;
    const ports={sheetId:async(_env,name)=>name==='raw'?1:2,search:async(_env,key)=>key==='malipang_expense_raw'?[{metadataId:21,metadataKey:key,metadataValue:'exp_flow',sheetId:1,rowIndex:5}]:[],read:async()=>new Map([[21,raw.values]]),write:async(_env,planned,fence)=>{await fence();dispatched++;assert.deepEqual(planned,writes)}};
    await runDailyCategoryProjection(h.env,{expenseId:'exp_flow',version:2,leaseToken:'fixture_lease'},ports);assert.equal(dispatched,1);
    await assert.rejects(runDailyCategoryProjection(h.env,{expenseId:'exp_flow',version:2,leaseToken:'wrong'},ports),/FENCE_LOST/);assert.equal(dispatched,1);
    const after=h.sqlite.prepare("SELECT description,amount_satang,transaction_date,payment_key,category,version FROM expense_events WHERE expense_id='exp_flow'").get();
    assert.deepEqual({...after},{description:'Driver',amount_satang:200000,transaction_date:'2026-10-28',payment_key:'transfer',category:'transport',version:2});
  }finally{h.close()}
});
