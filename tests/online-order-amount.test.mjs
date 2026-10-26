import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOpenAIVisionPayload,normalizeOpenAIVisionResult} from '../dist/vision/openai.js';
import {classifyAndRead} from '../dist/vision/service.js';
import {recoverOnlineOrderAmount,shouldRetryOnlineOrderAmount,onlineOrderAmountReasons} from '../dist/domain/online-order.js';
import {purchaseDraftMissingReasons,purchaseExpenseDraft} from '../dist/expense/document.js';
import {handleExpenseImage} from '../dist/expense/service.js';
import {expenseSqlite,receipt,imageEvent} from './helpers/expense-sqlite.mjs';

// Synthetic data only; these are not Production order IDs, receipts or totals.
function document(overrides={}){
  return receipt({documentType:'ONLINE_ORDER',documentNumber:'',orderId:'TEST-ORDER-A',
    paymentDateFormat:'YMD',paymentDatePurpose:'PAYMENT',paymentStatus:'PAID',
    orderTotalLabel:'รวมคำสั่งซื้อ',orderTotalBaht:500,finalPaidAmountBaht:null,
    subtotalBaht:null,grossAmountBaht:null,discountBaht:40,
    paymentMethod:'บัตรเครดิต/บัตรเดบิต',sourceWalletCandidate:'CARD_KBANK',...overrides});
}
const rawReading=overrides=>({kind:'ONLINE_ORDER',confidence:.99,document:document(overrides)});
const normalized=overrides=>normalizeOpenAIVisionResult(rawReading(overrides),{});
const missing=overrides=>normalized({orderTotalLabel:'',orderTotalBaht:null,...overrides});
const image=new Uint8Array([255,216,255,217]).buffer;

test('prompt copies displayed totals without recomputing VIP discounts; retry is independent',()=>{
  const prompt=buildOpenAIVisionPayload('fixture-model',image).input[0].content[0].text;
  assert.match(prompt,/never subtract them again/i);
  assert.match(prompt,/no separately printed final-paid amount, leave finalPaidAmountBaht=null/i);
  assert.match(prompt,/For BANK_SLIP only, paidAmountBaht/i);
  assert.doesNotMatch(prompt,/ONLINE_ORDER amount review:/);
  const retry=buildOpenAIVisionPayload('fixture-model',image,true);
  assert.match(retry.input[0].content[0].text,/independently inspect the entire original image again/);
  assert.match(retry.input[0].content[0].text,/Do not invent a total because this is a retry/);
  assert.equal(retry.store,false);
});

test('format-equivalent Thai/English labels work without widening the allowlist',()=>{
  for(const orderTotalLabel of ['รวมคำสั่งซื้อ :','รวมค\u0e4d\u0e32สั่งซื้อ：','\u200bรวมคำสั่งซื้อ\ufeff','Order  total :']){
    const d=normalized({orderTotalLabel}).document;
    assert.equal(d.finalPaidAmountBaht,500,orderTotalLabel);
    assert.equal(d.discountBaht,40);
    assert.equal(purchaseExpenseDraft(d).amountSatang,50000);
    assert.equal(purchaseExpenseDraft(d).sourceWallet,'UNCONFIRMED');
  }
  for(const orderTotalLabel of ['Subtotal','Expected order total','รวมราคาสินค้า','Order total plus savings']){
    assert.equal(normalized({orderTotalLabel}).document.finalPaidAmountBaht,null);
  }
});

