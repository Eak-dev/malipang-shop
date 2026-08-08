import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExpenseSummaryFlex,buildExpensePaymentFlex,buildExpenseSourceFlex,buildExpenseCategoryFlex,
  buildExpenseDateFlex,buildExpenseItemFlex,buildExpenseSavedFlex,buildExpensePaymentConfirmationFlex,collectFlexActionLabels,paymentWallet,paymentForWallet
} from '../dist/expense/flex.js';
import {expensePaymentOptions} from '../dist/expense/document.js';

const expense={expenseId:'exp_test_001',description:'Electricity',amountSatang:120050,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'utilities',transactionDate:'2026-07-22',status:'WAITING_CONFIRM'};
const builders=[buildExpenseSummaryFlex,buildExpensePaymentFlex,buildExpenseSourceFlex,buildExpenseCategoryFlex,buildExpenseDateFlex,buildExpenseItemFlex,buildExpenseSavedFlex,buildExpensePaymentConfirmationFlex];

test('expense Flex cards satisfy the LINE action-label contract',()=>{
  for(const build of builders){
    const message=build(expense);
    assert.equal(message.type,'flex');
    assert.ok(message.altText.length>0&&message.altText.length<=400);
    assert.equal(message.contents.type,'bubble');
    const labels=collectFlexActionLabels(message);
    assert.ok(labels.length>0,build.name);
    for(const label of labels)assert.ok(label.length<=20,`${build.name}: ${label} (${label.length})`);
  }
});

test('summary Flex renders only actions for the actual unresolved fields',()=>{
  const text=JSON.stringify(buildExpenseSummaryFlex({...expense,unresolvedRequiredFields:['description','category']}));
  for(const action of ['expense_item_menu','expense_category_menu','expense_cancel'])assert.match(text,new RegExp(action));
  for(const absent of ['expense_confirm','expense_payment_menu','expense_source_menu','expense_date_menu'])assert.doesNotMatch(text,new RegExp(absent));
  assert.match(text,/ยังต้องตรวจสอบ/);assert.match(text,/รายการ/);assert.match(text,/หมวดหมู่/);assert.doesNotMatch(text,/Document facts/);
});

test('saved Flex offers audit-safe undo',()=>{
  assert.match(JSON.stringify(buildExpenseSavedFlex({...expense,status:'CONFIRMED'})),/expense_undo/);
});

test('guided review Flex is Thai-first while preserving usable action labels',()=>{
  for(const build of [buildExpenseSummaryFlex,buildExpenseItemFlex,buildExpensePaymentConfirmationFlex]){
    const text=JSON.stringify(build(expense));
    assert.match(text,/[ก-๙]/,build.name);
  }
});

test('item confirmation offers accept or text correction without a new web UI',()=>{
  const text=JSON.stringify(buildExpenseItemFlex(expense));
  for(const action of ['expense_accept_description','expense_edit_description','expense_back'])assert.match(text,new RegExp(action));
});

test('payment-only chooser gives context and resolves canonical payment/source pairs in one tap',()=>{
  const unknown={...expense,paymentKey:'unconfirmed',sourceWallet:'UNCONFIRMED'};
  const text=JSON.stringify(buildExpensePaymentConfirmationFlex(unknown));
  assert.match(text,/เลือกวิธีชำระเงิน/);
  for(const value of ['Electricity','1,200.50 THB','22\/07\/2026','expense_cancel'])assert.match(text,new RegExp(value));
  assert.doesNotMatch(text,/expense_confirm/);
  for(const option of expensePaymentOptions){
    assert.match(text,new RegExp(`expense_resolve_payment[^\\"]*payment=${option.paymentKey}&source=${option.sourceWallet}`));
  }
});

test('an unresolved payment never renders Save as a primary action',()=>{
  const text=JSON.stringify(buildExpenseSummaryFlex({...expense,paymentKey:'unconfirmed',sourceWallet:'UNCONFIRMED',unresolvedRequiredFields:['payment']}));
  assert.doesNotMatch(text,/expense_confirm/);
  assert.match(text,/expense_payment_menu/);
});

test('card wallet keys match the Apps Script wallet master',()=>{
  assert.equal(paymentWallet('firstchoice'),'CARD_FIRST_CHOICE');
  assert.equal(paymentWallet('t1'),'CARD_THE1');
  assert.equal(paymentForWallet('CARD_FIRST_CHOICE'),'firstchoice');
  assert.equal(paymentForWallet('CARD_THE1'),'t1');
});
