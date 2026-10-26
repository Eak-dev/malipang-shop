import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {parseOwnerAmount,parseOwnerDate,resolveOrderFacts,parseOwnerFacts} from '../dist/expense/online-order-review.js';
import {loadOwnerReview,viewFromReviewRow,promoteOwnerReviewedOrder,saveOwnerOrderFacts,onlineOrderReviewSummary} from '../dist/expense/online-order-review-repository.js';
import {handleExpensePostback} from '../dist/expense/service.js';
import {handleAdmin} from '../dist/admin/handler.js';
import {purchaseExpenseDraft} from '../dist/expense/document.js';
import {buildOnlineOrderReviewFlex,buildOnlineOrderEditFlex} from '../dist/expense/online-order-review-flex.js';
import {readFileSync} from 'node:fs';

const count=(h,table)=>h.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const lastText=h=>JSON.stringify(h.messages.at(-1)?.messages||[]);

test('owner input parses satang and Thai/full Gregorian dates without accepting an amount as a date',()=>{
 for(const [s,n] of [['519',51900],['519.50 บาท',51950],['1,234.56 THB',123456]])assert.equal(parseOwnerAmount(s),n);
 for(const s of ['0','-1','1.001','1,23','519 and 10','Infinity'])assert.equal(parseOwnerAmount(s),null,s);
 for(const s of ['14/02/69','14/02/2569','14/02/2026','2026-02-14'])assert.equal(parseOwnerDate(s),'2026-02-14',s);
 for(const s of ['519 บาท','31/02/2569','14/13/2569','2026-02-30',''])assert.equal(parseOwnerDate(s),'',s);
});

test('known total asks only for paid/date proof and owner completion creates one pending draft with immutable evidence',async()=>{
 const h=ownerOrderFixture();try{
  const {row,reading}=await h.receive(),raw=row.ai_json,items=h.sqlite.prepare('SELECT * FROM expense_document_items').all();
  const initial=lastText(h);assert.match(initial,/519\.00/);assert.match(initial,/order_review_paid/);assert.match(initial,/order_review_date/);assert.doesNotMatch(initial,/field=amount/);
  assert.equal(count(h,'expense_events'),0);
  let review=await h.ready(row.document_id);assert.deepEqual(viewFromReviewRow(review).missing,[]);
  assert.equal(JSON.parse(review.owner_facts_json).date.value,'2026-02-14');
  assert.equal(JSON.parse(review.normalized_json).paymentStatus,'UNKNOWN','owner facts must not overwrite extraction before explicit continuation');
  await h.post('order_review_continue',row.document_id,Number(review.review_version));
  const expense=h.sqlite.prepare('SELECT * FROM expense_events').get(),doc=h.sqlite.prepare('SELECT * FROM expense_documents').get();
  assert.equal(expense.status,'WAITING_CONFIRM');assert.equal(expense.amount_satang,51900);assert.equal(expense.transaction_date,'2026-02-14');
  assert.equal(expense.payment_key,'unconfirmed');assert.equal(expense.source_wallet,'UNCONFIRMED');assert.equal(doc.payment_time,null);
  assert.equal(doc.ai_json,raw);assert.equal(doc.image_key,row.image_key);assert.equal(doc.image_hash,row.image_hash);
  const normalized=JSON.parse(doc.normalized_json);assert.deepEqual(normalized.expenseReview.confirmedFields,['amount','date']);
  assert.equal(normalized.imagePaymentEvidence.paymentStatus,'UNKNOWN');assert.equal(normalized.ownerPaymentReview.source,'OWNER_LINE_REVIEW');
  assert.equal(normalized.ownerPaymentReview.sources.amount,'IMAGE');assert.equal(normalized.ownerPaymentReview.sources.date,'OWNER');
  assert.equal(purchaseExpenseDraft(normalized),null,'manual resolution does not pretend to have a printed payment label');
  const linked=h.sqlite.prepare('SELECT * FROM expense_document_items').all();
  assert.deepEqual(linked.map(({expense_id,updated_at,...r})=>r),items.map(({expense_id,updated_at,...r})=>r));
  assert.equal(linked[0].expense_id,expense.expense_id);assert.equal(count(h,'expense_document_links'),1);
  assert.equal(h.sqlite.prepare('SELECT state FROM expense_online_order_claims').get().state,'EXPENSE_OWNED');
  assert.equal(count(h,'sync_jobs'),0);assert.equal(h.queue.length,0);
  const message=lastText(h);for(const action of ['expense_payment_menu','expense_item_menu','expense_category_menu'])assert.match(message,new RegExp(action));
  assert.doesNotMatch(message,/a=expense_confirm/);
  const audits=count(h,'expense_audit_log');
  await h.post('order_review_continue',row.document_id,Number(review.review_version));
  assert.equal(count(h,'expense_events'),1);assert.equal(count(h,'expense_audit_log'),audits);assert.equal(count(h,'sync_jobs'),0);
  assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{h.close();}
});

test('existing detail/category/card workflow finalizes the owner-reviewed order exactly once and only then queues Sheets',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive(),review=await h.ready(row.document_id);await h.post('order_review_continue',row.document_id,Number(review.review_version));
  const expense=h.sqlite.prepare('SELECT * FROM expense_events').get(),actor=await h.actor();
  const perform=data=>h.capture(()=>handleExpensePostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`${data}&id=${expense.expense_id}`}}),actor.employee,actor));
  await perform('a=expense_confirm');assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'WAITING_CONFIRM');
  await perform('a=expense_accept_description');assert.equal(count(h,'sync_jobs'),0);
  await perform('a=expense_set_category&category=equipment');assert.equal(count(h,'sync_jobs'),0);
  await perform('a=expense_set_payment&payment=kbank&source=CARD_KBANK');
  assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');assert.equal(count(h,'sync_jobs'),1);
  const audits=count(h,'expense_audit_log');await perform('a=expense_set_payment&payment=kbank&source=CARD_KBANK');
  assert.equal(count(h,'expense_events'),1);assert.equal(count(h,'expense_audit_log'),audits);assert.equal(count(h,'sync_jobs'),1);
 }finally{h.close();}
});

