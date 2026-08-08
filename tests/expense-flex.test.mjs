import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExpenseSummaryFlex,buildExpensePaymentFlex,buildExpenseSourceFlex,buildExpenseCategoryFlex,
  buildExpenseDateFlex,buildExpenseSavedFlex,buildExpensePaymentConfirmationFlex,collectFlexActionLabels,paymentWallet,paymentForWallet
} from '../dist/expense/flex.js';
import {expensePaymentOptions} from '../dist/expense/document.js';

const expense={expenseId:'exp_test_001',description:'Electricity',amountSatang:120050,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'utilities',transactionDate:'2026-07-22',status:'WAITING_CONFIRM'};
const builders=[buildExpenseSummaryFlex,buildExpensePaymentFlex,buildExpenseSourceFlex,buildExpenseCategoryFlex,buildExpenseDateFlex,buildExpenseSavedFlex,buildExpensePaymentConfirmationFlex];

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

test('summary Flex preserves the original editable flow',()=>{
  const text=JSON.stringify(buildExpenseSummaryFlex(expense));
  for(const action of ['expense_confirm','expense_payment_menu','expense_source_menu','expense_category_menu','expense_date_menu','expense_cancel'])assert.match(text,new RegExp(action));
});

test('saved Flex offers audit-safe undo',()=>{
  assert.match(JSON.stringify(buildExpenseSavedFlex({...expense,status:'CONFIRMED'})),/expense_undo/);
});

test('expense Flex system UI is English only',()=>{
  for(const build of builders.filter(build=>build!==buildExpensePaymentConfirmationFlex)){
    const text=JSON.stringify(build(expense));
    assert.doesNotMatch(text,/[ก-๙]/,build.name);
    assert.match(text,/[A-Za-z]/,build.name);
  }
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
