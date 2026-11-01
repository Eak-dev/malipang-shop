import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {cancelOwnerCorrectionDraft,clearOwnerCorrectionInput,commitOwnerCorrection,createOwnerCorrectionDraft,loadOwnerCorrectionDraft,loadOwnerCorrectionInput,loadOwnerExpense,searchOwnerExpenses,startOwnerCorrectionInput} from '../dist/expense/owner-correction-repository.js';

test('only the active verified owner can draft a correction for another submitter without changing the expense',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},staff={employeeId:'TEST_STAFF',lineUserId:'fixture_staff'},time=Date.parse('2026-10-28T10:00:00Z');try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_owner_test','msg_owner_test','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const before={expenseId:'exp_owner_test',status:'CONFIRMED',version:1,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'};
    assert.equal(await createOwnerCorrectionDraft(h.env,staff,before,'category','transport',time),null);
    assert.equal(await createOwnerCorrectionDraft(h.env,owner,{...before,amountSatang:1},'category','transport',time),null);
    const id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',time);assert.ok(id);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
    assert.equal(await loadOwnerCorrectionDraft(h.env,staff,id,time),null);
    const draft=await loadOwnerCorrectionDraft(h.env,owner,id,time);assert.equal(JSON.parse(draft.before_json).category,'general');assert.equal(JSON.parse(draft.after_json).category,'transport');
    h.sqlite.prepare("UPDATE expense_events SET description='Changed concurrently' WHERE expense_id='exp_owner_test'").run();
    assert.equal(await createOwnerCorrectionDraft(h.env,owner,before,'category','rent',time),null,'stale values must fail even if the old version was not incremented');
    assert.equal(await loadOwnerCorrectionDraft(h.env,owner,id,time+16*60_000),null);
    h.sqlite.prepare("UPDATE line_identity_bindings SET status='REVOKED' WHERE employee_id='TEST_OWNER'").run();
    assert.equal(await loadOwnerCorrectionDraft(h.env,owner,id,time),null);
  }finally{h.close()}
});

test('guarded transaction records owner, old and new values and exactly one durable job',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-28T10:00:00Z');try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_apply','msg_apply','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const snapshot=await loadOwnerExpense(h.env,owner,'exp_apply'),id=await createOwnerCorrectionDraft(h.env,owner,snapshot,'category','transport',now);
    const evidence={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,syncInProgress:false};
    assert.equal(await commitOwnerCorrection(h.env,owner,id,{...evidence,sourcePeriod:'UNKNOWN'},'trace',now),null);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
    assert.equal(await commitOwnerCorrection(h.env,{employeeId:'TEST_STAFF',lineUserId:'fixture_staff'},id,evidence,'trace',now),null);
    assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now),2);
    assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now),null);
    const after=h.sqlite.prepare('SELECT category,version FROM expense_events').get();assert.equal(after.category,'transport');assert.equal(after.version,2);
    const audit=h.sqlite.prepare('SELECT actor_employee_id,before_json,after_json FROM expense_audit_log').get();assert.equal(audit.actor_employee_id,'TEST_OWNER');assert.equal(JSON.parse(audit.before_json).category,'general');assert.equal(JSON.parse(audit.after_json).category,'transport');
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION' AND status='PENDING'").get().n,1);
  }finally{h.close()}
});

test('a failure at any transaction step leaves expense, audit and job unchanged',async()=>{
  for(let failAt=0;failAt<5;failAt++){
    const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-28T10:00:00Z');try{
      h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
        VALUES('exp_failure','msg_failure','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
      const snapshot=await loadOwnerExpense(h.env,owner,'exp_failure'),id=await createOwnerCorrectionDraft(h.env,owner,snapshot,'category','transport',now);
      const evidence={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,syncInProgress:false};
      h.DB.failAt=failAt;await assert.rejects(commitOwnerCorrection(h.env,owner,id,evidence,'trace',now),/fixture batch failure/);
      assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    }finally{h.close()}
  }
});

test('an unexpected zero-row expense update aborts the entire transaction',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-28T10:00:00Z');try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_barrier','msg_barrier','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const before=await loadOwnerExpense(h.env,owner,'exp_barrier'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',now);
    h.sqlite.exec("CREATE TRIGGER fixture_ignore_update BEFORE UPDATE ON expense_events BEGIN SELECT RAISE(IGNORE); END");
    const e={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,syncInProgress:false};
    await assert.rejects(commitOwnerCorrection(h.env,owner,id,e,'trace',now),/malformed JSON/);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
    assert.equal(h.sqlite.prepare('SELECT status FROM expense_owner_corrections').get().status,'DRAFT');
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close()}
});