test('amount typed into the requested date field is explained without changing facts or creating a new expense',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive();let review=await h.state(row.document_id);
  await h.post('order_review_input',row.document_id,Number(review.review_version),{field:'date'});
  assert.equal(await h.text('519 บาท'),true);assert.match(lastText(h),/ช่องนี้รับวันที่/);assert.match(lastText(h),/ไม่ต้องยืนยันยอดซ้ำ/);
  review=await h.state(row.document_id);assert.deepEqual(JSON.parse(review.owner_facts_json),{});assert.equal(count(h,'expense_events'),0);
  await h.text('14/02/69');review=await h.state(row.document_id);
  assert.equal(JSON.parse(review.owner_facts_json).date.value,'2026-02-14');assert.match(lastText(h),/14\/02\/2569/);
  assert.equal(count(h,'expense_document_review_inputs'),0);
 }finally{h.close();}
});

test('missing/conflicting amount uses targeted owner input and retains image amount separately',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive({orderTotalBaht:null,orderTotalLabel:''});let review=await h.state(row.document_id);
  assert.match(lastText(h),/field=amount/);await h.post('order_review_input',row.document_id,Number(review.review_version),{field:'amount'});
  await h.text('1,234.50 บาท');review=await h.state(row.document_id);
  assert.equal(JSON.parse(review.owner_facts_json).amount.value,123450);assert.equal(JSON.parse(review.normalized_json).orderTotalBaht,null);
  assert.equal(viewFromReviewRow(review).sources.amount,'OWNER');assert.equal(count(h,'expense_events'),0);
 }finally{h.close();}
});

test('expiry, case switching and stale cards never apply input to the wrong case',async()=>{
 const h=ownerOrderFixture();try{
  const one=await h.receive(),two=await h.receive({orderTotalBaht:480});
  await h.post('order_review_input',one.row.document_id,0,{field:'amount'});
  await h.post('order_review_input',two.row.document_id,0,{field:'amount'});await h.text('480');
  assert.deepEqual(JSON.parse((await h.state(one.row.document_id)).owner_facts_json),{});
  assert.equal(JSON.parse((await h.state(two.row.document_id)).owner_facts_json).amount.value,48000);
  await h.post('order_review_paid',two.row.document_id,0,{paid:'yes'});assert.match(lastText(h),/ข้อมูลเปลี่ยนแล้ว/);
  let review=await h.state(one.row.document_id);await h.post('order_review_input',one.row.document_id,Number(review.review_version),{field:'date'});
  h.sqlite.prepare("UPDATE expense_document_review_inputs SET expires_at='2000-01-01T00:00:00.000Z'").run();await h.text('14/02/2569');
  assert.match(lastText(h),/หมดอายุ/);assert.deepEqual(JSON.parse((await h.state(one.row.document_id)).owner_facts_json),{});
  assert.equal(count(h,'expense_events'),0);
 }finally{h.close();}
});

