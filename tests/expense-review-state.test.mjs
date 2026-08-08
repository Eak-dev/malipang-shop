import test from 'node:test';
import assert from 'node:assert/strict';
import {purchaseReviewState,unresolvedReviewFields} from '../dist/expense/review-state.js';

function document(overrides={}){
  return{documentType:'RECEIPT',vendor:'Vendor',legalVendorName:'Vendor Co',documentNumber:'INV-1',orderId:'',documentDate:'2026-08-08',paymentDate:'2026-08-08',paymentTime:'10:00',currency:'THB',subtotalBaht:93,shippingBaht:0,discountBaht:0,subsidyBaht:0,vatBaht:0,grossAmountBaht:93,finalPaidAmountBaht:93,paymentMethod:'Transfer',sourceWalletCandidate:'SHOP_BANK',suggestedDescription:'Transfer to SOMJAI YINGCHAROEN',suggestedCategory:'general',confidence:.9,needsReview:true,reviewReasons:['Please confirm the item and category before saving.'],items:[],...overrides};
}
const draft={description:'Transfer to SOMJAI YINGCHAROEN',amountSatang:9300,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'general',transactionDate:'2026-08-08'};

test('named Item and Category review reasons become explicit, actionable fields',()=>{
  assert.deepEqual(unresolvedReviewFields(purchaseReviewState(document(),draft)),['description','category']);
});

test('a low-confidence General category remains unresolved',()=>{
  const state=purchaseReviewState(document({needsReview:false,confidence:.7,reviewReasons:[]}),draft);
  assert.ok(unresolvedReviewFields(state).includes('category'));
});

test('a high-confidence confirmed General category is valid and does not force another confirmation',()=>{
  const state=purchaseReviewState(document({needsReview:false,confidence:.98,reviewReasons:[]}),draft);
  assert.deepEqual(unresolvedReviewFields(state),[]);
});

test('an invalid document date has its own guided field',()=>{
  const state=purchaseReviewState(document({needsReview:false,confidence:.98,reviewReasons:[],suggestedCategory:'ingredients'}),{...draft,category:'ingredients',transactionDate:'not-a-date'});
  assert.deepEqual(unresolvedReviewFields(state),['date']);
});
