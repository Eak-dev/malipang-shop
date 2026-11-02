import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {cancelOwnerCorrectionDraft,clearOwnerCorrectionInput,commitOwnerCorrection,createOwnerCorrectionDraft,loadOwnerCorrectionDraft,loadOwnerCorrectionInput,loadOwnerExpense,ownerCorrectionStatus,searchOwnerExpenses,startOwnerCorrectionInput} from '../dist/expense/owner-correction-repository.js';

const planFor=h=>({expenseId:h.sqlite.prepare('SELECT expense_id FROM expense_events').get().expense_id,dailyMetadataId:1,rawMetadataId:2,patches:[{metadataId:1,cells:[{columnIndex:21,value:'transport'}]},{metadataId:2,cells:[{columnIndex:6,value:'transport'}]}],originalRows:[{metadataId:1,values:Array(22).fill(null)},{metadataId:2,values:[null,null,null,null,null,null,'general']}],rebind:null});

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
    assert.equal(await ownerCorrectionStatus(h.env,owner,id,now),'DRAFT');
    const evidence={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false};
    assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now),null,'a verified sync plan is mandatory');
    assert.equal(await commitOwnerCorrection(h.env,owner,id,{...evidence,sourcePeriod:'UNKNOWN'},'trace',now,planFor(h)),null);
    assert.equal(await commitOwnerCorrection(h.env,owner,id,{...evidence,reportDeduplicationVerified:false},'trace',now,planFor(h)),null);
    const tampered=planFor(h);tampered.patches[1].cells.push({columnIndex:3,value:1});
    assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now,tampered),null);
    const wrong=planFor(h);wrong.patches[1].cells[0].value='rent';
    assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now,wrong),null);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
    assert.equal(await commitOwnerCorrection(h.env,{employeeId:'TEST_STAFF',lineUserId:'fixture_staff'},id,evidence,'trace',now,planFor(h)),null);
    assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now,planFor(h)),2);
    assert.equal(await commitOwnerCorrection(h.env,owner,id,evidence,'trace',now,planFor(h)),null);
    const after=h.sqlite.prepare('SELECT category,version FROM expense_events').get();assert.equal(after.category,'transport');assert.equal(after.version,2);
    const audit=h.sqlite.prepare('SELECT actor_employee_id,before_json,after_json FROM expense_audit_log').get();assert.equal(audit.actor_employee_id,'TEST_OWNER');assert.equal(JSON.parse(audit.before_json).category,'general');assert.equal(JSON.parse(audit.after_json).category,'transport');
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION' AND status='PENDING'").get().n,1);
    const sync=h.sqlite.prepare('SELECT phase,plan_json FROM expense_owner_correction_sync').get();assert.equal(sync.phase,'PREPARED');assert.equal(JSON.parse(sync.plan_json).expenseId,'exp_apply');
    assert.equal(await ownerCorrectionStatus(h.env,owner,id,now),'SYNC_PENDING');
    assert.equal(await ownerCorrectionStatus(h.env,{employeeId:'TEST_STAFF',lineUserId:'fixture_staff'},id,now),null);
    h.sqlite.prepare("UPDATE expense_owner_correction_sync SET phase='REVIEW' WHERE correction_id=?").run(id);assert.equal(await ownerCorrectionStatus(h.env,owner,id,now),'SYNC_REVIEW');
    h.sqlite.prepare("UPDATE expense_owner_correction_sync SET phase='PREPARED' WHERE correction_id=?").run(id);
    h.sqlite.prepare("UPDATE sync_jobs SET status='FAILED' WHERE entity_type='EXPENSE_CORRECTION'").run();assert.equal(await ownerCorrectionStatus(h.env,owner,id,now),'SYNC_FAILED');
    h.sqlite.prepare("UPDATE sync_jobs SET status='COMPLETED' WHERE entity_type='EXPENSE_CORRECTION'").run();assert.equal(await ownerCorrectionStatus(h.env,owner,id,now),'SYNC_PENDING');
    h.sqlite.prepare("UPDATE expense_owner_corrections SET reconciled_at='2026-10-28T10:02:00Z' WHERE correction_id=?").run(id);assert.equal(await ownerCorrectionStatus(h.env,owner,id,now),'SYNC_PENDING');
    h.sqlite.prepare("UPDATE expense_owner_correction_sync SET phase='RECONCILED' WHERE correction_id=?").run(id);assert.equal(await ownerCorrectionStatus(h.env,owner,id,now),'COMPLETED');
  }finally{h.close()}
});

test('a failure at any transaction step leaves expense, audit and job unchanged',async()=>{
  for(let failAt=0;failAt<6;failAt++){
    const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-28T10:00:00Z');try{
      h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
        VALUES('exp_failure','msg_failure','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
      const snapshot=await loadOwnerExpense(h.env,owner,'exp_failure'),id=await createOwnerCorrectionDraft(h.env,owner,snapshot,'category','transport',now);
      const evidence={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false};
      h.DB.failAt=failAt;await assert.rejects(commitOwnerCorrection(h.env,owner,id,evidence,'trace',now,planFor(h)),/fixture batch failure/);
      assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_owner_correction_sync').get().n,0);
    }finally{h.close()}
  }
});