test('a paid-looking repeat resumes the held case and failed replies queue only notification',async()=>{
 const h=ownerOrderFixture();try{
  const first=await h.receive(),before=h.sqlite.prepare('SELECT ai_json,normalized_json FROM expense_documents').get(),audit=count(h,'expense_audit_log');
  await h.receive({orderId:first.document.orderId,paymentStatus:'PAID',paymentDate:'2026-02-14',paymentTime:'10:12',paymentDatePurpose:'PAYMENT',paymentDateLabel:'เวลาที่ชำระเงิน',finalPaidAmountBaht:519},{failReply:true});
  assert.equal(count(h,'expense_documents'),1);assert.equal(count(h,'expense_events'),0);assert.equal(count(h,'expense_audit_log'),audit);
  assert.deepEqual(h.sqlite.prepare('SELECT ai_json,normalized_json FROM expense_documents').get(),before);
  assert.equal(h.queue.length,1);assert.equal(h.queue[0].kind,'LINE_NOTIFICATION');assert.equal(count(h,'sync_jobs'),0);
 }finally{h.close();}
});

test('only a currently verified organization OWNER can inspect or change cases, even with a forged menu',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive(),before=count(h,'expense_audit_log');
  for(const line of ['fixture_staff','fixture_manager','unknown_user']){
   await h.post('order_review_paid',row.document_id,0,{paid:'yes'},{line});
   assert.doesNotMatch(lastText(h),/519|Synthetic kitchen/);assert.equal(count(h,'expense_audit_log'),before);
  }
  await h.text('รายการค้าง',{line:'fixture_staff',actor:{role:'OWNER'}});assert.doesNotMatch(lastText(h),/519|Synthetic kitchen/);
  for(const mutation of ["UPDATE staff_roles SET status='INACTIVE' WHERE employee_id='TEST_OWNER'","UPDATE employees SET can_submit_expense=0 WHERE employee_id='TEST_OWNER'","UPDATE line_identity_bindings SET status='REVOKED' WHERE employee_id='TEST_OWNER'"]){
   h.sqlite.exec(mutation);await h.post('order_review_paid',row.document_id,0,{paid:'yes'});assert.doesNotMatch(lastText(h),/519|Synthetic kitchen/);
  }
  assert.equal(count(h,'expense_events'),0);assert.deepEqual(JSON.parse((h.sqlite.prepare('SELECT owner_facts_json FROM expense_document_reviews').get()).owner_facts_json),{});
 }finally{h.close();}
});

test('owner reviews a staff submission in the owner confirmation flow while retaining original submitter provenance',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive({}, {line:'fixture_staff'});assert.doesNotMatch(lastText(h),/order_review_paid/);
  await h.post('order_review_open',row.document_id);let review=await h.ready(row.document_id);
  await h.post('order_review_continue',row.document_id,Number(review.review_version));
  const expense=h.sqlite.prepare('SELECT * FROM expense_events').get();assert.equal(expense.line_user_id,'fixture_owner');assert.equal(expense.submitted_by_employee_id,'TEST_STAFF');
  assert.equal(h.sqlite.prepare('SELECT line_user_id FROM expense_documents').get().line_user_id,'fixture_staff');
  assert.match(lastText(h),/expense_payment_menu/);assert.equal(count(h,'sync_jobs'),0);
  const actor=await h.actor(),perform=data=>h.capture(()=>handleExpensePostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`${data}&id=${expense.expense_id}`}}),actor.employee,actor));
  await perform('a=expense_accept_description');await perform('a=expense_set_category&category=equipment');
  assert.equal(count(h,'sync_jobs'),0);await perform('a=expense_set_payment&payment=kbank&source=CARD_KBANK');
  assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');assert.equal(count(h,'sync_jobs'),1);
  assert.equal(h.sqlite.prepare('SELECT line_user_id FROM expense_documents').get().line_user_id,'fixture_staff');
  assert.equal(h.sqlite.prepare('SELECT submitted_by_employee_id FROM expense_events').get().submitted_by_employee_id,'TEST_STAFF');
  await perform('a=expense_confirm');assert.equal(count(h,'sync_jobs'),1);assert.equal(count(h,'expense_events'),1);
 }finally{h.close();}
});

