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
function harness(firstResults=[],{enforceForeignKeys=false}={}){
  const state={batches:[],runs:[]};
  const DB={prepare(sql){return{sql,args:[],bind(...args){this.args=args;return this;},async first(){return firstResults.shift()||null;},async run(){state.runs.push({sql:this.sql,args:this.args});return{meta:{changes:1}};}};},async batch(items){
    if(enforceForeignKeys){
      const expenseIds=new Set(),documentIds=new Set();
      for(const item of items){
        if(item.sql.includes('INSERT INTO expense_events'))expenseIds.add(item.args[0]);
        if(item.sql.includes('INSERT INTO expense_documents'))documentIds.add(item.args[0]);
        if(item.sql.includes('expense_document_items')){assert.ok(documentIds.has(item.args[1]),'item document parent must exist first');assert.ok(item.args[2]==null||expenseIds.has(item.args[2]),'item expense parent must exist first');}
        if(item.sql.includes('expense_document_cases')){assert.ok(documentIds.has(item.args[1]),'case document parent must exist first');assert.ok(item.args[7]==null||expenseIds.has(item.args[7]),'case expense parent must exist first');}
        if(item.sql.includes('expense_document_links')){assert.ok(expenseIds.has(item.args[1]),'link expense parent must exist first');assert.ok(documentIds.has(item.args[2]),'link document parent must exist first');}
        if(item.sql.includes('expense_audit_log')){assert.ok(item.args[3]==null||expenseIds.has(item.args[3]),'audit expense parent must exist first');assert.ok(item.args[4]==null||documentIds.has(item.args[4]),'audit document parent must exist first');}
      }
    }
    state.batches.push(items.map(item=>({sql:item.sql,args:item.args})));return items.map(()=>({meta:{changes:1}}));
  }};
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
  assert.match(event.sql,/VALUES\(\?,\?,\?,\?,\?,\?,\?,\?,\?,'WAITING_CONFIRM',\?,\?,\?,\?\)/);
  assert.equal(event.args.length,13,'purchase draft bind count must match the fourteen insert columns including literal status');
});

test('a receipt with only payment unresolved opens the direct payment chooser, not Save review',async()=>{
  const h=harness();
  const originalFetch=globalThis.fetch,calls=[];
  const event={...h.event,replyToken:'reply-payment-only',webhookEventId:'W-payment-only'};
  try{
    globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(String(init?.body||'{}')));return new Response('',{status:200});};
    await handleExpenseImage({...h.env,RUNTIME_MODE:'production',LINE_CHANNEL_ACCESS_TOKEN:'test-token',EXTERNAL_API_TIMEOUT_MS:'1000'},event,reading(document({sourceWalletCandidate:'',needsReview:false,reviewReasons:[]})),'expense/payment-only.jpg','trace','hash-payment-only',h.actor);
    const text=JSON.stringify(calls[0]?.messages?.[0]||{});
    assert.match(text,/เลือกวิธีชำระเงิน/);
    assert.match(text,/expense_resolve_payment/);
    assert.doesNotMatch(text,/expense_confirm/);
  }finally{globalThis.fetch=originalFetch;}
});

test('a payment-unknown receipt with another unresolved document fact stays in Review',async()=>{
  const h=harness();
  const originalFetch=globalThis.fetch,calls=[];
  const event={...h.event,replyToken:'reply-payment-and-document',webhookEventId:'W-payment-and-document'};
  try{
    globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(String(init?.body||'{}')));return new Response('',{status:200});};
    await handleExpenseImage({...h.env,RUNTIME_MODE:'production',LINE_CHANNEL_ACCESS_TOKEN:'test-token',EXTERNAL_API_TIMEOUT_MS:'1000'},event,reading(document({sourceWalletCandidate:'',needsReview:true,reviewReasons:['Merchant must be confirmed']})),'expense/payment-document.jpg','trace','hash-payment-document',h.actor);
    const text=JSON.stringify(calls[0]?.messages?.[0]||{});
    assert.match(text,/expense_payment_menu/);
    assert.doesNotMatch(text,/expense_resolve_payment/);
    assert.doesNotMatch(text,/expense_confirm/);
    assert.match(text,/Document facts/);
  }finally{globalThis.fetch=originalFetch;}
});

test('purchase receipt creates parent Expense before all foreign-key dependent rows',async()=>{
  const h=harness([],{enforceForeignKeys:true});
  await handleExpenseImage(h.env,h.event,reading(document()),'expense/test.jpg','trace','hash',h.actor);
  const statements=h.state.batches[0];
  const expenseIndex=statements.findIndex(item=>item.sql.includes('INSERT INTO expense_events'));
  assert.ok(expenseIndex>=0);
  for(const fragment of ['expense_document_items','expense_document_cases','expense_document_links','expense_audit_log']){
    assert.ok(statements.findIndex(item=>item.sql.includes(fragment))>expenseIndex,`${fragment} must follow the Expense parent`);
  }
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
