import test from 'node:test';
import assert from 'node:assert/strict';
import {expensePaymentOptions,paymentOptionForPair,paymentOptionForPayment,paymentOptionForWallet,purchaseExpenseDraft} from '../dist/expense/document.js';
import {buildExpensePaymentFlex,buildExpensePaymentConfirmationFlex,buildExpenseSourceFlex,buildExpenseSavedFlex,collectFlexActionLabels,paymentForWallet,paymentWallet} from '../dist/expense/flex.js';
import {buildDailyExpenseEntries,buildDailySheetWritePlan,legacySourceWallet,resolvePayment,writeConfirmedExpenseWithDocumentItemsToDaily} from '../dist/sheets/daily-expense.js';
import {buildExpenseRawSheetValues} from '../dist/sheets/sync.js';

const expense={expenseId:'exp_wallet_fixture',description:'Supply purchase',amountSatang:12300,paymentKey:'cash',sourceWallet:'SHOP_BANK',category:'ingredients',transactionDate:'2026-10-13',status:'WAITING_CONFIRM'};
const actions=message=>message.contents.footer.contents.filter(x=>x.action?.type==='postback');
const params=button=>new URLSearchParams(button.action.data);
const cashOptions=message=>actions(message).filter(button=>params(button).get('payment')==='cash');

test('cash paid from shop bank is a valid distinct pair without changing legacy defaults',()=>{
  assert.ok(paymentOptionForPair('cash','SHOP_BANK'));
  assert.ok(paymentOptionForPair('cash','CASH_DRAWER'));
  assert.ok(paymentOptionForPair('transfer','SHOP_BANK'));
  assert.equal(paymentOptionForPair('transfer','CASH_DRAWER'),undefined);
  assert.equal(paymentOptionForPair('cash','CARD_KBANK'),undefined);
  assert.equal(paymentOptionForPayment('cash').sourceWallet,'CASH_DRAWER');
  assert.equal(paymentOptionForWallet('SHOP_BANK').paymentKey,'transfer');
  assert.equal(paymentWallet('cash'),'CASH_DRAWER');
});

test('choosing shop bank preserves explicit cash rather than inventing a bank transfer',()=>{
  assert.equal(paymentForWallet('SHOP_BANK','cash'),'cash');
  assert.equal(paymentForWallet('SHOP_BANK','transfer'),'transfer');
  assert.equal(paymentForWallet('SHOP_BANK'),'transfer','omitted current method retains the legacy default');
  assert.equal(paymentForWallet('SHOP_BANK','unconfirmed'),'transfer');
  assert.equal(paymentForWallet('CASH_DRAWER','cash'),'cash');
  assert.equal(paymentForWallet('CASH_DRAWER','transfer'),'cash');
  for(const option of expensePaymentOptions.filter(x=>x.sourceWallet.startsWith('CARD_'))){
    assert.equal(paymentForWallet(option.sourceWallet,'cash'),option.paymentKey);
    assert.equal(paymentWallet(option.paymentKey),option.sourceWallet);
  }
});

test('receipt draft respects explicit bank-funded cash while missing method keeps the transfer default',()=>{
  const document={documentType:'RECEIPT',finalPaidAmountBaht:123,paymentDate:'2026-10-13',documentDate:'2026-10-13',sourceWalletCandidate:'SHOP_BANK',suggestedCategory:'ingredients',vendor:'Fixture supplier',legalVendorName:'Fixture supplier',suggestedDescription:'Supply purchase',needsReview:false,reviewReasons:[],confidence:1};
  for(const paymentMethod of ['Cash',' CASH ','เงินสด']){
    const draft=purchaseExpenseDraft({...document,paymentMethod});
    assert.equal(draft.paymentKey,'cash');assert.equal(draft.sourceWallet,'SHOP_BANK');
  }
  const normalized=purchaseExpenseDraft({...document,paymentMethod:' cash ',sourceWalletCandidate:' shop_bank '});
  assert.equal(normalized.paymentKey,'cash');assert.equal(normalized.sourceWallet,'SHOP_BANK');
  for(const paymentMethod of ['','Transfer','QR'])assert.equal(purchaseExpenseDraft({...document,paymentMethod}).paymentKey,'transfer');
  assert.equal(purchaseExpenseDraft({...document,paymentMethod:'Cash',sourceWalletCandidate:'CASH_DRAWER'}).sourceWallet,'CASH_DRAWER');
});

