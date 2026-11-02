import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {grantSyntheticOpenPeriods,grantSyntheticReportView,syntheticCorrectionReport} from './helpers/owner-correction-periods.mjs';
import {buildOwnerCorrectionDraft} from '../dist/expense/owner-correction.js';
import {createOwnerCorrectionDraft,loadOwnerExpense,commitOwnerCorrection,ownerCorrectionStatus} from '../dist/expense/owner-correction-repository.js';
import {inspectOwnerCorrectionPeriods} from '../dist/expense/owner-correction-periods.js';
import {confirmOwnerCorrection} from '../dist/expense/owner-correction-confirmed.js';
import {prepareSameMonthCorrectionPlan} from '../dist/sheets/owner-correction-plan-service.js';
import {ensureOwnerCorrectionCellGuards} from '../dist/sheets/owner-correction-cell-guard-service.js';
import {inspectOwnerCorrectionTargets} from '../dist/sheets/owner-correction-inspection.js';
import {reconcileOwnerCorrection} from '../dist/sheets/owner-correction-reconciliation.js';
import {processOwnerCorrectionJob} from '../dist/sheets/owner-correction-worker.js';
import {buildPurchaseDetailEntries} from '../dist/sheets/purchase-details.js';

const owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};
async function setup(field,value,multi=false){
  const h=ownerOrderFixture();Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily',SHEET_EXPENSE_RAW:'raw',SHEET_PURCHASE_DETAILS:'detail',GOOGLE_SERVICE_ACCOUNT_EMAIL:'synthetic@example.invalid'});
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_fields','msg_fields','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const before=await loadOwnerExpense(h.env,owner,'exp_fields'),after=buildOwnerCorrectionDraft(before,field,value).after,id=await createOwnerCorrectionDraft(h.env,owner,before,field,value);
  const body=Array.from({length:12},()=>[]);body[1]=Array(8).fill(null);body[1][7]='เงินโอน';body[4]=[2026];body[5]=[null,10,null,'รายรับทั้งหมดในบัญชี'];body[10]=['รวม',10];
  const daily=Array(23).fill(null);Object.assign(daily,{1:10,2:28,3:'Driver',7:2000,21:'general',22:'บัญชีร้าน'});body[7]=daily;
  const raw=['exp_fields','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED'],rows=new Map([[1,daily],[2,raw]]),headers=body.slice(0,3);await grantSyntheticOpenPeriods(h,id,headers);const view=grantSyntheticReportView(h,id,before);
  const metadata=[{metadataId:1,metadataKey:'malipang_expense_daily',metadataValue:'exp_fields',sheetId:1,rowIndex:7},{metadataId:2,metadataKey:'malipang_expense_raw',metadataValue:'exp_fields',sheetId:2,rowIndex:1}],ranges=[],queue=[];let nextGuard=100;
  const document=multi?{documentId:'doc_fields',documentType:'INVOICE',vendorName:'Synthetic vendor',legalVendorName:'',documentNumber:'QA-1',orderId:'',documentDate:''}:null;
  const items=multi?[{itemId:'item_fields_1',documentId:'doc_fields',expenseId:'exp_fields',sellerKey:'',productCode:'',description:'Item one',quantity:1,unit:'',unitPriceSatang:80000,discountSatang:0,lineTotalSatang:80000},{itemId:'item_fields_2',documentId:'doc_fields',expenseId:'exp_fields',sellerKey:'',productCode:'',description:'Item two',quantity:1,unit:'',unitPriceSatang:120000,discountSatang:0,lineTotalSatang:120000}]:[];
  if(multi){const record={expenseId:'exp_fields',transactionDate:before.transactionDate,description:before.description,amountBaht:2000,paymentKey:before.paymentKey,sourceWallet:before.sourceWallet,category:before.category,branchId:'',status:'CONFIRMED',createdAt:'',updatedAt:''};
    for(const [index,item] of buildPurchaseDetailEntries(record,document,items).entries()){const metadataId=index+3;rows.set(metadataId,item.values);metadata.push({metadataId,metadataKey:'malipang_expense_item',metadataValue:item.itemId,sheetId:3,rowIndex:index+1})}}
  const links=metadata.map(m=>({metadataId:m.metadataId,target:{sheetId:m.sheetId,rowIndex:m.rowIndex,key:m.metadataKey,value:m.metadataValue}}));
  const readRows=ids=>new Map(ids.map(id=>[id,[...rows.get(id)]]));
  const sheetPorts={existing:async()=>links,values:async()=>body,sheetId:async()=>3,rows:async(_env,ids)=>readRows(ids),expense:async()=>({expense:h.sqlite.prepare("SELECT * FROM expense_events WHERE expense_id='exp_fields'").get(),document,items}),inspect:async(_env,plan)=>({identitiesVerified:true,rows:readRows(plan.patches.map(patch=>patch.metadataId))})};
  const guardPorts={now:()=>Date.now(),metadata:async()=>metadata[0],sheetId:async()=>1,ranges:async()=>({sheetId:1,ranges:structuredClone(ranges)}),batch:async(_env,requests,arm)=>{await arm();for(const request of requests)ranges.push({...request.addProtectedRange.protectedRange,protectedRangeId:nextGuard++,requestingUserCanEdit:true})}};
  const confirmation={periods:(env,actor,key)=>inspectOwnerCorrectionPeriods(env,actor,key,Date.now(),{headers:async()=>headers}),headers:async()=>headers,protection:async()=>true,dedupe:async()=>true,posting:async()=>({items}),bootstrap:async()=>'READY',
    guards:(env,actor,key,snapshot,plan)=>ensureOwnerCorrectionCellGuards(env,actor,key,snapshot,plan,guardPorts),view:async()=>({kind:'READY',view}),plan:async(env,old,next,key)=>{const plan=await prepareSameMonthCorrectionPlan(env,old,next,key,sheetPorts);return plan?{...plan,reportBaseline:syntheticCorrectionReport(before)}:null},commit:commitOwnerCorrection,enqueue:async(_env,job)=>{queue.push(job)},status:ownerCorrectionStatus};
  const inspectionPorts={sheetId:async(_env,name)=>({daily:1,raw:2,detail:3})[name],metadata:async(_env,key)=>metadata.filter(item=>item.metadataKey===key),rows:async(_env,ids)=>readRows(ids),headers:async()=>headers,protection:async()=>true,cellRanges:guardPorts.ranges};
  const recPorts={saved:async()=>({before,after}),posting:sheetPorts.expense,projection:async()=>true,placement:async()=>true,report:async()=>syntheticCorrectionReport(after),protection:async()=>true,view:async()=>'VERIFIED'};
  const worker={now:()=>Date.now(),inspect:plan=>inspectOwnerCorrectionTargets(h.env,plan,inspectionPorts),patch:async(plan,arm)=>{await arm();for(const patch of plan.patches)for(const cell of patch.cells)rows.get(patch.metadataId)[cell.columnIndex]=cell.value},inspectRebind:async()=>{throw Error('unexpected move')},rebind:async()=>{throw Error('unexpected move')},reconcile:(plan,job)=>reconcileOwnerCorrection(h.env,plan,job,recPorts)};
  return {...h,before,after,id,rows,ranges,queue,confirmation,worker};
}
for(const [field,value] of [['description','Taxi'],['category','transport'],['amountSatang','2050.50'],['transactionDate','2026-10-29'],['payment',{paymentKey:'cash',sourceWallet:'CASH_DRAWER'}]])test(`confirmed ${field} flows through owner approval, guards and reconciliation`,async()=>{
  const h=await setup(field,value);try{
    assert.equal(await confirmOwnerCorrection(h.env,owner,h.id,1,'synthetic_trace',h.confirmation),'APPLIED');assert.equal(h.queue.length,1);
    assert.equal(await processOwnerCorrectionJob(h.env,{expenseId:'exp_fields',version:2},h.worker),'COMPLETED');assert.equal(await ownerCorrectionStatus(h.env,owner,h.id),'COMPLETED');
    const row=h.sqlite.prepare("SELECT * FROM expense_events WHERE expense_id='exp_fields'").get();assert.equal(row.description,h.after.description);assert.equal(row.category,h.after.category);assert.equal(row.amount_satang,h.after.amountSatang);assert.equal(row.transaction_date,h.after.transactionDate);assert.equal(row.payment_key,h.after.paymentKey);assert.equal(row.source_wallet,h.after.sourceWallet);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='EDIT'").get().n,1);assert.equal(await confirmOwnerCorrection(h.env,owner,h.id,1,'synthetic_trace',h.confirmation),'APPLIED');assert.equal(h.queue.length,1);
    if(field==='category')assert.equal(h.ranges.length,0);else assert.ok(h.ranges.length>0);
  }finally{h.close()}
});
for(const [field,value] of [['description','Taxi'],['transactionDate','2026-10-29'],['payment',{paymentKey:'cash',sourceWallet:'CASH_DRAWER'}]])test(`multiple receipt lines preserve evidence through a ${field} correction`,async()=>{
  const h=await setup(field,value,true);try{
    const evidence=[3,4].map(id=>[0,1,2,4,5,6,7,8,9,10,11,16].map(col=>h.rows.get(id)[col]));
    assert.equal(await confirmOwnerCorrection(h.env,owner,h.id,1,'synthetic_trace',h.confirmation),'APPLIED');
    assert.equal(await processOwnerCorrectionJob(h.env,{expenseId:'exp_fields',version:2},h.worker),'COMPLETED');assert.equal(await ownerCorrectionStatus(h.env,owner,h.id),'COMPLETED');
    assert.deepEqual([3,4].map(id=>[0,1,2,4,5,6,7,8,9,10,11,16].map(col=>h.rows.get(id)[col])),evidence);
    if(field==='transactionDate')assert.deepEqual([h.rows.get(3)[3],h.rows.get(4)[3]],[h.after.transactionDate,h.after.transactionDate]);
  }finally{h.close()}
});
test('removing a daily-cell guard before dispatch sends the correction to review',async()=>{
  const h=await setup('description','Taxi');try{
    assert.equal(await confirmOwnerCorrection(h.env,owner,h.id,1,'synthetic_trace',h.confirmation),'APPLIED');h.ranges.length=0;
    assert.equal(await processOwnerCorrectionJob(h.env,{expenseId:'exp_fields',version:2},h.worker),'REVIEW');assert.equal(h.rows.get(1)[3],'Driver');assert.equal(h.rows.get(2)[2],'Driver');
  }finally{h.close()}
});
