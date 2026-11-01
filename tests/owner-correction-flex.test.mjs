import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOwnerCorrectionPreview,buildOwnerCorrectionResults} from '../dist/expense/owner-correction-flex.js';

test('preview shows old and new values and binds confirmation to correction and version',()=>{
  const before={expenseId:'exp_1',status:'CONFIRMED',version:3,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'};
  const flex=buildOwnerCorrectionPreview({before,after:{...before,category:'transport'},field:'category'},'correction_1');
  const content=JSON.stringify(flex);assert.match(content,/ทั่วไป/);assert.match(content,/ขนส่ง\/รถ/);assert.match(content,/id=correction_1&v=3/);
  assert.match(content,/ยืนยันการแก้ไข/);assert.match(content,/ยกเลิก/);
});
test('search result buttons reference the exact expense rather than selecting by amount',()=>{
  const result=buildOwnerCorrectionResults([{expense_id:'exp_a',description:'Driver',amount_satang:200000,transaction_date:'2026-10-28',category:'general'},{expense_id:'exp_b',description:'Driver',amount_satang:200000,transaction_date:'2026-10-28',category:'general'}],'Driver');
  const content=JSON.stringify(result);assert.match(content,/id=exp_a/);assert.match(content,/id=exp_b/);
});
