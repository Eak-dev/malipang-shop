import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {claimOwnerCorrectionLease,renewOwnerCorrectionLease} from '../dist/sheets/owner-correction-lease.js';
import {claimSheetSyncJob,syncJob} from '../dist/sheets/sync.js';

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
    assert.equal(await syncJob(h.env,ordinary),'BUSY');
    h.sqlite.prepare("UPDATE sync_jobs SET status='COMPLETED' WHERE entity_type='EXPENSE' AND entity_key='exp_lease' AND entity_version=3").run();
    assert.equal(await syncJob(h.env,ordinary),'IGNORED');
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