test('normalization records derived failure classes, never trusting model issue metadata',()=>{
  for(const [overrides,issue] of [
    [{orderTotalBaht:null,orderTotalLabel:''},'MISSING_TOTAL'],
    [{orderTotalBaht:0},'INVALID_TOTAL'],
    [{orderTotalBaht:'not-a-number'},'INVALID_TOTAL'],
    [{orderTotalLabel:'Unrecognized total'},'INVALID_TOTAL'],
    [{orderTotalBaht:null,finalPaidAmountBaht:500},'INVALID_TOTAL'],
    [{finalPaidAmountBaht:460},'CONFLICT'],
    [{paymentStatus:'UNPAID'},'PAYMENT_UNCONFIRMED'],
    [{paymentStatus:'UNKNOWN'},'PAYMENT_UNCONFIRMED']
  ]){
    const d=normalized({...overrides,onlineOrderAmountIssue:'MISSING_TOTAL'}).document;
    assert.equal(d.onlineOrderAmountIssue,issue);
    assert.equal(d.needsReview,true);
    assert.ok(d.reviewReasons.includes(onlineOrderAmountReasons[issue]));
    assert.equal(d.finalPaidAmountBaht,null);
    assert.equal(purchaseExpenseDraft(d),null);
  }
  const good=normalized({onlineOrderAmountIssue:'CONFLICT'}).document;
  assert.equal(good.onlineOrderAmountIssue,undefined);
  assert.equal(good.finalPaidAmountBaht,500);
});

test('conflicts report the actual reason, including already-stored legacy conflict notes',()=>{
  const d=normalized({finalPaidAmountBaht:460}).document;
  assert.match(purchaseDraftMissingReasons(d).join(' '),/ขัดแย้ง/);
  assert.doesNotMatch(purchaseDraftMissingReasons(d).join(' '),/Missing final paid amount/);
  delete d.onlineOrderAmountIssue;
  assert.match(purchaseDraftMissingReasons(d).join(' '),/ขัดแย้ง/);
});

test('only wholly absent paid-order amounts with usable identity/date qualify for retry',()=>{
  assert.equal(shouldRetryOnlineOrderAmount(missing()),true);
  for(const overrides of [
    {orderId:''},{vendor:''},{paymentDate:''},{paymentDatePurpose:'EXPECTED_DELIVERY'},
    {paymentStatus:'PENDING'},{currency:'USD'},{confidence:.84},
    {finalPaidAmountBaht:500},{orderTotalBaht:0},{orderTotalLabel:'Unrecognized total'},
    {reviewReasons:['Amount evidence conflicts']}
  ])assert.equal(shouldRetryOnlineOrderAmount(missing(overrides)),false,JSON.stringify(overrides));
  assert.equal(shouldRetryOnlineOrderAmount(normalized()),false);
  assert.equal(shouldRetryOnlineOrderAmount(normalized({finalPaidAmountBaht:460})),false);
  const legacy=missing();delete legacy.document.onlineOrderAmountIssue;
  assert.equal(shouldRetryOnlineOrderAmount(legacy),false);
});

test('retry fills only validated amount fields and requires human review without guessing card source',()=>{
  const first=missing(),retry=normalized({suggestedDescription:'Do not replace',sourceWalletCandidate:'CARD_TTB',items:document().items.map(item=>({...item,description:'Do not replace items'}))});
  const recovered=recoverOnlineOrderAmount(first,retry);
  assert.notEqual(recovered,first);
  assert.equal(first.document.finalPaidAmountBaht,null);
  assert.equal(recovered.document.finalPaidAmountBaht,500);
  assert.equal(recovered.document.items,first.document.items);
  assert.equal(recovered.document.discountBaht,40);
  assert.equal(recovered.document.suggestedDescription,first.document.suggestedDescription);
  assert.equal(recovered.document.sourceWalletCandidate,'');
  assert.equal(recovered.document.needsReview,true);
  assert.equal(recovered.document.onlineOrderAmountIssue,undefined);
  assert.doesNotMatch(recovered.document.reviewReasons.join(' '),/Missing final paid amount/);
  assert.equal(purchaseExpenseDraft(recovered.document).amountSatang,50000);
});

