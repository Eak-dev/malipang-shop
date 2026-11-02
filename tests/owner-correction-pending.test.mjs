import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {commitPendingOwnerCorrection,createOwnerCorrectionDraft,loadOwnerExpense,ownerCorrectionStatus} from '../dist/expense/owner-correction-repository.js';
import {handleOwnerCorrectionPostback} from '../dist/expense/owner-correction-service.js';
import {processInbound} from '../dist/router/process-event.js';

const owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};
async function setup(){
  const h=ownerOrderFixture();h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_pending_owner','msg_pending_owner','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','WAITING_CONFIRM','now',1)`).run();
  h.sqlite.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,expense_id,created_at,normalized_json)
    VALUES('doc_pending_owner','msg_document','fixture_staff','RECEIPT','WAITING_CONFIRM','exp_pending_owner','now',?)`).run(JSON.stringify({expenseReview:{requiredFields:['description','category','payment'],confirmedFields:[]},imageFacts:{amount:2000}}));
  const before=await loadOwnerExpense(h.env,owner,'exp_pending_owner');return {...h,before};
}

test('owner correction of any pending field remains pending, preserves evidence and is audited once',async()=>{
  for(const [field,value,column,want] of [['category','transport','category','transport'],['description','Taxi','description','Taxi'],['amountSatang','2100.50','amount_satang',210050],['transactionDate','2026-10-27','transaction_date','2026-10-27'],['payment',{paymentKey:'cash',sourceWallet:'CASH_DRAWER'},'payment_key','cash']]){
    const h=await setup();try{
      const evidence=h.sqlite.prepare('SELECT normalized_json FROM expense_documents').get().normalized_json;
      const id=await createOwnerCorrectionDraft(h.env,owner,h.before,field,value),result=await commitPendingOwnerCorrection(h.env,owner,id,1);
      assert.equal(result,'APPLIED',field);const row=h.sqlite.prepare('SELECT * FROM expense_events').get();assert.equal(row[column],want);assert.equal(row.status,'WAITING_CONFIRM');assert.equal(row.version,2);
      assert.equal(h.sqlite.prepare('SELECT normalized_json FROM expense_documents').get().normalized_json,evidence);
      const audit=h.sqlite.prepare('SELECT actor_employee_id,action,before_json,after_json FROM expense_audit_log').get();assert.equal(audit.actor_employee_id,'TEST_OWNER');assert.equal(audit.action,'EDIT');assert.equal(JSON.parse(audit.after_json).correctionId,id);
      assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);assert.equal(await ownerCorrectionStatus(h.env,owner,id),'DRAFT_EDITED');
      assert.equal(await commitPendingOwnerCorrection(h.env,owner,id,1),'STALE');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,1);
    }finally{h.close()}
  }
});

test('stale and unauthorized pending corrections never create changes or audits',async()=>{
  for(const mode of ['version','snapshot','revoked','other_owner']){const h=await setup();try{
    const id=await createOwnerCorrectionDraft(h.env,owner,h.before,'category','transport');
    if(mode==='version')h.sqlite.exec('UPDATE expense_events SET version=2');
    if(mode==='snapshot')h.sqlite.exec("UPDATE expense_events SET description='updated elsewhere'");
    if(mode==='revoked')h.sqlite.exec("UPDATE line_identity_bindings SET status='REVOKED' WHERE employee_id='TEST_OWNER'");
    const actor=mode==='other_owner'?{employeeId:'TEST_OWNER_TWO',lineUserId:'fixture_owner_two'}:owner;
    assert.equal(await commitPendingOwnerCorrection(h.env,actor,id,1),'STALE');assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);
  }finally{h.close()}}
});

test('any failure or ignored update rolls back the pending change and audit',async()=>{
  for(const mode of ['0','1','2','3','ignore']){const h=await setup();try{
    const id=await createOwnerCorrectionDraft(h.env,owner,h.before,'category','transport');
    if(mode==='ignore')h.sqlite.exec("CREATE TRIGGER ignore_expense BEFORE UPDATE ON expense_events BEGIN SELECT RAISE(IGNORE); END");else h.DB.failAt=Number(mode);
    await assert.rejects(commitPendingOwnerCorrection(h.env,owner,id,1));
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');assert.equal(h.sqlite.prepare('SELECT status FROM expense_owner_corrections').get().status,'DRAFT');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);
  }finally{h.close()}}
});

test('LINE confirmation updates only the waiting draft, without finalizing or sending a sync job',async()=>{
  const h=await setup();try{
    const id=await createOwnerCorrectionDraft(h.env,owner,h.before,'category','transport');
    const event=h.event('fixture_owner',{type:'postback',postback:{data:`a=owner_correction_confirm&id=${id}&v=1`}});
    await h.capture(()=>handleOwnerCorrectionPostback(h.env,event,'synthetic_trace'));
    assert.match(JSON.stringify(h.messages.at(-1)),/ยังไม่ลงบัญชี/);assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'WAITING_CONFIRM');assert.equal(h.queue.length,0);
  }finally{h.close()}
});

test('actual inbound routing searches, previews and applies a staff draft once after owner confirmation',async()=>{
  const h=await setup();try{
    const route=async extra=>{const event=h.event('fixture_owner',extra);return h.capture(()=>processInbound({kind:'LINE_EVENT',event,receivedAtIso:new Date().toISOString(),traceId:'synthetic_owner_flow'},h.env,{}));};
    await route({message:{type:'text',id:'search_command',text:'แก้ไขค่าใช้จ่าย'}});
    await route({message:{type:'text',id:'search_term',text:'Driver'}});
    await route({type:'postback',postback:{data:'a=owner_correction_open&id=exp_pending_owner'}});
    await route({type:'postback',postback:{data:'a=owner_correction_set_category&id=exp_pending_owner&v=1&category=transport'}});
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
    const id=h.sqlite.prepare('SELECT correction_id FROM expense_owner_corrections').get().correction_id;
    await route({type:'postback',postback:{data:`a=owner_correction_confirm&id=${id}&v=1`}});
    const result=h.sqlite.prepare('SELECT category,status,version FROM expense_events').get();assert.equal(result.category,'transport');assert.equal(result.status,'WAITING_CONFIRM');assert.equal(result.version,2);
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='EDIT'").get().n,1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close()}
});

test('a failed LINE response and repeated confirmation cannot repeat the pending edit',async()=>{
  const h=await setup();try{
    const id=await createOwnerCorrectionDraft(h.env,owner,h.before,'category','transport'),event=h.event('fixture_owner',{type:'postback',postback:{data:`a=owner_correction_confirm&id=${id}&v=1`}});
    await h.capture(()=>handleOwnerCorrectionPostback(h.env,event,'synthetic_trace'),{failReply:true});
    await h.capture(()=>handleOwnerCorrectionPostback(h.env,event,'synthetic_trace'));
    assert.match(JSON.stringify(h.messages.at(-1)),/บันทึกการแก้ไขในร่างนี้แล้ว/);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'transport');assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE action='EDIT'").get().n,1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close()}
});

test('changing the amount of an owner-reviewed order is held until provenance can be re-attested',async()=>{
  const h=await setup();try{
    h.sqlite.exec(`UPDATE expense_documents SET document_type='ONLINE_ORDER',normalized_json='{"ownerPaymentReview":{"source":"OWNER_LINE_REVIEW"}}'`);
    const id=await createOwnerCorrectionDraft(h.env,owner,h.before,'amountSatang','2100');
    assert.equal(await commitPendingOwnerCorrection(h.env,owner,id,1),'REVIEW');assert.equal(h.sqlite.prepare('SELECT amount_satang FROM expense_events').get().amount_satang,200000);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);
  }finally{h.close()}
});
