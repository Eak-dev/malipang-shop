import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOwnerCorrectionDraft,parseOwnerCorrectionAmount,parseOwnerCorrectionDate} from '../dist/expense/owner-correction.js';

const snapshot=()=>({expenseId:'exp_fixture',status:'CONFIRMED',version:1,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'});
test('owner correction accepts exact positive amounts with satang and rejects ambiguous inputs',()=>{
  assert.equal(parseOwnerCorrectionAmount('1,234.50'),123450);assert.equal(parseOwnerCorrectionAmount('0.01'),1);
  for(const value of ['0','-1','1.001','1,23','1e3','NaN','999999999999999999999'])assert.equal(parseOwnerCorrectionAmount(value),null);
});
test('owner correction requires an explicit valid date and handles a Thai Buddhist year',()=>{
  assert.equal(parseOwnerCorrectionDate('31/08/2569'),'2026-08-31');assert.equal(parseOwnerCorrectionDate('2026-10-28'),'2026-10-28');
  for(const value of ['31/02/2569','28/10/69','2026-02-30','28/10',''])assert.equal(parseOwnerCorrectionDate(value),null);
});
test('preview changes only the requested field and requires valid payment pairs',()=>{
  const before=snapshot(),preview=buildOwnerCorrectionDraft(before,'category','transport');assert.equal(preview.after.category,'transport');assert.equal(before.category,'general');
  assert.deepEqual(preview.before,before);assert.equal(preview.after.amountSatang,before.amountSatang);
  assert.equal(buildOwnerCorrectionDraft(before,'category','transportation'),null);
  assert.equal(buildOwnerCorrectionDraft(before,'category','general'),null);
  assert.equal(buildOwnerCorrectionDraft(before,'payment',{paymentKey:'kbank',sourceWallet:'SHOP_BANK'}),null);
  assert.equal(buildOwnerCorrectionDraft(before,'payment',{paymentKey:'kbank',sourceWallet:'CARD_KBANK'}).after.paymentKey,'kbank');
  assert.equal(buildOwnerCorrectionDraft({...before,status:'CANCELLED'},'category','transport'),null);
});
