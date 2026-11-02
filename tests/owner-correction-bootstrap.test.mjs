import test from 'node:test';
import assert from 'node:assert/strict';
import {planOwnerCorrectionBootstrap} from '../dist/sheets/owner-correction-bootstrap.js';
import {buildPurchaseDetailEntries} from '../dist/sheets/purchase-details.js';

function fixture(){
  const expense={expenseId:'exp_boot',status:'CONFIRMED',version:1,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'};
  const candidate={expenseId:'exp_boot',postingYear:2026,postingMonth:10,postingDay:28,description:'Driver',amountSatang:200000,amountColumn:7};
  const values=Array(23).fill(null);Object.assign(values,{1:10,2:28,3:'Driver',7:2000,21:'general',22:'บัญชีร้าน'});
  const headers=[[],Array(16).fill(null),Array(16).fill(null)];headers[1][7]='เงินโอน';
  return {expense,candidates:[candidate],headers,dailyRows:[{sheetId:1,rowNumber:100,sheetYear:2026,values}],rawRows:[{sheetId:2,rowNumber:5,values:['exp_boot','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED']}],detailRows:[],document:null,items:[],existing:[]};
}
test('only a unique verified expense can be assigned daily and raw metadata',()=>{
  const targets=planOwnerCorrectionBootstrap(fixture());assert.deepEqual(targets.map(x=>x.key),['malipang_expense_daily','malipang_expense_raw']);
});
test('a receipt detail must match its original item data before metadata can be attached',()=>{
  const x=fixture();x.document={documentId:'doc_boot',documentType:'RECEIPT',vendorName:'Shop',legalVendorName:'',documentNumber:'R1',orderId:'',documentDate:'2026-10-28'};
  x.items=[{itemId:'item_boot',documentId:'doc_boot',expenseId:'exp_boot',sellerKey:'',productCode:'',description:'Rice',quantity:1,unit:'box',unitPriceSatang:200000,discountSatang:0,lineTotalSatang:200000}];
  const record={...x.expense,amountBaht:2000,branchId:'',createdAt:'',updatedAt:''};const values=buildPurchaseDetailEntries(record,x.document,x.items)[0].values;
  x.detailRows=[{sheetId:3,rowNumber:7,values}];assert.equal(planOwnerCorrectionBootstrap(x).length,3);
  x.detailRows[0].values[11]=1999;assert.throws(()=>planOwnerCorrectionBootstrap(x),/DETAIL_CHANGED/);
});
test('duplicate candidates or rows, changed source values and metadata conflicts fail closed',()=>{
  for(const change of [x=>x.candidates.push({...x.candidates[0],expenseId:'exp_other'}),x=>x.dailyRows.push({...x.dailyRows[0],rowNumber:101}),x=>x.rawRows.push({...x.rawRows[0],rowNumber:6}),x=>{x.rawRows[0].values[5]='CASH_DRAWER'},x=>{x.candidates[0].postingMonth=9},x=>x.existing.push({sheetId:1,rowIndex:99,key:'malipang_expense_daily',value:'someone_else',metadataId:30})]){
    const x=fixture();change(x);assert.throws(()=>planOwnerCorrectionBootstrap(x));
  }
});
