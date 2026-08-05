import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPurchaseDetailEntries,purchaseDetailRowKey} from '../dist/sheets/purchase-details.js';

function record(overrides={}){return{expenseId:'exp_3475',transactionDate:'2026-08-03',description:'Purchase',amountBaht:3475,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',branchId:'B001',status:'CONFIRMED',createdAt:'2026-08-03T01:00:00.000Z',updatedAt:'2026-08-03T01:01:00.000Z',...overrides};}
function document(overrides={}){return{documentId:'doc_3475',documentType:'TAX_INVOICE',vendorName:'Unseen Supplier Co., Ltd.',legalVendorName:'',documentNumber:'INV-3475',orderId:'',documentDate:'2026-08-03',...overrides};}
function item(id,overrides={}){return{itemId:id,documentId:'doc_3475',expenseId:'exp_3475',sellerKey:'',productCode:'',description:'Wrapped unseen-vendor product',quantity:5,unit:'bag',unitPriceSatang:69500,discountSatang:0,lineTotalSatang:347500,...overrides};}

test('stable detail identity is Expense_ID plus Item_ID',()=>{
  assert.equal(purchaseDetailRowKey('exp_1','item_2'),'exp_1|item_2');
});

test('an unseen vendor receipt writes one normalized purchase-detail row without changing daily summary policy',()=>{
  const rows=buildPurchaseDetailEntries(record(),document(),[item('item_1')]);
  assert.equal(rows.length,1);
  assert.equal(rows[0].rowKey,'exp_3475|item_1');
  assert.deepEqual(rows[0].values.slice(0,7),['item_1','exp_3475','doc_3475','2026-08-03','Unseen Supplier Co., Ltd.','INV-3475','Wrapped unseen-vendor product']);
  assert.equal(rows[0].values[11],3475);
  assert.equal(rows[0].values[13],3475);
  assert.equal(rows[0].values[17],'D1:doc_3475');
});

test('one row is generated per visible purchase item and a document-level adjustment is recorded once, not allocated',()=>{
  const rows=buildPurchaseDetailEntries(record({expenseId:'exp_discount',amountBaht:160}),document({documentId:'doc_discount'}),[
    item('item_a',{documentId:'doc_discount',expenseId:'exp_discount',lineTotalSatang:9000}),
    item('item_b',{documentId:'doc_discount',expenseId:'exp_discount',lineTotalSatang:9000})
  ]);
  assert.equal(rows.length,2);
  assert.equal(rows[0].values[12],-20);
  assert.equal(rows[1].values[12],'');
  assert.equal(rows[0].values[13],160);
  assert.equal(rows[1].values[13],160);
});

test('supporting delivery orders and mismatched items never create duplicate detail rows',()=>{
  assert.deepEqual(buildPurchaseDetailEntries(record(),null,[item('item_1')]),[]);
  assert.deepEqual(buildPurchaseDetailEntries(record(),document(),[item('item_1',{expenseId:'different'})]),[]);
});
