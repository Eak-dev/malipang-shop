import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {cancelOwnerCorrectionDraft,createOwnerCorrectionDraft,loadOwnerCorrectionDraft,loadOwnerExpense,searchOwnerExpenses} from '../dist/expense/owner-correction-repository.js';

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
    for(const query of ['Driver','2000','2026-10-28','100%'])assert.equal((await searchOwnerExpenses(h.env,owner,query)).length,1);
    assert.equal((await loadOwnerExpense(h.env,owner,'exp_search')).description,'Driver 100%');
    assert.equal(await loadOwnerExpense(h.env,staff,'exp_search'),null);
    assert.equal((await searchOwnerExpenses(h.env,staff,'Driver')).length,0);
    assert.equal((await searchOwnerExpenses(h.env,owner,'%%')).length,0);
    assert.equal((await searchOwnerExpenses(h.env,owner,'x')).length,0);
    h.sqlite.prepare("UPDATE staff_roles SET status='INACTIVE' WHERE employee_id='TEST_OWNER'").run();
    assert.equal((await searchOwnerExpenses(h.env,owner,'Driver')).length,0);
  }finally{h.close()}
});