test('unreliable or different-order retry cannot replace first-read evidence',()=>{
  const first=missing();
  for(const overrides of [
    {orderId:'test-order-a'},{orderId:'TEST-ORDER-B'},{vendor:'Different seller'},
    {paymentDate:'2026-01-11'},{paymentTime:'11:00'},{paymentTime:''},{currency:'USD'},
    {paymentStatus:'PENDING'},{paymentDatePurpose:'EXPECTED_DELIVERY'},
    {orderTotalLabel:'Subtotal'},{finalPaidAmountBaht:460},{confidence:.84},
    {needsReview:true},{reviewReasons:['Payment amount unclear']},{items:[]},
    {items:[...document().items,{...document().items[0],sellerKey:'Another seller'}]}
  ])assert.equal(recoverOnlineOrderAmount(first,normalized(overrides)),first,JSON.stringify(overrides));
  assert.equal(recoverOnlineOrderAmount(first,missing()),first);
  const conflict=normalized({finalPaidAmountBaht:460});
  assert.equal(recoverOnlineOrderAmount(conflict,normalized()),conflict);
  assert.notEqual(recoverOnlineOrderAmount(first,normalized({orderId:' TEST-ORDER-A '})),first);
});

async function withVision(responses,run,{limit=100,options={}}={}){
  const h=expenseSqlite(),originalFetch=globalThis.fetch,calls=[];
  const env={...h.env,OPENAI_API_KEY:'fixture-key',OPENAI_MODEL:'fixture-model',
    OPENAI_FALLBACK_ENABLED:'true',WORKERS_AI_ENABLED:'false',OPENAI_DAILY_FALLBACK_LIMIT:String(limit),VISION_TIMEOUT_MS:'1000'};
  try{
    globalThis.fetch=async(url,init)=>{
      assert.equal(url,'https://api.openai.com/v1/responses');
      calls.push(JSON.parse(init.body));
      assert.ok(responses.length,'unexpected additional API call');
      const next=responses.shift();
      if(next instanceof Error)throw next;
      return new Response(JSON.stringify({output_text:JSON.stringify(next)}),{status:200});
    };
    const result=await classifyAndRead(env,image,image,'fixture-trace',options);
    await run({result,calls,...h});
  }finally{globalThis.fetch=originalFetch;h.close();}
}

test('classifyAndRead retries once, charges the same daily budget, records sanitized outcome',async()=>{
  await withVision([rawReading({orderTotalBaht:null,orderTotalLabel:''}),rawReading({})],({result,calls,sqlite})=>{
    assert.equal(calls.length,2);
    assert.match(calls[1].input[0].content[0].text,/ONLINE_ORDER amount review/);
    assert.equal(result.document.finalPaidAmountBaht,500);
    assert.equal(sqlite.prepare('SELECT value FROM usage_daily').get().value,2);
    const metric=sqlite.prepare("SELECT labels_json FROM metrics WHERE name='vision_online_order_amount_retry_ms'").get();
    assert.deepEqual(JSON.parse(metric.labels_json),{provider:'openai',outcome:'RECOVERED'});
  });
});

test('budget exhaustion preserves review-only evidence without a second network request',async()=>{
  await withVision([rawReading({orderTotalBaht:null,orderTotalLabel:''})],({result,calls,sqlite})=>{
    assert.equal(calls.length,1);
    assert.equal(result.document.finalPaidAmountBaht,null);
    assert.equal(result.document.onlineOrderAmountIssue,'MISSING_TOTAL');
    assert.match(sqlite.prepare("SELECT labels_json FROM metrics WHERE name='vision_online_order_amount_retry_ms'").get().labels_json,/BUDGET_LIMIT/);
  },{limit:1});
});

test('provider failure or unresolved retry preserves the first reading without repeated calls',async()=>{
  for(const second of [new Error('fixture failure'),rawReading({orderTotalBaht:null,orderTotalLabel:''}),rawReading({orderId:'TEST-OTHER'})]){
    await withVision([rawReading({orderTotalBaht:null,orderTotalLabel:''}),second],({result,calls,sqlite})=>{
      assert.equal(calls.length,2);
      assert.equal(result.document.orderId,'TEST-ORDER-A');
      assert.equal(result.document.finalPaidAmountBaht,null);
      const metrics=JSON.stringify(sqlite.prepare('SELECT labels_json FROM metrics').all());
      assert.doesNotMatch(metrics,/fixture-key|TEST-ORDER-A|fixture failure/);
    });
  }
});

test('valid, conflicting and unpaid readings do not trigger amount recovery',async()=>{
  for(const overrides of [{},{finalPaidAmountBaht:460},{paymentStatus:'UNPAID'}]){
    await withVision([rawReading(overrides)],({calls})=>assert.equal(calls.length,1));
  }
});