test('both payment menus encode distinct cash sources and highlight only the exact pair',()=>{
  for(const build of [buildExpensePaymentFlex,buildExpensePaymentConfirmationFlex]){
    const message=build(expense),cash=cashOptions(message);
    assert.equal(cash.length,2);
    assert.deepEqual(cash.map(x=>params(x).get('source')).sort(),['CASH_DRAWER','SHOP_BANK']);
    assert.equal(new Set(cash.map(x=>x.action.data)).size,2);
    assert.equal(new Set(cash.map(x=>x.action.label)).size,2,'source choices must be distinguishable');
    for(const label of collectFlexActionLabels(message))assert.ok(label.length<=20,label);
  }
  const selected=actions(buildExpensePaymentFlex(expense)).filter(x=>x.style==='primary');
  assert.equal(selected.length,1);
  assert.equal(params(selected[0]).get('source'),'SHOP_BANK');
  assert.equal(params(selected[0]).get('payment'),'cash');
});

test('source chooser lists each wallet only once and saved card keeps cash separate from bank source',()=>{
  const message=buildExpenseSourceFlex(expense),sources=actions(message).map(params).map(x=>x.get('source')).filter(Boolean);
  assert.equal(sources.length,new Set(sources).size);
  assert.equal(sources.filter(x=>x==='SHOP_BANK').length,1);
  const saved=JSON.stringify(buildExpenseSavedFlex({...expense,status:'CONFIRMED'}));
  assert.match(saved,/Cash/);assert.match(saved,/Shop bank account/);assert.doesNotMatch(saved,/Bank transfer/);
});

test('daily source label respects explicit shop bank while preserving old cash and credit mappings',()=>{
  assert.equal(legacySourceWallet('cash','SHOP_BANK'),'บัญชีร้าน');
  assert.equal(legacySourceWallet('cash',' shop_bank '),'บัญชีร้าน');
  assert.equal(legacySourceWallet('cash','CASH_DRAWER'),'ทอน/หน้าร้าน');
  assert.equal(legacySourceWallet('cash',''),'ทอน/หน้าร้าน','legacy missing-source fallback');
  assert.equal(legacySourceWallet('transfer','SHOP_BANK'),'บัญชีร้าน');
  for(const option of expensePaymentOptions.filter(x=>x.sourceWallet.startsWith('CARD_'))){
    assert.equal(legacySourceWallet(option.paymentKey,option.sourceWallet),'บัญชีร้าน');
  }
});

test('cash from shop bank stays in cash amount column and RAW retains both truthful fields',()=>{
  const record={...expense,amountBaht:123},entries=buildDailyExpenseEntries(record,null,[]).entries;
  const payment=resolvePayment([],'cash',2026,10,13),source=legacySourceWallet(record.paymentKey,record.sourceWallet);
  assert.equal(payment.amountColumn,'G');
  const plan=buildDailySheetWritePlan("Owner's daily",record,payment,source,entries,new Map([[expense.expenseId,10]]));
  assert.deepEqual(plan.writes.map(x=>x.range),["'Owner''s daily'!B10:D10","'Owner''s daily'!G10","'Owner''s daily'!V10:W10"]);
  assert.deepEqual(plan.writes[2].values,[['ingredients','บัญชีร้าน']]);
  assert.deepEqual(plan.clearRanges,["'Owner''s daily'!B10:D10","'Owner''s daily'!F10:H10","'Owner''s daily'!K10:Q10","'Owner''s daily'!V10:W10"]);
  assert.deepEqual(buildDailySheetWritePlan("Owner's daily",record,payment,source,entries,new Map([[expense.expenseId,10]])),plan,'retry keeps the same row and amount');
  const raw=buildExpenseRawSheetValues({expense_id:expense.expenseId,transaction_date:expense.transactionDate,description:expense.description,amount_satang:expense.amountSatang,payment_key:'cash',source_wallet:'SHOP_BANK',category:'ingredients',status:'CONFIRMED'},null);
  assert.equal(raw[3],123);assert.equal(raw[4],'cash');assert.equal(raw[5],'SHOP_BANK');
});

test('cash-source support does not opt historical item rows into a summary rewrite',async()=>{
  const env={SHEET_EXPENSE_DAILY:'รายวัน',DB:{prepare(sql){assert.match(sql,/SELECT entity_key,row_number FROM sheet_row_index/);return{bind(){return this;},async all(){return{results:[{entity_key:expense.expenseId+'|item_fixture',row_number:10}]};}};}}};
  const result=await writeConfirmedExpenseWithDocumentItemsToDaily(env,{...expense,amountBaht:123},null,[]);
  assert.deepEqual(result.placements,[]);assert.equal(result.replacedLegacySummary,false);
});
