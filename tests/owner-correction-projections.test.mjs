import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPurchaseDetailEntries} from '../dist/sheets/purchase-details.js';
import {planOwnerCorrectionProjections} from '../dist/sheets/owner-correction-projections.js';

function fixture(){
  const before={expenseId:'exp_projection',status:'CONFIRMED',version:1,updatedAt:null,description:'Rice',category:'ingredients',amountSatang:10000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'};
  const document={documentId:'doc_projection',documentType:'RECEIPT',vendorName:'Shop',legalVendorName:'',documentNumber:'X1',orderId:'',documentDate:'2026-10-28'};
  const items=[{itemId:'item_projection',documentId:'doc_projection',expenseId:'exp_projection',sellerKey:'',productCode:'',description:'Rice',quantity:1,unit:'box',unitPriceSatang:10000,discountSatang:0,lineTotalSatang:10000}];
  const record={...before,amountBaht:100,branchId:'',createdAt:'',updatedAt:''};const values=buildPurchaseDetailEntries(record,document,items)[0].values;
  return {before,after:{...before},rawSheetId:1,detailSheetId:2,raw:{metadataId:10,metadataKey:'malipang_expense_raw',metadataValue:before.expenseId,sheetId:1,values:[before.expenseId,before.transactionDate,before.description,100,before.paymentKey,before.sourceWallet,before.category,'CONFIRMED']},details:[{metadataId:11,metadataKey:'malipang_expense_item',metadataValue:items[0].itemId,sheetId:2,values}],document,items,requireOriginal:true};
}
test('a corrected amount changes only raw amount and aggregate detail totals, not receipt item evidence',()=>{
  const x=fixture();x.after.amountSatang=11000;const patches=planOwnerCorrectionProjections(x);
  assert.deepEqual(patches,[{metadataId:10,cells:[{columnIndex:3,value:110}]},{metadataId:11,cells:[{columnIndex:12,value:10},{columnIndex:13,value:110}]}]);
  assert.equal(x.details[0].values[11],100);assert.equal(x.details[0].values[6],'Rice');
});
test('stale identities or changed receipt evidence block every projection',()=>{
  for(const change of [x=>x.raw.values[0]='other',x=>x.raw.values[3]=12,x=>x.details[0].values[1]='other',x=>x.details[0].values[11]=99,x=>x.details[0].metadataId=10,x=>x.details=[]]){
    const x=fixture();x.after.category='transport';change(x);assert.throws(()=>planOwnerCorrectionProjections(x));
  }
});
test('retry permits already-applied target values but preflight before approval requires originals',()=>{
  const x=fixture();x.after.category='transport';x.raw.values[6]='transport';x.details[0].values[14]='transport';
  assert.throws(()=>planOwnerCorrectionProjections(x),/VALUE_CHANGED/);x.requireOriginal=false;assert.deepEqual(planOwnerCorrectionProjections(x),[]);
});
