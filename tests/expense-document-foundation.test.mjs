import test from 'node:test';
import assert from 'node:assert/strict';
import {purchaseExpenseDraft,sellerDocumentCases} from '../dist/expense/document.js';
import {handleExpenseImage} from '../dist/expense/service.js';
import {exactDocumentMatch} from '../dist/expense/linking.js';
import {normalizeOpenAIVisionResult} from '../dist/vision/openai.js';

function document(overrides={}){
  return{documentType:'RECEIPT',vendor:'Mali Supplier',legalVendorName:'Mali Supplier Co',documentNumber:'INV-1',orderId:'',documentDate:'2026-07-27',paymentDate:'2026-07-27',paymentTime:'10:00',currency:'THB',subtotalBaht:180,shippingBaht:0,discountBaht:0,subsidyBaht:0,vatBaht:0,grossAmountBaht:180,finalPaidAmountBaht:180,paymentMethod:'Cash',sourceWalletCandidate:'CASH_DRAWER',suggestedDescription:'Ingredients',suggestedCategory:'ingredients',confidence:.98,needsReview:false,reviewReasons:[],items:[{sellerKey:'Mali Supplier',productCode:'E45',description:'Egg',quantity:4,unit:'pcs',unitPriceBaht:45,discountBaht:0,lineTotalBaht:180,vatBaht:0,confidence:.98,needsReview:false}],...overrides};
}
function reading(doc){return{kind:doc.documentType==='ONLINE_ORDER'?'ONLINE_ORDER':doc.documentType==='DELIVERY_ORDER'?'DELIVERY_ORDER':'RECEIPT',hour:null,minute:null,month:null,day:null,weekday:null,confidence:doc.confidence,clockFullyVisible:null,needsNewPhoto:false,note:'',provider:'openai',raw:{},document:doc};}
function harness(firstResults=[]){
  const state={batches:[],runs:[]};
  const DB={prepare(sql){return{sql,args:[],bind(...args){this.args=args;return this;},async first(){return firstResults.shift()||null;},async run(){state.runs.push({sql:this.sql,args:this.args});return{meta:{changes:1}};}};},async batch(items){state.batches.push(items.map(item=>({sql:item.sql,args:item.args})));return items.map(()=>({meta:{changes:1}}));}};
  return{state,env:{DB,RUNTIME_MODE:'shadow',SHADOW_LINE_OUTPUT:'false'},event:{source:{type:'user',userId:'U_TEST'},message:{id:'img_1',type:'image'}},actor:{employeeId:'EMP001',branchId:'B001'}};
}

test('approved accounting amounts preserve paid amount after subsidy and marketplace discounts',()=>{
  assert.equal(purchaseExpenseDraft(document({documentType:'RECEIPT',grossAmountBaht:330,subsidyBaht:198,finalPaidAmountBaht:132})).amountSatang,13200);
  const online=purchaseExpenseDraft(document({documentType:'ONLINE_ORDER',documentDate:'2026-07-31',paymentDate:'2026-07-30',grossAmountBaht:475,shippingBaht:103,discountBaht:222,finalPaidAmountBaht:356,sourceWalletCandidate:''}));
  assert.equal(online.amountSatang,35600);assert.equal(online.transactionDate,'2026-07-30');assert.equal(online.needsPaymentConfirmation,true);
});

test('Delivery Order and online order without payment date are review-only, never final drafts',()=>{
  assert.equal(purchaseExpenseDraft(document({documentType:'DELIVERY_ORDER'})),null);
  assert.equal(purchaseExpenseDraft(document({documentType:'ONLINE_ORDER',paymentDate:''})),null);
});

test('one marketplace image with two sellers creates two separate review cases',()=>{
  const cases=sellerDocumentCases(document({documentType:'ONLINE_ORDER',vendor:'Shopee',items:[
    {sellerKey:'Seller A',productCode:'A',description:'A',quantity:1,unit:'pc',unitPriceBaht:100,discountBaht:0,lineTotalBaht:100,vatBaht:0,confidence:.9,needsReview:false},
    {sellerKey:'Seller B',productCode:'B',description:'B',quantity:1,unit:'pc',unitPriceBaht:200,discountBaht:0,lineTotalBaht:200,vatBaht:0,confidence:.9,needsReview:false}
  ],finalPaidAmountBaht:250,discountBaht:50}));
  assert.equal(cases.length,2);assert.ok(cases.every(item=>item.requiresReview));
});

