import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {claimOwnerCorrectionLease,renewOwnerCorrectionLease} from '../dist/sheets/owner-correction-lease.js';
import {claimSheetSyncJob,syncJob,reconcileExpenseItemRows} from '../dist/sheets/sync.js';
import {undoConfirmedExpense} from '../dist/expense/undo.js';
import {enqueueSheetSyncBatch} from '../dist/db/repositories.js';

function setup(){
  const h=ownerOrderFixture(),now=Date.parse('2026-10-28T10:00:00Z');
  h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_lease','msg_lease','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',2)`).run();
  h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('job_correction','EXPENSE_CORRECTION','exp_lease',2,'trace','PENDING',0,'now')`).run();
  return {...h,now,job:{expenseId:'exp_lease',version:2}};
}
test('correction lease is version bound and fences normal expense synchronization',async()=>{
  const h=setup();try{
    const token=await claimOwnerCorrectionLease(h.env,h.job,h.now);assert.ok(token);
    assert.equal(await claimOwnerCorrectionLease(h.env,h.job,h.now),null);
    assert.equal(await renewOwnerCorrectionLease(h.env,h.job,'wrong',h.now+1000),false);
    assert.equal(await renewOwnerCorrectionLease(h.env,h.job,token,h.now+1000),true);
    assert.equal(await renewOwnerCorrectionLease(h.env,h.job,token,h.now+20*60_000),false);
    const ordinary={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_lease',entityVersion:3,traceId:'trace_other'};
    assert.equal(await claimSheetSyncJob(h.env,ordinary,h.now+1000),null);
    assert.equal(await syncJob(h.env,ordinary),'IGNORED');
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key='exp_lease'").get().n,0);
    h.sqlite.prepare("UPDATE expense_events SET version=3 WHERE expense_id='exp_lease'").run();assert.equal(await renewOwnerCorrectionLease(h.env,h.job,token,h.now+2000),false);
  }finally{h.close()}
});
test('a pending ordinary expense job or stale expense version stops correction dispatch',async()=>{
  const h=setup();try{
    h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('job_other','EXPENSE','exp_lease',3,'trace','PENDING',0,'now')`).run();
    assert.equal(await claimOwnerCorrectionLease(h.env,h.job,h.now),null);
    h.sqlite.prepare("UPDATE sync_jobs SET status='COMPLETED' WHERE job_id='job_other'").run();
    h.sqlite.prepare("UPDATE expense_events SET version=3 WHERE expense_id='exp_lease'").run();
    assert.equal(await claimOwnerCorrectionLease(h.env,h.job,h.now),null);
  }finally{h.close()}
});
test('late legacy queue messages cannot create an unsafe job for a corrected expense',async()=>{
  const h=setup();try{
    h.sqlite.prepare("UPDATE sync_jobs SET status='COMPLETED' WHERE job_id='job_correction'").run();
    const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_lease',entityVersion:3,traceId:'trace_late'};
    assert.equal(await syncJob(h.env,job),'IGNORED');
    assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key='exp_lease' AND entity_version=3").get().n,0);
  }finally{h.close()}
});

test('forced legacy reconciliation cannot reopen an older job while a correction exists',async()=>{
  for(const status of ['PENDING','PROCESSING','COMPLETED','REVIEW']){const h=setup();try{
    h.sqlite.prepare("UPDATE sync_jobs SET status=? WHERE job_id='job_correction'").run(status);
    h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('legacy','EXPENSE','exp_lease',1,'original','COMPLETED',1,'now')`).run();
    const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_lease',entityVersion:1,traceId:'synthetic_force'};
    await enqueueSheetSyncBatch(h.env,[job],true);
    assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='legacy'").get().status,'COMPLETED');
    assert.equal(await syncJob(h.env,job),'IGNORED');
  }finally{h.close()}}
});

test('legacy manual item reconciliation is fenced from the correction workflow',async()=>{
  const h=setup();try{
    h.env.OWNER_EXPENSE_CORRECTION_ENABLED='true';await assert.rejects(reconcileExpenseItemRows(h.env,'exp_lease'),/EXPENSE_ITEM_RECONCILE_REQUIRES_VERIFIED_SYNC/);
    h.env.OWNER_EXPENSE_CORRECTION_ENABLED='false';await assert.rejects(reconcileExpenseItemRows(h.env,'exp_lease'),/CORRECTED_EXPENSE_REQUIRES_VERIFIED_SYNC/);
  }finally{h.close()}
});

test('undo cannot change D1 while corrected sheet rows require verified synchronization',async()=>{
  for(const status of ['PENDING','PROCESSING','COMPLETED','REVIEW']){
    const h=setup();try{
      h.sqlite.prepare("UPDATE sync_jobs SET status=? WHERE job_id='job_correction'").run(status);
      const version=await undoConfirmedExpense(h.env,{expenseId:'exp_lease',lineUserId:'fixture_staff',traceId:'synthetic_undo',actorEmployeeId:'TEST_STAFF',branchId:'B001'});
      const row=h.sqlite.prepare("SELECT status,version FROM expense_events WHERE expense_id='exp_lease'").get();assert.equal(version,null);assert.equal(row.status,'CONFIRMED');assert.equal(row.version,2);
      assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM expense_audit_log WHERE expense_id='exp_lease' AND action='UNDO'").get().n,0);
      assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key='exp_lease'").get().n,0);
    }finally{h.close()}
  }
});
