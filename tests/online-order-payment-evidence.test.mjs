import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeOpenAIVisionResult,buildOpenAIVisionPayload} from '../dist/vision/openai.js';
import {purchaseExpenseDraft,purchaseDraftMissingReasons} from '../dist/expense/document.js';
import {shouldRetryOpenAIOnlineOrder} from '../dist/vision/service.js';
import {handleExpenseImage} from '../dist/expense/service.js';
import {expenseSqlite,receipt,imageEvent,receiptReading} from './helpers/expense-sqlite.mjs';

const order=(overrides={})=>receipt({documentType:'ONLINE_ORDER',orderId:'SYNTHETIC-PAYMENT-EVIDENCE',
  documentDate:'2026-02-13',paymentDate:'2026-02-14',paymentTime:'10:12',paymentDateFormat:'YMD',
  paymentDatePurpose:'PAYMENT',paymentDateLabel:'เวลาที่ชำระเงิน',paymentStatus:'PAID',
  orderTotalBaht:519,orderTotalLabel:'รวมคำสั่งซื้อ',finalPaidAmountBaht:519,
  paymentMethod:'บัตรเครดิต/บัตรเดบิต',sourceWalletCandidate:'',suggestedCategory:'equipment',...overrides});
const read=(overrides={})=>normalizeOpenAIVisionResult({kind:'ONLINE_ORDER',confidence:.99,document:order(overrides)},{});

test('new extraction requires the printed payment date label and separates order placement from payment',()=>{
  const payload=buildOpenAIVisionPayload('gpt-4.1-mini',new Uint8Array([255,216,255,217]).buffer);
  const schema=payload.text.format.schema.properties.document.anyOf[1];
  assert.ok(schema.required.includes('paymentDateLabel'));
  assert.ok(schema.properties.paymentDatePurpose.enum.includes('ORDER_PLACED'));
  const prompt=payload.input[0].content[0].text;
  assert.match(prompt,/เวลาที่สั่งซื้อ/);
  assert.match(prompt,/never use them as paymentDate or paymentTime/);
  assert.match(prompt,/refund-request button, or a track-order button alone does not prove completed payment/);
});

test('a known total with UNKNOWN payment status retains the amount without inventing a paid amount or date',()=>{
  const reading=read({paymentStatus:'UNKNOWN',paymentDate:'2026-02-13',paymentDateLabel:'เวลาที่สั่งซื้อ'});
  const d=reading.document;
  assert.equal(d.orderTotalBaht,519);
  assert.equal(d.orderTotalLabel,'รวมคำสั่งซื้อ');
  assert.equal(d.finalPaidAmountBaht,null);
  assert.equal(d.paymentDate,'');assert.equal(d.paymentTime,'');
  assert.equal(d.documentDate,'2026-02-13');
  assert.equal(d.needsReview,true);
  assert.equal(purchaseExpenseDraft(d),null);
  assert.deepEqual(purchaseDraftMissingReasons(d),['Payment status is unverified','Missing or invalid payment date']);
  assert.equal(shouldRetryOpenAIOnlineOrder(reading),false);
});

test('an order, delivery or absent printed label cannot authorize a payment date even if the model reports PAYMENT and PAID',()=>{
  for(const paymentDateLabel of ['เวลาที่สั่งซื้อ','วันที่สั่งซื้อ','Order time','Order placed','Expected delivery','วันที่จัดส่ง','']){
    const reading=read({paymentDateLabel});
    assert.equal(reading.document.paymentDate,'',paymentDateLabel);
    assert.equal(reading.document.paymentTime,'',paymentDateLabel);
    assert.equal(purchaseExpenseDraft(reading.document),null,paymentDateLabel);
    assert.equal(shouldRetryOpenAIOnlineOrder(reading),false,paymentDateLabel);
  }
  const placed=read({paymentDatePurpose:'ORDER_PLACED'}).document;
  assert.equal(placed.paymentDate,'');assert.equal(placed.paymentTime,'');
  assert.equal(purchaseExpenseDraft(placed),null);
});

test('explicit Thai and English payment date labels retain a paid draft and an unconfirmed generic card',()=>{
  for(const paymentDateLabel of ['เวลาที่ชำระเงิน','วันที่ชำระเงิน','Payment date','Payment time','Payment date/time:','Paid on','Paid at']){
    const d=read({paymentDateLabel,sourceWalletCandidate:'CARD_KBANK'}).document,draft=purchaseExpenseDraft(d);
    assert.equal(d.paymentDate,'2026-02-14',paymentDateLabel);
    assert.equal(d.paymentTime,'10:12',paymentDateLabel);
    assert.equal(d.needsReview,false,paymentDateLabel);
    assert.equal(draft.amountSatang,51900,paymentDateLabel);
    assert.equal(draft.sourceWallet,'UNCONFIRMED',paymentDateLabel);
  }
});

test('older paid snapshots without a date-label field remain valid through repeated normalization',()=>{
  const legacy=order();delete legacy.paymentDateLabel;
  const first=normalizeOpenAIVisionResult({kind:'ONLINE_ORDER',document:legacy},{}).document;
  const second=normalizeOpenAIVisionResult({kind:'ONLINE_ORDER',document:first},{}).document;
  for(const d of [first,second]){
    assert.equal(Object.hasOwn(d,'paymentDateLabel'),false);
    assert.equal(d.paymentDate,'2026-02-14');
    assert.equal(purchaseExpenseDraft(d).amountSatang,51900);
  }
});

