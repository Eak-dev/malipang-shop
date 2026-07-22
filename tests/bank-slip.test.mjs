import test from 'node:test';
import assert from 'node:assert/strict';
import {bankSlipExpenseDraft,bankSlipReferenceKey,validateBankSlip} from '../dist/expense/bank-slip.js';

function reading(overrides={}){
  const document={documentType:'BANK_SLIP',channel:'BANK',institution:'SCB',transactionType:'TRANSFER',transactionStatus:'SUCCESS',printedYear:'2026',paymentDate:'2026-07-21',paymentTime:'17:19',referenceId:'SCB-REF-1',sender:'Eak',senderAccountMasked:'xx771-5',recipient:'Recipient',recipientAccountMasked:'xx4859',merchant:'',grossAmountBaht:50,discountAmountBaht:0,paidAmountBaht:50,currency:'THB',suggestedDescription:'Transfer to Recipient',suggestedCategory:'general',confidence:0.98,needsReview:false,note:'',...overrides};
  return{kind:'BANK_SLIP',hour:null,minute:null,month:null,day:null,weekday:null,confidence:document.confidence,clockFullyVisible:null,needsNewPhoto:false,note:'',provider:'test',raw:null,document};
}

test('KBank slip creates a SHOP_BANK transfer draft using actual paid amount',()=>{
  const result=reading({institution:'KBank',paymentDate:'2026-07-21',paymentTime:'16:49',referenceId:'KBANK-REF-1',recipient:'',merchant:'Ontakan Printing',paidAmountBaht:200,grossAmountBaht:200,suggestedDescription:'Printing expense - Ontakan Printing',suggestedCategory:'marketing'});
  assert.equal(validateBankSlip(result).ok,true);
  assert.deepEqual(bankSlipExpenseDraft(result.document),{description:'Printing expense - Ontakan Printing',amountSatang:20000,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'marketing',transactionDate:'2026-07-21'});
  assert.equal(bankSlipReferenceKey(result.document),'KBANK|KBANKREF1');
});

test('amount mismatch or non-THB receipt remains review-only',()=>{
  const result=reading({grossAmountBaht:40,discountAmountBaht:24,paidAmountBaht:40,currency:'USD'});
  const validation=validateBankSlip(result);
  assert.equal(validation.ok,false);
  assert.ok(validation.missing.includes('THB currency'));
  assert.ok(validation.missing.includes('amount reconciliation'));
});

test('SCB person transfer is accepted but explicitly requires category confirmation',()=>{
  const result=reading();
  const validation=validateBankSlip(result);
  const draft=bankSlipExpenseDraft(result.document);
  assert.equal(validation.ok,true);
  assert.equal(validation.review,true);
  assert.equal(validation.code,'BANK_SLIP_CONFIRM_REQUIRED');
  assert.equal(draft.paymentKey,'transfer');
  assert.equal(draft.sourceWallet,'SHOP_BANK');
  assert.equal(draft.amountSatang,5000);
  assert.equal(draft.transactionDate,'2026-07-21');
});

test('Paotang subsidy receipt records 16 baht paid, not 40 baht gross',()=>{
  const result=reading({channel:'G_WALLET',institution:'Paotang',transactionType:'WALLET_PAYMENT',paymentDate:'2026-07-11',paymentTime:'16:04',referenceId:'PAOTANG-REF-1',recipient:'',merchant:'PA Plastic',grossAmountBaht:40,discountAmountBaht:24,paidAmountBaht:16,suggestedDescription:'Packaging - PA Plastic',suggestedCategory:'packaging'});
  const draft=bankSlipExpenseDraft(result.document);
  assert.equal(validateBankSlip(result).ok,true);
  assert.equal(draft.amountSatang,1600);
  assert.equal(draft.sourceWallet,'SHOP_BANK');
  assert.equal(draft.category,'packaging');
});

test('merchant hints upgrade safe general categories before showing confirmation',()=>{
  const paotang=bankSlipExpenseDraft(reading({merchant:'ร้าน PA พลาสติก',recipient:'ร้าน PA พลาสติก',suggestedDescription:'ร้าน PA พลาสติก',suggestedCategory:'general'}).document);
  const printing=bankSlipExpenseDraft(reading({merchant:'ออนตาการพิมพ์',suggestedDescription:'ออนตาการพิมพ์',suggestedCategory:'general'}).document);
  assert.equal(paotang.category,'packaging');
  assert.equal(printing.category,'marketing');
});

test('failed or incomplete slip is not allowed to create an expense',()=>{
  const result=reading({transactionStatus:'PENDING',referenceId:'',paidAmountBaht:null});
  const validation=validateBankSlip(result);
  assert.equal(validation.ok,false);
  assert.equal(validation.code,'BANK_SLIP_FIELDS_MISSING');
  assert.deepEqual(validation.missing,['successful status','reference ID','paid amount','valid paid amount']);
});
