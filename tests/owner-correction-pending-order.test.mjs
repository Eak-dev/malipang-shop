import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {commitPendingOwnerCorrection,createOwnerCorrectionDraft,loadOwnerExpense} from '../dist/expense/owner-correction-repository.js';
import {handleExpensePostback} from '../dist/expense/service.js';

async function setup(){
  const h=ownerOrderFixture(),{row}=await h.receive({}, {line:'fixture_staff'}),review=await h.ready(row.document_id);
  await h.post('order_review_continue',row.document_id,Number(review.review_version));
  h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';
  const expense=h.sqlite.prepare('SELECT * FROM expense_events').get();return {...h,expenseId:expense.expense_id,documentId:row.document_id};
}
const owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};
const ownerTwo={employeeId:'TEST_OWNER_TWO',lineUserId:'fixture_owner_two'};
async function edit(h,actor,field,value){const before=await loadOwnerExpense(h.env,actor,h.expenseId),id=await createOwnerCorrectionDraft(h.env,actor,before,field,value);assert.ok(id);return {id,before,result:await commitPendingOwnerCorrection(h.env,actor,id,before.version)};}

test('owner can re-attest amount and date on a reviewed order, retain original evidence and finish ordinary review',async()=>{
  const h=await setup();try{
    const original=h.sqlite.prepare('SELECT ai_json,image_key,image_hash,normalized_json FROM expense_documents').get(),image=JSON.parse(original.normalized_json).imagePaymentEvidence;
    const first=await edit(h,owner,'amountSatang','525.50');assert.equal(first.result,'APPLIED');
    const second=await edit(h,owner,'transactionDate','2026-02-15');assert.equal(second.result,'APPLIED');
    const doc=h.sqlite.prepare('SELECT * FROM expense_documents').get(),parsed=JSON.parse(doc.normalized_json),expense=h.sqlite.prepare('SELECT * FROM expense_events').get();
    assert.equal(expense.status,'WAITING_CONFIRM');assert.equal(expense.amount_satang,52550);assert.equal(expense.transaction_date,'2026-02-15');
    assert.equal(doc.ai_json,original.ai_json);assert.equal(doc.image_key,original.image_key);assert.equal(doc.image_hash,original.image_hash);assert.deepEqual(parsed.imagePaymentEvidence,image);
    assert.equal(parsed.ownerPaymentReview.sources.amount,'OWNER');assert.equal(parsed.ownerPaymentReview.sources.date,'OWNER');assert.equal(h.sqlite.prepare('SELECT final_paid_satang FROM expense_document_cases').get().final_paid_satang,52550);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='REVIEW_APPROVE'").get().n,3);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    const actor=await h.actor(),perform=data=>h.capture(()=>handleExpensePostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`${data}&id=${h.expenseId}`}}),actor.employee,actor));
    await perform('a=expense_accept_description');await perform('a=expense_set_category&category=equipment');await perform('a=expense_set_payment&payment=kbank&source=CARD_KBANK');
    assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,1);
  }finally{h.close()}
});

test('a different verified owner can re-attest while retaining the original document link',async()=>{
  const h=await setup();try{
    const originalLink=h.sqlite.prepare('SELECT linked_by_employee_id FROM expense_document_links').get().linked_by_employee_id;
    const changed=await edit(h,ownerTwo,'amountSatang','530');assert.equal(changed.result,'APPLIED');assert.equal(h.sqlite.prepare('SELECT linked_by_employee_id FROM expense_document_links').get().linked_by_employee_id,originalLink);
    const actor=await h.actor(),perform=data=>h.capture(()=>handleExpensePostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`${data}&id=${h.expenseId}`}}),actor.employee,actor));
    await perform('a=expense_accept_description');await perform('a=expense_set_category&category=equipment');await perform('a=expense_set_payment&payment=kbank&source=CARD_KBANK');
    assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,1);
  }finally{h.close()}
});

