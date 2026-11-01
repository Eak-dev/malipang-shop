import test from 'node:test';
import assert from 'node:assert/strict';
import {planOwnerCorrectionCombined} from '../dist/sheets/owner-correction-combined-plan.js';

function fixture(){
  const before={expenseId:'exp_combined',status:'CONFIRMED',version:1,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'},after={...before,category:'transport'};
  const values=Array(23).fill(null);Object.assign(values,{1:10,2:28,3:'Driver',7:2000,21:'general',22:'บัญชีร้าน'});
  const headers=[[],Array(16).fill(null),Array(16).fill(null)];headers[1][7]='เงินโอน';
  return {sheet:{before,after,headers,blocks:[{month:10,headerRow:90,totalRow:150}],source:{rowNumber:100,sheetYear:2026,metadataExpenseId:'exp_combined',values},destination:null},projection:{before,after,rawSheetId:1,detailSheetId:2,raw:{metadataId:103,metadataKey:'malipang_expense_raw',metadataValue:'exp_combined',sheetId:1,values:['exp_combined','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED']},details:[],document:null,items:[],requireOriginal:true},sourceMetadataId:101,destinationMetadataId:101};
}
test('combined plan updates verified daily and raw category without overwriting formulas',()=>{
  const result=planOwnerCorrectionCombined(fixture());assert.equal(result.patches.length,2);
  assert.equal(result.request.data[0].values[0][21],'transport');assert.equal(result.request.data[0].values[0][8],null);
  assert.equal(result.request.data[1].values[0][6],'transport');assert.equal(result.request.data[1].values[0][7],undefined);
});
test('snapshot mismatches and duplicate metadata targets stop the whole plan',()=>{
  let input=fixture();input.projection.after={...input.projection.after,category:'rent'};assert.throws(()=>planOwnerCorrectionCombined(input),/SNAPSHOT_MISMATCH/);
  input=fixture();input.projection.raw.metadataId=101;assert.throws(()=>planOwnerCorrectionCombined(input),/INVALID_METADATA_ROW_PATCH/);
});
