import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerCorrectionRowPatches,planOwnerCorrectionSheet} from '../dist/sheets/owner-correction-plan.js';
import {buildMetadataRowPatchRequest} from '../dist/sheets/client.js';

function fixture(){
  const before={expenseId:'exp_fixture',status:'CONFIRMED',version:1,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'};
  const values=Array(23).fill(null);Object.assign(values,{1:10,2:28,3:'Driver',7:2000,21:'general',22:'บัญชีร้าน'});
  const headers=[[],Array(16).fill(null),Array(16).fill(null)];headers[1][7]='เงินโอน';headers[1][10]=20;headers[2][10]='Kbank';
  return {before,after:{...before},headers,source:{rowNumber:100,sheetYear:2026,metadataExpenseId:'exp_fixture',values},destination:null};
}
test('same-month correction retains the verified source and does not touch another row',()=>{
  const x=fixture();x.after.description='Driver fee';const p=planOwnerCorrectionSheet(x);assert.equal(p.move,false);assert.equal(p.destinationRow,100);assert.equal(p.amountColumn,'H');
});
test('changing to a credit card after cutoff needs an empty row in the next month',()=>{
  const x=fixture();x.after.paymentKey='kbank';x.after.sourceWallet='CARD_KBANK';
  assert.throws(()=>planOwnerCorrectionSheet(x),/DESTINATION_UNSAFE/);
  x.destination={rowNumber:201,postingYear:2026,postingMonth:11,values:Array(23).fill(null),hasMetadata:false};
  const p=planOwnerCorrectionSheet(x);assert.equal(p.move,true);assert.equal(p.destinationRow,201);assert.equal(p.amountColumn,'K');
  const patches=ownerCorrectionRowPatches(p,101,102),request=buildMetadataRowPatchRequest(patches,[1,2,3,5,6,7,10,11,12,13,14,15,16,21,22]);
  assert.equal(request.data[0].values[0][10],2000);assert.equal(request.data[0].values[0][8],null);assert.equal(request.data[0].values[0][20],null);
  assert.equal(request.data[1].values[0][7],'');assert.equal(request.data[1].values[0][8],null);
  assert.throws(()=>ownerCorrectionRowPatches(p,101,101));
  x.destination.values[7]=5;assert.throws(()=>planOwnerCorrectionSheet(x),/DESTINATION_UNSAFE/);
});
test('mismatched source identity, amount or unrelated payment cell stops the correction',()=>{
  for(const change of [x=>x.source.metadataExpenseId='different',x=>x.source.sheetYear=2025,x=>x.source.values[7]=500,x=>x.source.values[6]=1,x=>x.source.values[21]='rent']){
    const x=fixture();x.after.category='transport';change(x);assert.throws(()=>planOwnerCorrectionSheet(x));
  }
});
test('preflight rejects multiple simultaneous edits, invalid totals and changed snapshots',()=>{
  for(const change of [x=>{x.after.category='transport';x.after.amountSatang=1},x=>{x.after.amountSatang=-1},x=>{x.after.category='transport';x.after.version++},x=>{x.after.transactionDate='2026-02-31'}]){
    const x=fixture();change(x);assert.throws(()=>planOwnerCorrectionSheet(x));
  }
});
