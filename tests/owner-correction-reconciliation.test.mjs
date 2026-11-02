import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileOwnerCorrection} from '../dist/sheets/owner-correction-reconciliation.js';
import {syntheticCorrectionReport} from './helpers/owner-correction-periods.mjs';

function fixture(){
  const before={expenseId:'exp_reconcile',status:'CONFIRMED',version:1,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'},after={...before,category:'transport'};
  const row={expense_id:after.expenseId,status:'CONFIRMED',version:2,updated_at:'2026-10-28T10:00:00Z',description:after.description,category:after.category,amount_satang:after.amountSatang,transaction_date:after.transactionDate,payment_key:after.paymentKey,source_wallet:after.sourceWallet};
  const plan={expenseId:before.expenseId,dailyMetadataId:1,rawMetadataId:2,rebind:null,reportBaseline:syntheticCorrectionReport(before)},job={expenseId:before.expenseId,version:2};
  let projection=true,placement=true,report=syntheticCorrectionReport(after),loads=0;
  const ports={saved:async()=>({before,after}),posting:async()=>{loads++;return{expense:{...row}}},projection:async()=>projection,placement:async()=>placement,report:async()=>report,protection:async()=>true};
  return{plan,job,ports,row,setProjection:value=>{projection=value},setPlacement:value=>{placement=value},setReport:value=>{report=value},getLoads:()=>loads};
}
test('reconciliation checks D1, both sheet projections, report deltas and a final version read',async()=>{
  const f=fixture(),result=await reconcileOwnerCorrection({},f.plan,f.job,f.ports);
  assert.deepEqual(result,{expenseId:'exp_reconcile',version:2,dailyMatches:true,rawMatches:true,detailsMatch:true,reportsMatch:true,duplicateCount:0,lostCount:0});assert.equal(f.getLoads(),2);
});
test('any missing projection, changed version, duplicate evidence or report mismatch stays unresolved',async()=>{
  for(const mutate of [f=>f.setProjection(false),f=>f.setPlacement(false),f=>{f.ports.protection=async()=>false},f=>f.setReport(null),f=>f.setReport({...syntheticCorrectionReport({...f.plan.reportBaseline,category:'transport',transactionDate:'2026-10-28',sourceWallet:'SHOP_BANK'}),otherRowsDigest:'0'.repeat(64)}),f=>{f.row.version=3}]){
    const f=fixture();mutate(f);assert.equal(await reconcileOwnerCorrection({},f.plan,f.job,f.ports),null);
  }
});
test('a changed expense between the report read and final check cannot be finalized',async()=>{
  const f=fixture(),posting=f.ports.posting;let calls=0;f.ports.posting=async(...args)=>{const value=await posting(...args);if(++calls===2)value.expense.version=3;return value};
  assert.equal(await reconcileOwnerCorrection({},f.plan,f.job,f.ports),null);
});
