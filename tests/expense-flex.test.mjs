import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExpenseSummaryFlex,buildExpensePaymentFlex,buildExpenseSourceFlex,buildExpenseCategoryFlex,
  buildExpenseDateFlex,buildExpenseSavedFlex,collectFlexActionLabels,paymentWallet,paymentForWallet
} from '../dist/expense/flex.js';

const expense={expenseId:'exp_test_001',description:'ค่าไฟ',amountSatang:120050,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'utilities',transactionDate:'2026-07-22',status:'WAITING_CONFIRM'};
const builders=[buildExpenseSummaryFlex,buildExpensePaymentFlex,buildExpenseSourceFlex,buildExpenseCategoryFlex,buildExpenseDateFlex,buildExpenseSavedFlex];

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

test('card wallet keys match the Apps Script wallet master',()=>{
  assert.equal(paymentWallet('firstchoice'),'CARD_FIRST_CHOICE');
  assert.equal(paymentWallet('t1'),'CARD_THE1');
  assert.equal(paymentForWallet('CARD_FIRST_CHOICE'),'firstchoice');
  assert.equal(paymentForWallet('CARD_THE1'),'t1');
});