test('another owner submission can finish under the reviewing owner without rewriting either original identity',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive({}, {line:'fixture_owner_two'}),original=row.ai_json;
  const review=await h.ready(row.document_id);await h.post('order_review_continue',row.document_id,Number(review.review_version));
  const expense=h.sqlite.prepare('SELECT * FROM expense_events').get(),actor=await h.actor();
  const perform=data=>h.capture(()=>handleExpensePostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`${data}&id=${expense.expense_id}`}}),actor.employee,actor));
  await perform('a=expense_accept_description');await perform('a=expense_set_category&category=equipment');await perform('a=expense_set_payment&payment=kbank&source=CARD_KBANK');
  const saved=h.sqlite.prepare('SELECT * FROM expense_events').get(),doc=h.sqlite.prepare('SELECT * FROM expense_documents').get();
  assert.equal(saved.status,'CONFIRMED');assert.equal(saved.reviewed_by_employee_id,'TEST_OWNER');assert.equal(saved.submitted_by_employee_id,'TEST_OWNER_TWO');
  assert.equal(doc.line_user_id,'fixture_owner_two');assert.equal(doc.ai_json,original);assert.equal(count(h,'sync_jobs'),1);
  await perform('a=expense_confirm');assert.equal(count(h,'sync_jobs'),1);
 }finally{h.close();}
});

test('cross-submitter finalization requires current owner rights and intact approval, claim, link and review provenance',async()=>{
 for(const mutation of [
  "DELETE FROM expense_document_reviews",
  "DELETE FROM expense_audit_log WHERE action='REVIEW_APPROVE'",
  "DELETE FROM expense_document_links",
  "UPDATE expense_online_order_claims SET state='REVIEW_ONLY',expense_id=NULL",
  "UPDATE expense_document_reviews SET updated_by_employee_id='TEST_OWNER_TWO'",
  "UPDATE expense_documents SET normalized_json=json_remove(normalized_json,'$.ownerPaymentReview')",
  "UPDATE expense_documents SET message_id='synthetic_changed_message'",
  "UPDATE staff_roles SET status='INACTIVE' WHERE employee_id='TEST_OWNER'",
  "UPDATE line_identity_bindings SET status='REVOKED' WHERE employee_id='TEST_OWNER'"
 ]){
  const h=ownerOrderFixture();try{
   const {row}=await h.receive({}, {line:'fixture_staff'}),review=await h.ready(row.document_id);
   await h.post('order_review_continue',row.document_id,Number(review.review_version));
   const expense=h.sqlite.prepare('SELECT * FROM expense_events').get(),actor=await h.actor();
   const perform=data=>h.capture(()=>handleExpensePostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`${data}&id=${expense.expense_id}`}}),actor.employee,actor));
   await perform('a=expense_accept_description');await perform('a=expense_set_category&category=equipment');h.sqlite.exec(mutation);
   await perform('a=expense_set_payment&payment=kbank&source=CARD_KBANK');await perform('a=expense_confirm');
   assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'WAITING_CONFIRM',mutation);
   assert.equal(count(h,'sync_jobs'),0,mutation);assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='CONFIRM'").get().n,0,mutation);
  }finally{h.close();}
 }
});

test('revocation between read and transaction blocks all fact and draft writes',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive(),review=await h.ready(row.document_id),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};
  const before=count(h,'expense_audit_log');h.sqlite.exec("UPDATE staff_roles SET status='INACTIVE' WHERE employee_id='TEST_OWNER'");
  const facts=parseOwnerFacts(review.owner_facts_json);facts.amount={value:60000,source:'OWNER',actorEmployeeId:'TEST_OWNER',confirmedAt:new Date().toISOString()};
  assert.equal(await saveOwnerOrderFacts(h.env,review,owner,facts),false);await promoteOwnerReviewedOrder(h.env,review,owner);
  assert.equal(count(h,'expense_events'),0);assert.equal(count(h,'expense_audit_log'),before);
 }finally{h.close();}
});

