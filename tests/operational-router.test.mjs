import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {receipt} from './helpers/expense-sqlite.mjs';
import {processInbound} from '../dist/router/process-event.js';

async function imageRun(t,{failMetrics=false,failReply=false,receivedOffset=-4000,receivedAt}={}){
 const h=ownerOrderFixture(),start=Date.parse('2026-10-27T05:00:00.000Z');let clock=start,aiCalls=0,uploads=0;
 t.mock.method(Date,'now',()=>clock);t.mock.method(console,'error',()=>{});
 h.env={...h.env,WORKERS_AI_ENABLED:'false',OPENAI_FALLBACK_ENABLED:'true',OPENAI_API_KEY:'synthetic-key',OPENAI_MODEL:'gpt-4.1-mini',VISION_TIMEOUT_MS:'1000',R2_EVIDENCE_ENABLED:'true',EVIDENCE:{async put(){uploads++;clock+=500;}}};
 const prepare=h.DB.prepare.bind(h.DB);h.DB.prepare=sql=>{const s=prepare(sql);if(failMetrics&&sql.startsWith('INSERT INTO metrics'))s.run=async()=>{throw new Error('synthetic telemetry unavailable');};return s;};
 const document=receipt({documentType:'ONLINE_ORDER',orderId:'SYNTHETIC_OPERATION_ORDER',paymentStatus:'PAID',paymentDate:'2026-10-25',paymentDateFormat:'YMD',paymentDatePurpose:'PAYMENT',paymentDateLabel:'เวลาที่ชำระเงิน',orderTotalBaht:519,orderTotalLabel:'รวมคำสั่งซื้อ',finalPaidAmountBaht:519,paymentMethod:'บัตรเครดิต/บัตรเดบิต',sourceWalletCandidate:''});
 t.mock.method(globalThis,'fetch',async(url)=>{
  if(String(url).includes('/content')){clock+=2000;return new Response(new Uint8Array([255,216,255,217]));}
  if(String(url)==='https://api.openai.com/v1/responses'){aiCalls++;clock+=9000;return Response.json({output_text:JSON.stringify({kind:'ONLINE_ORDER',document})});}
  if(String(url).endsWith('/reply')){clock+=300;return new Response('',{status:failReply?503:200});}
  throw new Error('Unexpected external request');
 });
 const event=h.event('fixture_owner',{timestamp:start,message:{id:'synthetic_latency_image',type:'image'}});
 const job={kind:'LINE_EVENT',event,receivedAtIso:receivedAt??new Date(start+receivedOffset).toISOString(),traceId:'synthetic_latency'};
 await processInbound(job,h.env,{});
 return{h,job,counts:()=>({aiCalls,uploads}),metric:name=>h.sqlite.prepare('SELECT value_ms,labels_json FROM metrics WHERE name=? ORDER BY id DESC LIMIT 1').get(name)};
}
test('actual image router measures queue, processing and end-to-end independently and deduplicates redelivery',async t=>{
 const r=await imageRun(t);try{
  assert.equal(r.metric('expense_image_queue_wait_ms').value_ms,4000);
  assert.equal(r.metric('expense_image_extraction_ms').value_ms,9000);
  assert.equal(r.metric('expense_image_total_ms').value_ms,11800);
  assert.equal(r.metric('expense_image_end_to_end_ms').value_ms,15800);
  assert.equal(JSON.parse(r.metric('expense_image_queue_wait_ms').labels_json).semantics,'INGRESS_TO_START_V2');
  const metrics=r.h.sqlite.prepare('SELECT COUNT(*) n FROM metrics').get().n;
  await processInbound(r.job,r.h.env,{});assert.deepEqual(r.counts(),{aiCalls:1,uploads:1});
  assert.equal(r.h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,1);assert.equal(r.h.sqlite.prepare('SELECT COUNT(*) n FROM metrics').get().n,metrics);
 }finally{r.h.close();}
});
for(const failReply of [false,true])test(`telemetry outage does not fail capture or replay business work (Reply503=${failReply})`,async t=>{
 const r=await imageRun(t,{failMetrics:true,failReply});try{
  assert.equal(r.h.sqlite.prepare('SELECT status FROM inbound_events').get().status,'COMPLETED');
  assert.equal(r.h.sqlite.prepare('SELECT status FROM expense_events').get().status,'WAITING_CONFIRM');
  assert.equal(r.h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  assert.equal(r.h.queue.filter(j=>(j.body||j).kind==='LINE_NOTIFICATION').length,failReply?1:0);
  await processInbound(r.job,r.h.env,{});assert.deepEqual(r.counts(),{aiCalls:1,uploads:1});
 }finally{r.h.close();}
});
test('invalid ingress timestamps do not emit misleading queue or end-to-end samples',async t=>{
 const r=await imageRun(t,{receivedAt:'not-a-date'});try{assert.equal(r.metric('expense_image_queue_wait_ms'),undefined);assert.equal(r.metric('expense_image_end_to_end_ms'),undefined);assert.equal(r.h.sqlite.prepare('SELECT status FROM inbound_events').get().status,'COMPLETED');}finally{r.h.close();}
});
test('future ingress timestamps are clamped and explicitly marked as clock skew',async t=>{
 const r=await imageRun(t,{receivedOffset:10000});try{assert.equal(r.metric('expense_image_queue_wait_ms').value_ms,0);assert.equal(JSON.parse(r.metric('expense_image_queue_wait_ms').labels_json).clockSkew,'true');}finally{r.h.close();}
});
test('a real persistence failure still fails the inbound event rather than being swallowed as telemetry',async t=>{
 const r=await imageRun(t);try{
  const event=r.h.event('fixture_owner',{timestamp:Date.parse('2026-10-27T05:00:00Z'),message:{id:'synthetic_failed_image',type:'image'}});
  r.h.env.EVIDENCE.put=async()=>{throw new Error('synthetic evidence failure');};
  await assert.rejects(()=>processInbound({...r.job,event,traceId:'synthetic_failed'},r.h.env,{}),/synthetic evidence failure/);
  assert.equal(r.h.sqlite.prepare('SELECT status FROM inbound_events WHERE message_id=?').get('synthetic_failed_image').status,'FAILED');
  assert.equal(r.h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,1);
 }finally{r.h.close();}
});