test('receipt extraction persists structured document, normalized items, ownership, link and append-only audit',async()=>{
  const h=harness();await handleExpenseImage(h.env,h.event,reading(document()),'expense/test.jpg','trace','hash',h.actor);
  const statements=h.state.batches[0];
  assert.ok(statements.some(item=>item.sql.includes('INSERT INTO expense_events')));
  assert.ok(statements.some(item=>item.sql.includes('expense_document_items')));
  assert.ok(statements.some(item=>item.sql.includes('expense_document_links')));
  assert.ok(statements.some(item=>item.sql.includes('expense_document_cases')));
  assert.ok(statements.some(item=>item.sql.includes('expense_audit_log')));
  const event=statements.find(item=>item.sql.includes('INSERT INTO expense_events'));
  assert.equal(event.args[4],18000);assert.equal(event.args[11],'EMP001');assert.equal(event.args[12],'B001');
});

test('Delivery Order is stored as supporting evidence without creating a payable expense',async()=>{
  const h=harness();await handleExpenseImage(h.env,h.event,reading(document({documentType:'DELIVERY_ORDER',finalPaidAmountBaht:null,paymentDate:''})),'expense/do.jpg','trace','hash-do',h.actor);
  assert.equal(h.state.batches[0].some(item=>item.sql.includes('INSERT INTO expense_events')),false);
  assert.ok(h.state.batches[0].some(item=>item.sql.includes('expense_document_cases')));
});

test('a Delivery Order with an exact order ID links supporting evidence and never creates a second expense',async()=>{
  const h=harness([null,{document_id:'doc_purchase',expense_id:'exp_purchase',document_type:'TAX_INVOICE',legal_vendor_name:'Mali Supplier Co',document_number:'INV-1',order_id:'ORDER-1'}]);
  await handleExpenseImage(h.env,h.event,reading(document({documentType:'DELIVERY_ORDER',documentNumber:'',orderId:'ORDER-1',finalPaidAmountBaht:null,paymentDate:''})),'expense/do-linked.jpg','trace','hash-do-linked',h.actor);
  assert.equal(h.state.batches[0].some(item=>item.sql.includes('INSERT INTO expense_events')),false);
  const link=h.state.batches[0].find(item=>item.sql.includes('expense_document_links'));
  assert.equal(link.args[1],'exp_purchase');assert.equal(link.args[3],'SUPPORTING_DOCUMENT');
});

test('only exact printed identifiers permit automatic document matching',()=>{
  const incoming=document({orderId:'ORDER-100'}),existing={documentId:'doc',expenseId:'exp',documentType:'TAX_INVOICE',legalVendorName:'Different vendor',documentNumber:'X',orderId:'ORDER-100'};
  assert.equal(exactDocumentMatch(incoming,existing).matched,true);
  assert.equal(exactDocumentMatch(document({orderId:'',documentNumber:'INV-1'}),{...existing,orderId:'',legalVendorName:'Other',documentNumber:'INV-1'}).matched,false);
});

test('OpenAI normalizes a long tax invoice without truncating visible line items',()=>{
  const items=Array.from({length:15},(_,index)=>({sellerKey:'KCC',productCode:`P-${index}`,description:`Product ${index}`,quantity:1,unit:'pc',unitPriceBaht:100,discountBaht:0,lineTotalBaht:100,vatBaht:0,confidence:.95,needsReview:false}));
  const result=normalizeOpenAIVisionResult({kind:'RECEIPT',hour:null,minute:null,month:null,day:null,weekday:null,confidence:.95,clockFullyVisible:null,clockPresent:null,clockConfidence:0,overlayPresent:false,overlayTextWhite:false,photoDate:null,photoTime:null,latitude:null,longitude:null,locationText:'',overlayRawText:'',overlayConfidence:0,needsNewPhoto:false,note:'',document:document({documentType:'TAX_INVOICE',items,finalPaidAmountBaht:16551,grossAmountBaht:16551})},{});
  assert.equal(result.document.documentType,'TAX_INVOICE');assert.equal(result.document.items.length,15);
});