test('every injected promotion failure rolls back all new audits, links, claims and pending expenses',async()=>{
 for(let failAt=0;failAt<10;failAt++){
  const h=ownerOrderFixture();try{
   const {row}=await h.receive(),review=await h.ready(row.document_id),before=count(h,'expense_audit_log');h.DB.failAt=failAt;
   await assert.rejects(promoteOwnerReviewedOrder(h.env,review,{employeeId:'TEST_OWNER',lineUserId:'fixture_owner'}),/fixture batch failure/);
   assert.equal(count(h,'expense_events'),0);assert.equal(count(h,'expense_document_links'),0);assert.equal(count(h,'expense_audit_log'),before);
   assert.equal(h.sqlite.prepare('SELECT state FROM expense_online_order_claims').get().state,'REVIEW_ONLY');assert.equal(h.sqlite.prepare('SELECT status FROM expense_documents').get().status,'WAITING_REVIEW');
   assert.equal(count(h,'sync_jobs'),0);assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{h.close();}
 }
});

test('concurrent continuation and a crash after commit produce one pending purchase and no Sheets replay',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive(),review=await h.ready(row.document_id),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};
  await Promise.all([promoteOwnerReviewedOrder(h.env,review,owner),promoteOwnerReviewedOrder(h.env,review,owner)]);
  assert.equal(count(h,'expense_events'),1);assert.equal(count(h,'expense_document_links'),1);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='REVIEW_APPROVE'").get().n,1);assert.equal(count(h,'sync_jobs'),0);
 }finally{h.close();}
 const h2=ownerOrderFixture();try{
  const {row}=await h2.receive(),review=await h2.ready(row.document_id);h2.DB.failAfterCommit=true;
  await assert.rejects(promoteOwnerReviewedOrder(h2.env,review,{employeeId:'TEST_OWNER',lineUserId:'fixture_owner'}),/fixture crash after commit/);h2.DB.failAfterCommit=false;
  await h2.post('order_review_continue',row.document_id,Number(review.review_version));assert.equal(count(h2,'expense_events'),1);assert.match(lastText(h2),/expense_payment_menu/);assert.equal(count(h2,'sync_jobs'),0);
 }finally{h2.close();}
});

test('incomplete identity, multiple sellers and already-owned orders stay read-only',async()=>{
 for(const change of [
  {orderId:''},
  {items:[{sellerKey:'Synthetic A',description:'Synthetic A',quantity:1,unit:'piece',unitPriceBaht:250,lineTotalBaht:250},{sellerKey:'Synthetic B',description:'Synthetic B',quantity:1,unit:'piece',unitPriceBaht:269,lineTotalBaht:269}]}
 ]){
  const h=ownerOrderFixture();try{const {row}=await h.receive(change);await h.post('order_review_paid',row.document_id,0,{paid:'yes'});assert.equal(count(h,'expense_events'),0);assert.doesNotMatch(lastText(h),/order_review_continue|field=amount/);}finally{h.close();}
 }
});

test('aggregate monitoring has reason/age counts and requires admin auth without exposing evidence or identities',async()=>{
 const h=ownerOrderFixture();try{
  await h.receive();await h.receive({orderId:''});const summary=await onlineOrderReviewSummary(h.env);
  assert.equal(summary.total,2);assert.equal(summary.actionable,1);assert.equal(summary.blocked,1);assert.equal(summary.reasons.PAYMENT_DATE_MISSING,2);assert.equal(summary.reasons.ORDER_ID_MISSING,1);
  const env={...h.env,ADMIN_TOKEN:'synthetic-admin-token-with-at-least-32-characters'};
  const denied=await handleAdmin(new Request('https://synthetic.test/admin/expenses/review-summary'),env,{});assert.equal(denied.status,401);
  const allowed=await handleAdmin(new Request('https://synthetic.test/admin/expenses/review-summary',{headers:{authorization:`Bearer ${env.ADMIN_TOKEN}`}}),env,{});assert.equal(allowed.status,200);
  const body=JSON.stringify(await allowed.json());assert.doesNotMatch(body,/fixture_owner|SYNTHETIC_ORDER|Synthetic kitchen|synthetic-private-image|doc_/);
  await h.text('รายการค้าง');assert.match(lastText(h),/เติมข้อมูลได้/);assert.match(lastText(h),/ต้องตรวจแยก/);
 }finally{h.close();}
});

