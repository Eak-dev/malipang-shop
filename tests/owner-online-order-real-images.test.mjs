import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {handleExpensePostback} from '../dist/expense/service.js';

// Only a deidentified, private live-extraction manifest is accepted. Actual
// images, identities, evidence keys and provider payloads never enter Git.
const manifest=process.env.ONLINE_ORDER_PRIVATE_FIXTURES;
const fixtures=manifest?JSON.parse(readFileSync(manifest,'utf8')).cases:[];
for(const [index,expected] of [62200,46200,51900].entries()){
 test(`approved real image ${index+1}: extraction through final confirmation, repeat and reply recovery`,{skip:!manifest},async()=>{
  const sample=fixtures[index];assert.equal(sample.expectedSatang,expected);assert.equal(sample.imageHashVerified,true);
  const h=ownerOrderFixture();try{
   const {row}=await h.receive(sample.document,{id:'synthetic_real_'+index,attempts:sample.attempts});
   const raw=row.ai_json,original=row.normalized_json;
   if(index===2){
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,0);
    let review=await h.state(row.document_id);const view=h.view(review);
    assert.equal(view.amountSatang,51900);assert.equal(view.sources.amount,'IMAGE');assert.equal(view.sources.date,'MISSING');
    await h.post('order_review_paid',row.document_id,Number(review.review_version),{paid:'yes'});review=await h.state(row.document_id);
    await h.post('order_review_input',row.document_id,Number(review.review_version),{field:'date'});
    await h.text('519 บาท');assert.equal((await h.state(row.document_id)).normalized_json,original);
    await h.text('25/10/69');review=await h.state(row.document_id);
    await h.post('order_review_continue',row.document_id,Number(review.review_version),{},{failReply:true});
    const d=h.sqlite.prepare('SELECT * FROM expense_documents').get();assert.equal(d.payment_time,null);
    const resolved=JSON.parse(d.normalized_json);assert.equal(resolved.ownerPaymentReview.sources.date,'OWNER');
    assert.equal(resolved.imagePaymentEvidence.paymentDate,'');
    assert.equal(h.queue.filter(j=>(j.body||j).kind==='LINE_NOTIFICATION').length,1);
   }
   const expense=h.sqlite.prepare('SELECT * FROM expense_events').get();assert.equal(expense.amount_satang,expected);assert.equal(expense.transaction_date,sample.expectedDate);
   assert.equal(expense.status,'WAITING_CONFIRM');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
   await h.receive(sample.document,{id:'synthetic_real_repeat_'+index,attempts:sample.attempts});
   assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_documents').get().n,1);
   const actor=await h.actor();
   const perform=data=>h.capture(()=>handleExpensePostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`${data}&id=${expense.expense_id}`}}),actor.employee,actor));
   await perform('a=expense_accept_description');await perform('a=expense_set_category&category=equipment');
   assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
   await perform('a=expense_set_payment&payment=kbank&source=CARD_KBANK');
   if(h.sqlite.prepare('SELECT status FROM expense_events').get().status==='WAITING_CONFIRM')await perform('a=expense_confirm');
   assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');
   assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,1);
   await perform('a=expense_confirm');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,1);
   assert.equal(h.sqlite.prepare('SELECT ai_json FROM expense_documents').get().ai_json,raw);
   assert.equal(h.sqlite.prepare('SELECT extraction_attempts_json FROM expense_document_reviews').get().extraction_attempts_json,JSON.stringify(sample.attempts));
   assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{h.close();}
 });
}