test('an unexpected zero-row expense update aborts the entire transaction',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-28T10:00:00Z');try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_barrier','msg_barrier','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const before=await loadOwnerExpense(h.env,owner,'exp_barrier'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',now);
    h.sqlite.exec("CREATE TRIGGER fixture_ignore_update BEFORE UPDATE ON expense_events BEGIN SELECT RAISE(IGNORE); END");
    const e={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false};
    await assert.rejects(commitOwnerCorrection(h.env,owner,id,e,'trace',now,planFor(h)),/malformed JSON/);
    assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
    assert.equal(h.sqlite.prepare('SELECT status FROM expense_owner_corrections').get().status,'DRAFT');
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close()}
});
test('a snapshot that changes after preview is never committed even if version was not bumped',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-28T10:00:00Z');try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_stale','msg_stale','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const before=await loadOwnerExpense(h.env,owner,'exp_stale'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',now);
    h.sqlite.prepare("UPDATE expense_events SET description='Changed while open' WHERE expense_id='exp_stale'").run();
    const e={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false};
    assert.equal(await commitOwnerCorrection(h.env,owner,id,e,'trace',now,planFor(h)),null);assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
    assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM expense_audit_log').get().n,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sync_jobs').get().n,0);
  }finally{h.close()}
});
test('an expired draft or revoked owner cannot commit a correction',async()=>{
  for(const mode of ['expired','revoked']){
    const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-28T10:00:00Z');try{
      h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
        VALUES('exp_expiry','msg_expiry','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
      const before=await loadOwnerExpense(h.env,owner,'exp_expiry'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',now);
      if(mode==='revoked')h.sqlite.prepare("UPDATE staff_roles SET status='INACTIVE' WHERE employee_id='TEST_OWNER'").run();
      const e={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false};
      assert.equal(await commitOwnerCorrection(h.env,owner,id,e,'trace',mode==='expired'?now+16*60_000:now,planFor(h)),null);
      assert.equal(h.sqlite.prepare('SELECT category FROM expense_events').get().category,'general');
    }finally{h.close()}
  }
});

test('unknown result after commit never applies the same correction twice',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},now=Date.parse('2026-10-28T10:00:00Z');try{
    h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES('exp_unknown','msg_unknown','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
    const before=await loadOwnerExpense(h.env,owner,'exp_unknown'),id=await createOwnerCorrectionDraft(h.env,owner,before,'category','transport',now);
    const e={ownerVerified:true,snapshotCurrent:true,sourcePeriod:'OPEN',destinationPeriod:'OPEN',itemCount:0,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false};
    h.DB.failAfterCommit=true;await assert.rejects(commitOwnerCorrection(h.env,owner,id,e,'trace',now,planFor(h)),/fixture crash after commit/);h.DB.failAfterCommit=false;
    assert.equal(await commitOwnerCorrection(h.env,owner,id,e,'trace',now,planFor(h)),null);
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
    h.sqlite.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,vendor_name,expense_id)
      VALUES('doc_search','msg_doc_search','fixture_staff','RECEIPT','CONFIRMED','now','ร้านทดสอบพิเศษ','exp_search')`).run();
    for(const query of ['Driver','2000','2026-10-28','28/10/2569','100%','ร้านทดสอบพิเศษ'])assert.equal((await searchOwnerExpenses(h.env,owner,query)).length,1);
    assert.equal((await loadOwnerExpense(h.env,owner,'exp_search')).description,'Driver 100%');
    assert.equal(await loadOwnerExpense(h.env,staff,'exp_search'),null);
    assert.equal((await searchOwnerExpenses(h.env,staff,'Driver')).length,0);
    assert.equal((await searchOwnerExpenses(h.env,owner,'%%')).length,0);
    assert.equal((await searchOwnerExpenses(h.env,owner,'x')).length,0);
    h.sqlite.prepare("UPDATE staff_roles SET status='INACTIVE' WHERE employee_id='TEST_OWNER'").run();
    assert.equal((await searchOwnerExpenses(h.env,owner,'Driver')).length,0);
  }finally{h.close()}
});

test('pagination uses a stable tie breaker without skipping or repeating matching expenses',async()=>{
  const h=ownerOrderFixture(),owner={employeeId:'TEST_OWNER',lineUserId:'fixture_owner'};try{
    const insert=h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
      VALUES(?,?,'fixture_staff','Shop test',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','same-time',1)`);
    for(let i=0;i<12;i++)insert.run(`exp_page_${i.toString().padStart(2,'0')}`,`msg_page_${i}`);
    const first=await searchOwnerExpenses(h.env,owner,'Shop'),last=first[7],second=await searchOwnerExpenses(h.env,owner,'Shop',last.created_at,last.expense_id);
    assert.equal(first.length,9);assert.equal(second.length,4);assert.equal(new Set([...first.slice(0,8),...second].map(row=>row.expense_id)).size,12);
  }finally{h.close()}
});