test('Flex actions fit LINE label/data constraints for missing facts, ready and edit menus',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive({orderTotalBaht:null,orderTotalLabel:''}),view=viewFromReviewRow(await h.state(row.document_id));
  const messages=[buildOnlineOrderReviewFlex(view),buildOnlineOrderEditFlex(view),buildOnlineOrderReviewFlex({...view,missing:[],amountSatang:51900,paymentDate:'2026-02-14',paymentStatus:'PAID'})];
  const walk=value=>{
   if(!value||typeof value!=='object')return;
   if(value.action){assert.ok(value.action.label.length<=20,`Long LINE label: ${value.action.label}`);if(value.action.data)assert.ok(value.action.data.length<=300);}
   for(const child of Object.values(value)){if(Array.isArray(child))child.forEach(walk);else if(child&&typeof child==='object')walk(child);}
  };
  messages.forEach(walk);
 }finally{h.close();}
});

test('each inactive, disabled, revoked-binding or branch-scoped owner is independently denied',async()=>{
 for(const mutation of [
  "UPDATE employees SET status='INACTIVE' WHERE employee_id='TEST_OWNER'",
  "UPDATE employees SET can_submit_expense=0 WHERE employee_id='TEST_OWNER'",
  "UPDATE line_identity_bindings SET status='REVOKED' WHERE employee_id='TEST_OWNER'",
  "UPDATE staff_roles SET status='INACTIVE' WHERE employee_id='TEST_OWNER'",
  "UPDATE staff_roles SET role='EMPLOYEE',scope='BRANCH',branch_id='B001' WHERE employee_id='TEST_OWNER'"
 ]){
  const h=ownerOrderFixture();try{
   const {row}=await h.receive(),before=count(h,'expense_audit_log');h.sqlite.exec(mutation);
   await h.post('order_review_paid',row.document_id,0,{paid:'yes'});assert.doesNotMatch(lastText(h),/519|Synthetic kitchen/);
   assert.equal(count(h,'expense_audit_log'),before);assert.equal(count(h,'expense_events'),0);
  }finally{h.close();}
 }
});

test('unpaid status and incomplete facts cannot be continued by a forged ready action',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive();await h.post('order_review_continue',row.document_id,0);assert.equal(count(h,'expense_events'),0);
  await h.post('order_review_paid',row.document_id,0,{paid:'no'});let review=await h.state(row.document_id);
  await h.post('order_review_date',row.document_id,Number(review.review_version),{},{date:'2026-02-14'});review=await h.state(row.document_id);
  await h.post('order_review_continue',row.document_id,Number(review.review_version));assert.equal(count(h,'expense_events'),0);assert.equal(count(h,'sync_jobs'),0);
  assert.equal(viewFromReviewRow(await h.state(row.document_id)).paymentStatus,'UNPAID');
 }finally{h.close();}
});

test('conflicting and unsupported labels require an explicit amount instead of reusing subtotal',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive({paymentStatus:'PAID',paymentDate:'2026-02-14',paymentDatePurpose:'PAYMENT',paymentDateLabel:'เวลาที่ชำระเงิน',finalPaidAmountBaht:480});
  const view=viewFromReviewRow(await h.state(row.document_id));assert.ok(view.reasons.includes('AMOUNT_CONFLICT'));assert.equal(view.amountSatang,null);assert.match(lastText(h),/field=amount/);
  const original=JSON.parse(row.normalized_json);assert.equal(original.orderTotalBaht,519);assert.equal(original.finalPaidAmountBaht,null);
  assert.equal(resolveOrderFacts({...original,orderTotalLabel:'subtotal',reviewReasons:[]}).amountSatang,null);
 }finally{h.close();}
});