test('a re-attested pending order remains confirmable after disabling owner corrections',async()=>{
  const h=await setup();try{
    assert.equal((await edit(h,ownerTwo,'amountSatang','530')).result,'APPLIED');h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';
    const actor=await h.actor(),perform=data=>h.capture(()=>handleExpensePostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`${data}&id=${h.expenseId}`}}),actor.employee,actor));
    await perform('a=expense_accept_description');await perform('a=expense_set_category&category=equipment');await perform('a=expense_set_payment&payment=kbank&source=CARD_KBANK');
    assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,1);
  }finally{h.close()}
});

test('broken provenance refuses a re-attestation without changing the order',async()=>{
  for(const mutation of ["DELETE FROM expense_document_links","UPDATE expense_online_order_claims SET state='REVIEW_ONLY',expense_id=NULL","DELETE FROM expense_document_reviews","UPDATE expense_document_cases SET final_paid_satang=1"]){
    const h=await setup();try{h.sqlite.exec(mutation);const count=h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n;
      const changed=await edit(h,owner,'amountSatang','530');assert.equal(changed.result,'REVIEW',mutation);assert.equal(h.sqlite.prepare('SELECT amount_satang FROM expense_events').get().amount_satang,51900);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,count);
    }finally{h.close()}
  }
});

test('final confirmation refuses a re-attestation if its linked correction or original proof is lost',async()=>{
  for(const mutation of ["UPDATE expense_owner_corrections SET status='STALE'","DELETE FROM expense_audit_log WHERE action='EDIT'","DELETE FROM expense_audit_log WHERE action='REVIEW_APPROVE' AND json_extract(after_json,'$.correctionId') IS NULL"]){
    const h=await setup();try{
      assert.equal((await edit(h,owner,'amountSatang','530')).result,'APPLIED');h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';h.sqlite.exec(mutation);
      const actor=await h.actor(),perform=data=>h.capture(()=>handleExpensePostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`${data}&id=${h.expenseId}`}}),actor.employee,actor));
      await perform('a=expense_accept_description');await perform('a=expense_set_category&category=equipment');await perform('a=expense_set_payment&payment=kbank&source=CARD_KBANK');await perform('a=expense_confirm');
      assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'WAITING_CONFIRM',mutation);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    }finally{h.close()}
  }
});

test('each re-attestation transaction boundary rolls back facts, audit and evidence',async()=>{
  for(let failAt=0;failAt<8;failAt++){
    const h=await setup();try{const before=await loadOwnerExpense(h.env,owner,h.expenseId),id=await createOwnerCorrectionDraft(h.env,owner,before,'amountSatang','530');
      const document=h.sqlite.prepare('SELECT normalized_json FROM expense_documents').get().normalized_json,count=h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n;
      h.DB.failAt=failAt;await assert.rejects(commitPendingOwnerCorrection(h.env,owner,id,before.version),/fixture batch failure/);
      assert.equal(h.sqlite.prepare('SELECT amount_satang FROM expense_events').get().amount_satang,51900);assert.equal(h.sqlite.prepare('SELECT normalized_json FROM expense_documents').get().normalized_json,document);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,count);assert.equal(h.sqlite.prepare('SELECT status FROM expense_owner_corrections').get().status,'DRAFT');
    }finally{h.close()}
  }
});

test('feature disabled keeps existing online-order confirmation compatible before migration',async()=>{
  const h=ownerOrderFixture();try{
    h.sqlite.exec('DROP TABLE expense_owner_correction_inputs; DROP TABLE expense_owner_correction_sync; DROP TABLE expense_owner_corrections');
    const {row}=await h.receive({}, {line:'fixture_staff'}),review=await h.ready(row.document_id);await h.post('order_review_continue',row.document_id,Number(review.review_version));
    const expense=h.sqlite.prepare('SELECT * FROM expense_events').get(),actor=await h.actor(),perform=data=>h.capture(()=>handleExpensePostback(h.env,h.event('fixture_owner',{type:'postback',postback:{data:`${data}&id=${expense.expense_id}`}}),actor.employee,actor));
    await perform('a=expense_accept_description');await perform('a=expense_set_category&category=equipment');await perform('a=expense_set_payment&payment=kbank&source=CARD_KBANK');
    assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,1);
  }finally{h.close()}
});
