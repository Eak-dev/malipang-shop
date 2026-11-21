import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOnlineOrderRecoveryPlan} from '../scripts/online-order-recovery-plan.mjs';
import {handleExpenseImage} from '../dist/expense/service.js';
import {expenseSqlite,receipt,imageEvent,receiptReading} from './helpers/expense-sqlite.mjs';

const now='2026-01-10T10:00:00.000Z';
async function fixture(overrides={}){
  const h=expenseSqlite();
  h.sqlite.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,status,updated_at) VALUES('TEST_OWNER','Synthetic owner','synthetic_owner','08:00','17:00','ACTIVE',?)`).run(now);
  h.sqlite.prepare(`INSERT INTO staff_roles(role_assignment_id,employee_id,role,scope,status,effective_from,assigned_by,created_at,updated_at) VALUES('test_role','TEST_OWNER','OWNER','ORGANIZATION','ACTIVE',?,'fixture',?,?)`).run(now,now,now);
  const document=receipt({documentType:'ONLINE_ORDER',orderId:'SYNTHETIC-ORDER',documentNumber:'',
    paymentDateFormat:'YMD',paymentDatePurpose:'PAYMENT',paymentStatus:'PAID',orderTotalBaht:null,orderTotalLabel:'',
    finalPaidAmountBaht:null,paymentMethod:'บัตรเครดิต/บัตรเดบิต',sourceWalletCandidate:'',...overrides});
  await handleExpenseImage(h.env,imageEvent('synthetic_message','synthetic_owner'),receiptReading(document),'private-fixture.jpg','synthetic_trace','synthetic_hash',{employeeId:'TEST_OWNER'});
  const row=h.sqlite.prepare('SELECT document_id,document_type,status,expense_id,order_id,payment_date,currency,normalized_json,updated_at,final_paid_satang,paid_amount_satang FROM expense_documents').get();
  const manifest={document:{...row},approval:{ownerEmployeeId:'TEST_OWNER',finalPaidSatang:46200,orderTotalLabel:'รวมคำสั่งซื้อ',reason:'Owner verified the original paid order total',evidenceReviewed:true}};
  const plan=(suffix='one')=>buildOnlineOrderRecoveryPlan(manifest,{now,expenseId:`recovered_${suffix}`,approvalId:`approval_${suffix}`,draftAuditId:`draft_audit_${suffix}`,linkId:`link_${suffix}`,traceId:`trace_${suffix}`});
  const apply=plan=>h.DB.batch(plan.batch.map(s=>h.DB.prepare(s.sql).bind(...s.params)));
  return{...h,manifest,plan,apply};
}

test('owner-reviewed recovery preserves evidence and creates one unconfirmed draft with retained items and claims',async()=>{
  const h=await fixture();
  try{
    const original=h.sqlite.prepare('SELECT ai_json,image_key FROM expense_documents').get();
    const itemIds=h.sqlite.prepare('SELECT item_id FROM expense_document_items').all();
    const plan=h.plan(),result=await h.apply(plan);
    assert.equal(result.at(-1).results.length,1);
    const e=h.sqlite.prepare('SELECT * FROM expense_events').get();
    assert.equal(e.amount_satang,46200);assert.equal(e.status,'WAITING_CONFIRM');
    assert.equal(e.payment_key,'unconfirmed');assert.equal(e.source_wallet,'UNCONFIRMED');
    const d=h.sqlite.prepare('SELECT * FROM expense_documents').get();
    assert.equal(d.ai_json,original.ai_json);assert.equal(d.image_key,original.image_key);
    assert.equal(d.final_paid_satang,46200);assert.equal(d.paid_amount_satang,46200);
    const normalized=JSON.parse(d.normalized_json);
    assert.deepEqual(normalized.expenseReview.confirmedFields,['amount']);
    for(const field of ['payment','description','category'])assert.ok(plan.summary.unresolved_fields.includes(field));
    assert.deepEqual(h.sqlite.prepare('SELECT item_id FROM expense_document_items').all(),itemIds);
    assert.equal(h.sqlite.prepare('SELECT expense_id FROM expense_document_items').get().expense_id,e.expense_id);
    assert.equal(h.sqlite.prepare('SELECT final_paid_satang FROM expense_document_cases').get().final_paid_satang,46200);
    assert.equal(h.sqlite.prepare('SELECT state FROM expense_online_order_claims').get().state,'EXPENSE_OWNED');
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_order_document_type_claims').get().n,1);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_document_links').get().n,1);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action IN ('REVIEW_APPROVE','CREATE_DRAFT')").get().n,2);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    assert.equal(h.queue.length,0);
    assert.deepEqual(h.sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{h.close();}
});

test('replaying the same plan or a competing prepared plan cannot duplicate a purchase or its audit',async()=>{
  const h=await fixture();
  try{
    const winner=h.plan(),competitor=h.plan('two');
    await h.apply(winner);await h.apply(winner);await h.apply(competitor);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,1);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_document_links').get().n,1);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='REVIEW_APPROVE'").get().n,1);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='CREATE_DRAFT'").get().n,1);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close();}
});

test('stale snapshots, changed claims and revoked owners make every mutation a no-op',async()=>{
  for(const mutation of [
    "UPDATE expense_documents SET updated_at='later'",
    "UPDATE expense_documents SET normalized_json='{}'",
    "UPDATE expense_documents SET currency='USD'",
    "UPDATE expense_online_order_claims SET state='AMBIGUOUS',document_id=NULL",
    "DELETE FROM expense_order_document_type_claims",
    "UPDATE staff_roles SET status='INACTIVE'",
    "UPDATE employees SET status='INACTIVE'",
    "UPDATE expense_document_cases SET status='CANCELLED'"
  ]){
    const h=await fixture();
    try{
      const plan=h.plan();h.sqlite.exec(mutation);
      const before=h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n;
      const result=await h.apply(plan);
      assert.equal(result.at(-1).results.length,0,mutation);
      assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,0,mutation);
      assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_document_links').get().n,0,mutation);
      assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,before,mutation);
    }finally{h.close();}
  }
});

test('a crash after the recovery commit can be retried without repeating any business side effect',async()=>{
  const h=await fixture();
  try{
    const plan=h.plan();h.DB.failAfterCommit=true;
    await assert.rejects(h.apply(plan),/fixture crash after commit/);
    h.DB.failAfterCommit=false;
    await h.apply(plan);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,1);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_document_links').get().n,1);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action IN ('REVIEW_APPROVE','CREATE_DRAFT')").get().n,2);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close();}
});

test('every failed statement rolls back the approval, draft and dependent changes',async()=>{
  for(let failAt=0;failAt<9;failAt++){
    const h=await fixture();
    try{
      const plan=h.plan();h.DB.failAt=failAt;
      await assert.rejects(h.apply(plan),/fixture batch failure/);
      assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,0);
      assert.equal(h.sqlite.prepare('SELECT status FROM expense_documents').get().status,'WAITING_REVIEW');
      assert.equal(h.sqlite.prepare('SELECT expense_id FROM expense_document_items').get().expense_id,null);
      assert.equal(h.sqlite.prepare('SELECT state FROM expense_online_order_claims').get().state,'REVIEW_ONLY');
      assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_document_links').get().n,0);
      assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='REVIEW_APPROVE'").get().n,0);
    }finally{h.close();}
  }
});

test('invalid or incomplete owner approvals and conflicting visible totals cannot produce a plan',async()=>{
  const h=await fixture();
  try{
    for(const overrides of [{finalPaidSatang:0},{finalPaidSatang:462.5},{evidenceReviewed:false},{ownerEmployeeId:''},{reason:''},{orderTotalLabel:'item subtotal'}]){
      assert.throws(()=>buildOnlineOrderRecoveryPlan({...h.manifest,approval:{...h.manifest.approval,...overrides}}));
    }
    for(const change of [{paymentStatus:'UNPAID'},{paymentDate:''},{orderId:'OTHER'},{orderTotalBaht:504},{currency:'USD'},{items:[]},{finalPaidAmountBaht:462}]){
      const retained=JSON.parse(h.manifest.document.normalized_json);
      const manifest={...h.manifest,document:{...h.manifest.document,normalized_json:JSON.stringify({...retained,...change})}};
      assert.throws(()=>buildOnlineOrderRecoveryPlan(manifest),JSON.stringify(change));
    }
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,0);
  }finally{h.close();}
});

test('recovered order resumes LINE review and a failed reply queues only notification',async()=>{
  const h=await fixture(),originalFetch=globalThis.fetch;
  try{
    await h.apply(h.plan());
    const before=h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n;
    globalThis.fetch=async()=>new Response('synthetic unavailable',{status:503});
    const event={...imageEvent('resend_message','synthetic_owner'),replyToken:'synthetic_reply',webhookEventId:'synthetic_resend'};
    const env={...h.env,RUNTIME_MODE:'production',LINE_CHANNEL_ACCESS_TOKEN:'synthetic_token',EXTERNAL_API_TIMEOUT_MS:'1000',JOB_QUEUE:{async send(job){h.queue.push(job);}}};
    const document=JSON.parse(h.manifest.document.normalized_json);
    await handleExpenseImage(env,event,receiptReading(document),'resend.jpg','resend_trace','resend_hash',{employeeId:'TEST_OWNER'});
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_events').get().n,1);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,before);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    assert.equal(h.queue.length,1);assert.equal(h.queue[0].kind,'LINE_NOTIFICATION');
    const message=JSON.stringify(h.queue[0].messages);
    assert.match(message,/expense_payment_menu/);
    assert.match(message,/expense_item_menu/);
    assert.match(message,/expense_category_menu/);
    assert.doesNotMatch(message,/a=expense_confirm/);
  }finally{globalThis.fetch=originalFetch;h.close();}
});