test('changed raw evidence, item facts or seller cases make a prepared promotion a no-op',async()=>{
 for(const mutation of ["UPDATE expense_documents SET ai_json='{}'","UPDATE expense_documents SET image_hash='changed'","UPDATE expense_documents SET message_id='synthetic_changed_message'","UPDATE expense_documents SET line_user_id='fixture_staff'","UPDATE expense_documents SET submitted_by_employee_id='TEST_STAFF'","UPDATE expense_document_items SET quantity=7","UPDATE expense_document_items SET description='changed'","UPDATE expense_document_cases SET gross_satang=99900"]){
  const h=ownerOrderFixture();try{
   const {row}=await h.receive(),review=await h.ready(row.document_id),before=count(h,'expense_audit_log');
   // The item/case snapshots are acquired inside promotion. Change the row
   // after that read but before the batch to exercise the transactional guard.
   const originalBatch=h.DB.batch.bind(h.DB);h.DB.batch=async statements=>{h.sqlite.exec(mutation);return originalBatch(statements);};
   await promoteOwnerReviewedOrder(h.env,review,{employeeId:'TEST_OWNER',lineUserId:'fixture_owner'});
   assert.equal(count(h,'expense_events'),0);assert.equal(count(h,'expense_audit_log'),before);assert.equal(count(h,'sync_jobs'),0);
  }finally{h.close();}
 }
});

test('the additive migration is retry-safe and leaves pre-existing evidence and business rows intact',async()=>{
 const h=ownerOrderFixture();try{
  await h.receive();const before=h.sqlite.prepare('SELECT ai_json,normalized_json,image_hash FROM expense_documents').all();
  const migration=readFileSync(new URL('../migrations/0020_owner_online_order_review.sql',import.meta.url),'utf8');h.sqlite.exec(migration);h.sqlite.exec(migration);
  assert.deepEqual(h.sqlite.prepare('SELECT ai_json,normalized_json,image_hash FROM expense_documents').all(),before);
  assert.equal(count(h,'expense_document_reviews'),1);assert.equal(count(h,'expense_events'),0);assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
 }finally{h.close();}
});

test('possible duplicates appear in the queue and monitoring and clear only when the conflicting expense is cancelled',async()=>{
 const h=ownerOrderFixture();try{
  const {row}=await h.receive();await h.ready(row.document_id);
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,submitted_by_employee_id)
   VALUES('synthetic_duplicate','synthetic_duplicate_message','fixture_owner','Synthetic duplicate',51900,'unconfirmed','UNCONFIRMED','general','2026-02-14','WAITING_CONFIRM','2026-02-14T00:00:00.000Z','TEST_OWNER')`).run();
  let review=await h.state(row.document_id);assert.ok(viewFromReviewRow(review).blocked.includes('POSSIBLE_DUPLICATE'));
  const summary=await onlineOrderReviewSummary(h.env);assert.equal(summary.reasons.POSSIBLE_DUPLICATE,1);assert.equal(summary.blocked,1);
  await h.post('order_review_continue',row.document_id,Number(review.review_version));assert.equal(count(h,'expense_events'),1);
  h.sqlite.prepare("UPDATE expense_events SET status='CANCELLED' WHERE expense_id='synthetic_duplicate'").run();
  review=await h.state(row.document_id);assert.deepEqual(viewFromReviewRow(review).blocked,[]);
 }finally{h.close();}
});

test('switching between owner payment input and normal draft edits clears the previous input target',async()=>{
 const h=ownerOrderFixture();try{
  const held=await h.receive();await h.receive({paymentStatus:'PAID',paymentDate:'2026-02-14',paymentDatePurpose:'PAYMENT',paymentDateLabel:'เวลาที่ชำระเงิน',finalPaidAmountBaht:519,orderTotalBaht:519,needsReview:true,reviewReasons:['Confirm item description and category']});
  const expense=h.sqlite.prepare('SELECT * FROM expense_events').get(),actor=await h.actor();
  await h.post('order_review_input',held.row.document_id,0,{field:'date'});
  await h.capture(()=>handleExpensePostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`a=expense_edit_description&id=${expense.expense_id}`}}),actor.employee,actor));
  assert.equal(count(h,'expense_document_review_inputs'),0);assert.equal(count(h,'expense_pending_edits'),1);
  await h.post('order_review_input',held.row.document_id,0,{field:'date'});
  assert.equal(count(h,'expense_pending_edits'),0);assert.equal(count(h,'expense_document_review_inputs'),1);
  const other=await h.receive({orderTotalBaht:480});
  assert.equal(count(h,'expense_document_review_inputs'),0);
  assert.equal(h.sqlite.prepare('SELECT normalized_json FROM expense_documents WHERE document_id=?').get(held.row.document_id).normalized_json,held.row.normalized_json);
 }finally{h.close();}
});
