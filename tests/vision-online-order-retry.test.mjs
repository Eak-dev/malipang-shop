import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyAndRead,chooseBetterOnlineOrderReading,shouldRetryOpenAIOnlineOrder} from '../dist/vision/service.js';
import {normalizeOpenAIVisionResult} from '../dist/vision/openai.js';
import {expenseSqlite,receipt} from './helpers/expense-sqlite.mjs';

const order=(overrides={})=>receipt({documentType:'ONLINE_ORDER',orderId:'SYNTHETIC-ORDER',paymentDateFormat:'YMD',paymentDatePurpose:'PAYMENT',paymentStatus:'PAID',orderTotalLabel:'รวมคำสั่งซื้อ',orderTotalBaht:462,finalPaidAmountBaht:462,discountBaht:42,paymentMethod:'บัตรเครดิต/บัตรเดบิต',sourceWalletCandidate:'',...overrides});
const result=(overrides={})=>normalizeOpenAIVisionResult({kind:'ONLINE_ORDER',confidence:.98,document:order(overrides)},{});

test('amount retry is limited to paid THB orders with exact identity and payment date',()=>{
  assert.equal(shouldRetryOpenAIOnlineOrder(result({orderTotalBaht:null,orderTotalLabel:'',finalPaidAmountBaht:null})),true);
  assert.equal(shouldRetryOpenAIOnlineOrder(result({finalPaidAmountBaht:420})),true);
  assert.equal(shouldRetryOpenAIOnlineOrder(result()),false);
  for(const overrides of [{orderId:''},{paymentStatus:'UNPAID'},{paymentStatus:'PENDING'},{paymentStatus:'UNKNOWN'},{paymentDate:''},{paymentDatePurpose:'EXPECTED_DELIVERY'},{currency:'USD'}]){
    assert.equal(shouldRetryOpenAIOnlineOrder(result({finalPaidAmountBaht:null,...overrides})),false,JSON.stringify(overrides));
  }
});

test('retry accepts the printed post-discount total and keeps known order evidence consistent',()=>{
  const first=result({finalPaidAmountBaht:420}),retry=result();
  assert.equal(chooseBetterOnlineOrderReading(first,retry),retry);
  assert.equal(retry.document.finalPaidAmountBaht,462);
  assert.equal(retry.document.sourceWalletCandidate,'');
  const missing=result({orderTotalBaht:null,orderTotalLabel:'',finalPaidAmountBaht:null});
  assert.equal(chooseBetterOnlineOrderReading(missing,retry),retry);
  for(const overrides of [{orderId:'OTHER-ORDER'},{paymentDate:'2026-01-11'},{currency:'USD'},{orderTotalBaht:420,finalPaidAmountBaht:420},{paymentStatus:'UNKNOWN'},{orderTotalLabel:''},{finalPaidAmountBaht:420}]){
    assert.equal(chooseBetterOnlineOrderReading(first,result(overrides)),first,JSON.stringify(overrides));
  }
  assert.equal(chooseBetterOnlineOrderReading(retry,first),retry,'a complete first reading must never be replaced');
  assert.equal(chooseBetterOnlineOrderReading(first,result({items:[]})),first,'retry must not discard retained item rows');
});

async function classifyFixture(documents,{limit='100',failRetry=false}={}){
  const h=expenseSqlite(),originalFetch=globalThis.fetch,calls=[];
  const env={...h.env,WORKERS_AI_ENABLED:'false',OPENAI_FALLBACK_ENABLED:'true',OPENAI_API_KEY:'synthetic-key',OPENAI_MODEL:'gpt-4.1-mini',OPENAI_DAILY_FALLBACK_LIMIT:limit,VISION_TIMEOUT_MS:'1000'};
  try{
    globalThis.fetch=async(_url,init)=>{
      calls.push(JSON.parse(init.body));
      if(failRetry&&calls.length===2)throw new Error('synthetic retry unavailable');
      const document=documents[Math.min(calls.length-1,documents.length-1)];
      return Response.json({output_text:JSON.stringify({kind:'ONLINE_ORDER',confidence:.98,document})});
    };
    const image=new Uint8Array([255,216,255,217]).buffer;
    const reading=await classifyAndRead(env,image,image,'synthetic-trace');
    return{reading,calls,usage:h.sqlite.prepare('SELECT value FROM usage_daily').get().value,metrics:h.sqlite.prepare('SELECT name FROM metrics').all()};
  }finally{globalThis.fetch=originalFetch;h.close();}
}

test('classification retries once with focused prompt and accounts for both calls',async()=>{
  const r=await classifyFixture([order({orderTotalBaht:null,orderTotalLabel:'',finalPaidAmountBaht:null}),order()]);
  assert.equal(r.reading.document.finalPaidAmountBaht,462);
  assert.equal(r.calls.length,2);
  assert.equal(r.usage,2);
  assert.match(r.calls[1].input[0].content[0].text,/Recheck this ONLINE_ORDER image/);
  assert.ok(r.metrics.some(x=>x.name==='vision_openai_retry_ms'));
  assert.equal(r.reading.purchaseEvidenceAttempts.length,2);
  assert.equal(r.reading.purchaseEvidenceAttempts[0].rawOrderTotalBaht,null);
  assert.equal(r.reading.purchaseEvidenceAttempts[1].rawOrderTotalBaht,462);
  assert.equal(r.reading.purchaseEvidenceAttempts[1].normalizedAmountBaht,462);
  assert.ok(r.reading.purchaseEvidenceAttempts.every(x=>x.model==='gpt-4.1-mini'&&x.promptVersion==='online-order-payment-2026-10-27'));
  assert.doesNotMatch(JSON.stringify(r.reading.purchaseEvidenceAttempts),/SYNTHETIC-ORDER|Synthetic supplier|TEST-SKU|output_text|synthetic-key/);
});

test('unreadable retries and exhausted budget keep the original hold without further calls',async()=>{
  const incomplete=order({orderTotalBaht:null,orderTotalLabel:'',finalPaidAmountBaht:null});
  const twice=await classifyFixture([incomplete,incomplete]);
  assert.equal(twice.calls.length,2);
  assert.equal(twice.reading.document.finalPaidAmountBaht,null);
  const limited=await classifyFixture([incomplete,order()],{limit:'1'});
  assert.equal(limited.calls.length,1);
  assert.equal(limited.reading.document.finalPaidAmountBaht,null);
  const complete=await classifyFixture([order()]);
  assert.equal(complete.calls.length,1);
  const unpaid=await classifyFixture([order({paymentStatus:'UNPAID'})]);
  assert.equal(unpaid.calls.length,1);
});

test('a failed amount retry preserves the first reading and does not fail the inbound transaction',async()=>{
  const r=await classifyFixture([order({finalPaidAmountBaht:420})],{failRetry:true});
  assert.equal(r.calls.length,2);
  assert.equal(r.reading.document.finalPaidAmountBaht,null);
  assert.match(r.reading.document.reviewReasons.join(';'),/Amount evidence conflicts/);
  assert.equal(r.reading.purchaseEvidenceAttempts.length,1);
  assert.equal(r.reading.purchaseEvidenceAttempts[0].rawFinalPaidAmountBaht,420);
  assert.equal(r.reading.purchaseEvidenceAttempts[0].normalizedAmountBaht,null);
  assert.ok(r.reading.purchaseEvidenceAttempts[0].reasonCodes.includes('AMOUNT_CONFLICT'));
});
