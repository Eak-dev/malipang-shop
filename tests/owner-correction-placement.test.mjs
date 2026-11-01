import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyOwnerCorrectionPlacement} from '../dist/sheets/owner-correction-placement.js';

function fixture(){
  const before={expenseId:'exp_place',status:'CONFIRMED',version:1,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'},after={...before,category:'transport'};
  const headers=[[],Array(8).fill(null),[]];headers[1][7]='เงินโอน';const values=Array(23).fill(null);Object.assign(values,{1:10,2:28,3:'Driver',7:2000,21:'transport',22:'บัญชีร้าน'});
  return {before,after,headers,candidates:[{expenseId:'exp_place',description:'Driver',amountSatang:200000,postingYear:2026,postingMonth:10,postingDay:28,amountColumn:7}],rows:[{rowNumber:100,sheetYear:2026,values}],dailySheetId:1,sourceMetadataId:11,expectedMetadataId:12,metadata:[{metadataId:12,metadataKey:'malipang_expense_daily',metadataValue:'exp_place',sheetId:1,rowIndex:99}]};
}
test('placement requires one matching row and the promoted metadata identity',()=>{
  const x=fixture();assert.equal(verifyOwnerCorrectionPlacement(x),true);
  x.metadata[0].rowIndex=100;assert.equal(verifyOwnerCorrectionPlacement(x),false);
});
test('a duplicated row, duplicate expense or duplicate metadata cannot be declared reconciled',()=>{
  for(const mutate of [x=>x.rows.push({...x.rows[0],rowNumber:101}),x=>x.candidates.push({...x.candidates[0],expenseId:'exp_other'}),x=>x.metadata.push({...x.metadata[0],metadataId:13}),x=>{x.rows[0].values[21]='general'}]){
    const x=fixture();mutate(x);assert.equal(verifyOwnerCorrectionPlacement(x),false);
  }
});
test('after a changed amount an old matching row must not remain',()=>{
  const x=fixture();x.after.amountSatang=210000;x.candidates[0].amountSatang=210000;x.rows[0].values[7]=2100;
  assert.equal(verifyOwnerCorrectionPlacement(x),true);
  const old=[...x.rows[0].values];old[7]=2000;old[21]='general';x.rows.push({rowNumber:101,sheetYear:2026,values:old});assert.equal(verifyOwnerCorrectionPlacement(x),false);
});