test('pending, unpaid and unknown evidence remains held despite a supplied amount and date',()=>{
  for(const paymentStatus of ['UNKNOWN','PENDING','UNPAID']){
    const raw=order({paymentStatus});
    assert.equal(purchaseExpenseDraft(raw),null,paymentStatus);
    const reading=read({paymentStatus}),d=reading.document;
    assert.equal(d.finalPaidAmountBaht,null,paymentStatus);
    assert.equal(d.needsReview,true,paymentStatus);
    assert.equal(purchaseDraftMissingReasons(d).includes('Missing final paid amount'),false,paymentStatus);
    assert.equal(shouldRetryOpenAIOnlineOrder(reading),false,paymentStatus);
  }
});

async function receive(h,document,{id='synthetic_hold',failReply=false,calls=[],queued=[]}={}){
  const originalFetch=globalThis.fetch;
  try{
    globalThis.fetch=async(_url,init)=>{calls.push(JSON.parse(String(init?.body||'{}')));return new Response(failReply?'unavailable':'',{status:failReply?503:200});};
    const env={...h.env,RUNTIME_MODE:'production',LINE_CHANNEL_ACCESS_TOKEN:'synthetic-line-token',EXTERNAL_API_TIMEOUT_MS:'1000',
      JOB_QUEUE:{async send(job){queued.push(job);},async sendBatch(jobs){h.queue.push(...jobs);}}};
    await handleExpenseImage(env,{...imageEvent(id),replyToken:`reply-${id}`,webhookEventId:`webhook-${id}`},receiptReading(document),`${id}.jpg`,`trace-${id}`,`hash-${id}`);
    return{calls,queued};
  }finally{globalThis.fetch=originalFetch;}
}

test('the retained hold keeps workflow review metadata even when the extraction reports no review reasons',async()=>{
  const h=expenseSqlite();
  try{
    // Reproduce an older extraction with a known total and unverified status.
    const document=order({paymentStatus:'UNKNOWN',finalPaidAmountBaht:null,needsReview:false,reviewReasons:[]});
    delete document.paymentDateLabel;
    const {calls}=await receive(h,document);
    const d=h.sqlite.prepare('SELECT * FROM expense_documents').get();
    assert.equal(d.status,'WAITING_REVIEW');assert.equal(d.needs_review,1);
    assert.equal(d.review_note,'Payment status is unverified');
    assert.equal(d.ai_json,JSON.stringify(document),'extracted evidence must stay immutable');
    assert.equal(d.expense_id,null);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,0);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_document_items').get().n,1);
    assert.equal(h.sqlite.prepare('SELECT state FROM expense_online_order_claims').get().state,'REVIEW_ONLY');
    assert.equal(h.sqlite.prepare("SELECT reason FROM expense_audit_log WHERE action='EXTRACT'").get().reason,d.review_note);
    const message=calls[0].messages[0].text;
    assert.match(message,/519\.00 บาท/);assert.match(message,/ยังยืนยันการชำระเงินสำเร็จไม่ได้/);
    assert.match(message,/วันที่ชำระเงินครบถ้วน/);
    assert.doesNotMatch(message,/Missing final paid amount/);
    assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{h.close();}
});

test('a failed hold reply and a newer paid-image repeat cannot replay or auto-promote the business transaction',async()=>{
  const h=expenseSqlite(),queued=[];
  try{
    await receive(h,read({paymentStatus:'UNKNOWN',paymentDateLabel:'เวลาที่สั่งซื้อ'}).document,{failReply:true,queued});
    const before=h.sqlite.prepare('SELECT * FROM expense_documents').get();
    const items=h.sqlite.prepare('SELECT * FROM expense_document_items').all();
    const {calls}=await receive(h,read().document,{id:'synthetic_new_paid_image',queued});
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,0);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_documents').get().n,1);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_document_links').get().n,0);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,1);
    assert.deepEqual(h.sqlite.prepare('SELECT * FROM expense_documents').get(),before);
    assert.deepEqual(h.sqlite.prepare('SELECT * FROM expense_document_items').all(),items);
    assert.equal(h.sqlite.prepare('SELECT state FROM expense_online_order_claims').get().state,'REVIEW_ONLY');
    assert.equal(queued.length,1);assert.equal(queued[0].kind,'LINE_NOTIFICATION');
    const message=calls[0].messages[0].text;
    assert.match(message,/ยังไม่มีค่าใช้จ่ายที่บันทึกจากรายการนี้/);
    assert.match(message,/คำสั่งซื้อนี้ยังรอตรวจหลักฐาน/);
    assert.doesNotMatch(message,/already owns|519|SYNTHETIC-PAYMENT-EVIDENCE/);
    assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{h.close();}
});

test('complete paid evidence still opens the existing card chooser without finalization or Sheets writes',async()=>{
  const h=expenseSqlite();
  try{
    const {calls}=await receive(h,read().document);
    const e=h.sqlite.prepare('SELECT * FROM expense_events').get();
    assert.equal(e.status,'WAITING_CONFIRM');assert.equal(e.amount_satang,51900);
    assert.equal(e.transaction_date,'2026-02-14');
    assert.equal(e.payment_key,'unconfirmed');assert.equal(e.source_wallet,'UNCONFIRMED');
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    assert.match(JSON.stringify(calls[0].messages[0]),/เลือกวิธีชำระเงิน/);
    assert.doesNotMatch(JSON.stringify(calls[0].messages[0]),/ยังยืนยันการชำระเงินสำเร็จไม่ได้/);
  }finally{h.close();}
});