test('unknown result after commit never applies the same correction twice',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-28T10:00:00Z');try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_unknown','msg_unknown','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const before=await loadOwnerExpense(h.env,owner,'exp_unknown'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',now);
    const e={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,syncInProgress:false};
    h.DB.failAfterCommit=true;await assert.rejects(commitOwnerCorrection(h.env,owner,id,e,'trace',now),/fixture crash after commit/);h.DB.failAfterCommit=false;
    assert.equal(await commitOwnerCorrection(h.env,owner,id,e,'trace',now),null);
    assert.equal(h.sqlite.prepare('SELECT version FROM expense_events').get().version,2);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,1);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,1);
  }finally{h.close()}
});

test('input prompts are owner-only, expire, and an old reply cannot clear a newer prompt',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},staff={employeeId:'TEST_STAFF',lineUserId:'fixture_staff'},now=Date.parse('2026-10-28T10:00:00Z');try{
    assert.equal(await startOwnerCorrectionInput(h.env,staff,{mode:'SEARCH'},now),false);
    assert.equal(await startOwnerCorrectionInput(h.env,owner,{mode:'SEARCH'},now),true);
    const first=await loadOwnerCorrectionInput(h.env,owner,now);assert.equal(first.mode,'SEARCH');
    assert.equal(await startOwnerCorrectionInput(h.env,owner,{mode:'SEARCH'},now),true);
    const next=await loadOwnerCorrectionInput(h.env,owner,now);assert.notEqual(next.input_id,first.input_id);
    assert.equal(await clearOwnerCorrectionInput(h.env,owner,first.input_id),false);
    assert.equal(await loadOwnerCorrectionInput(h.env,owner,now+16*60_000),null);
    assert.equal(await clearOwnerCorrectionInput(h.env,owner,next.input_id),true);
  }finally{h.close()}
});

test('a typed reply creates at most one draft and cannot use a replaced input',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-28T10:00:00Z');try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_input','msg_input','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const snapshot=await loadOwnerExpense(h.env,owner,'exp_input');
    await startOwnerCorrectionInput(h.env,owner,{mode:'VALUE',field:'amountSatang',snapshot},now);
    const first=await loadOwnerCorrectionInput(h.env,owner,now);
    assert.ok(await createOwnerCorrectionDraft(h.env,owner,snapshot,'amountSatang','2100',now,first.input_id));
    assert.equal(await createOwnerCorrectionDraft(h.env,owner,snapshot,'amountSatang','2100',now,first.input_id),null);
    await startOwnerCorrectionInput(h.env,owner,{mode:'VALUE',field:'amountSatang',snapshot},now);
    assert.equal(await createOwnerCorrectionDraft(h.env,owner,snapshot,'amountSatang','2200',now,first.input_id),null);
    assert.equal(h.sqlite.prepare('SELECT amount_satang FROM expense_events').get().amount_satang,200000);
  }finally{h.close()}
});

test('draft cancellation is owner-only and idempotent, and leaves financial data unchanged',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},other={employeeId:'TEST_OWNER_TWO',lineUserId:'fixture_owner_two'},time=Date.parse('2026-10-28T10:00:00Z');try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_cancel_test','msg_cancel_test','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const before={expenseId:'exp_cancel_test',status:'CONFIRMED',version:1,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'};
    const id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',time);
    assert.equal(await cancelOwnerCorrectionDraft(h.env,other,id,time),false);
    assert.equal(await cancelOwnerCorrectionDraft(h.env,owner,id,time),true);
    assert.equal(await cancelOwnerCorrectionDraft(h.env,owner,id,time),false);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
  }finally{h.close()}
});

test('owner search finds another submitter by name, exact amount or date without granting employee access',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},staff={employeeId:'TEST_STAFF',lineUserId:'fixture_staff'};try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_search','msg_search','fixture_staff','Driver 100%',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    for(const query of ['Driver','2000','2026-10-28','28/10/2569','100%'])assert.equal((await searchOwnerExpenses(h.env,owner,query)).length,1);
    assert.equal((await loadOwnerExpense(h.env,owner,'exp_search')).description,'Driver 100%');
    assert.equal(await loadOwnerExpense(h.env,staff,'exp_search'),null);
    assert.equal((await searchOwnerExpenses(h.env,staff,'Driver')).length,0);
    assert.equal((await searchOwnerExpenses(h.env,owner,'%%')).length,0);
    assert.equal((await searchOwnerExpenses(h.env,owner,'x')).length,0);
    h.sqlite.prepare("UPDATE staff_roles SET status='INACTIVE' WHERE employee_id='TEST_OWNER'").run();
    assert.equal((await searchOwnerExpenses(h.env,owner,'Driver')).length,0);
  }finally{h.close()}
});