test('real SQLite: recovered amount creates one unconfirmed draft; redelivery does not duplicate it',async()=>{
  const h=expenseSqlite();
  try{
    const recovered=recoverOnlineOrderAmount(missing(),normalized());
    await handleExpenseImage(h.env,imageEvent('test-first'),recovered,'expense/test-first.jpg','fixture-trace','test-hash');
    await handleExpenseImage(h.env,imageEvent('test-repeat'),recovered,'expense/test-repeat.jpg','fixture-repeat','test-other-hash');
    const rows=h.sqlite.prepare('SELECT amount_satang,status,source_wallet FROM expense_events').all();
    assert.equal(rows.length,1);assert.equal(rows[0].amount_satang,50000);
    assert.equal(rows[0].status,'WAITING_CONFIRM');assert.equal(rows[0].source_wallet,'UNCONFIRMED');
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_documents').get().n,1);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM sync_jobs').get().n,0);
    assert.equal(h.queue.length,0);
  }finally{h.close();}
});

test('real SQLite: historical review-only orders are never upgraded by a new paid extraction',async()=>{
  const h=expenseSqlite();
  try{
    await handleExpenseImage(h.env,imageEvent('test-held'),missing(),'expense/test-held.jpg','fixture-held','test-held-hash');
    await handleExpenseImage(h.env,imageEvent('test-new'),recoverOnlineOrderAmount(missing(),normalized()),'expense/test-new.jpg','fixture-new','test-new-hash');
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_events').get().n,0);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_documents').get().n,1);
    const d=h.sqlite.prepare('SELECT status,needs_review,review_note FROM expense_documents').get();
    assert.equal(d.status,'WAITING_REVIEW');assert.equal(d.needs_review,1);
    assert.match(d.review_note,/Missing final paid amount/);
    assert.equal(h.sqlite.prepare('SELECT state FROM expense_online_order_claims').get().state,'REVIEW_ONLY');
  }finally{h.close();}
});

test('real SQLite: recovered multi-seller evidence is not combined into one payable expense',async()=>{
  const h=expenseSqlite();
  try{
    const items=[...document().items,{...document().items[0],sellerKey:'Second synthetic supplier'}];
    const result=recoverOnlineOrderAmount(missing({items}),normalized({items}));
    assert.equal(result.document.finalPaidAmountBaht,500);
    await handleExpenseImage(h.env,imageEvent('test-sellers'),result,'expense/test-sellers.jpg','fixture-sellers','test-sellers-hash');
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_events').get().n,0);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_document_cases').get().n,2);
    assert.equal(h.sqlite.prepare('SELECT status FROM expense_documents').get().status,'WAITING_REVIEW');
  }finally{h.close();}
});

test('real SQLite: failed LINE notification does not lose or duplicate a recovered draft',async()=>{
  const h=expenseSqlite(),originalFetch=globalThis.fetch,notifications=[];
  try{
    globalThis.fetch=async()=>new Response('fixture unavailable',{status:503});
    const env={...h.env,RUNTIME_MODE:'production',LINE_CHANNEL_ACCESS_TOKEN:'fixture-token',EXTERNAL_API_TIMEOUT_MS:'1000',JOB_QUEUE:{async send(job){notifications.push(job);}}};
    const result=recoverOnlineOrderAmount(missing(),normalized());
    const event={...imageEvent('test-notify'),replyToken:'fixture-reply',webhookEventId:'fixture-event'};
    await handleExpenseImage(env,event,result,'expense/test-notify.jpg','fixture-notify','test-notify-hash');
    await handleExpenseImage(env,event,result,'expense/test-notify.jpg','fixture-notify','test-notify-hash');
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_events').get().n,1);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM expense_documents').get().n,1);
    assert.equal(h.sqlite.prepare('SELECT count(*) AS n FROM sync_jobs').get().n,0);
    assert.ok(notifications.length>0);
    assert.ok(notifications.every(job=>job.kind==='LINE_NOTIFICATION'));
  }finally{globalThis.fetch=originalFetch;h.close();}
});
