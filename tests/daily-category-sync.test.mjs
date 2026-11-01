import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
import {seedDailyCategoryBaseline,registerDailyCategoryProjectionTarget,requestDailyCategoryChange,approveDailyCategoryChange} from '../dist/sheets/daily-category-repository.js';
import {syncDailyCategoryJob} from '../dist/sheets/daily-category-sync.js';
import {SheetsMutationOutcomeUnknownError} from '../dist/sheets/client.js';
import {claimSheetSyncJob,syncJob} from '../dist/sheets/sync.js';

async function setup(){
  const h=ownerOrderFixture();h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES('exp_sync','msg_sync','fixture_staff','Driver',200000,'transfer','SHOP_BANK','general','2026-10-28','CONFIRMED','now',1)`).run();
  const row={expenseId:'exp_sync',rowNumber:100,metadataId:11,fingerprint:'fixture',category:'general',expenseVersion:1};await seedDailyCategoryBaseline(h.env,row);await registerDailyCategoryProjectionTarget(h.env,{expenseId:'exp_sync',targetType:'RAW',itemId:'',metadataId:21,expenseVersion:1});const requestId=await requestDailyCategoryChange(h.env,row,'transport');
  await approveDailyCategoryChange(h.env,{requestId,row,observedCategory:'transport',owner:{employeeId:'TEST_OWNER',lineUserId:'fixture_owner'},traceId:'fixture'});
  return {...h,job:{kind:'SHEETS_SYNC',entityType:'EXPENSE_CATEGORY',entityKey:'exp_sync',entityVersion:2,traceId:'fixture'}};
}
test('category projection claims and completes only once',async()=>{
  const h=await setup();try{
    let runs=0;const runner=async()=>{runs++};
    assert.equal(await syncDailyCategoryJob(h.env,h.job,1,runner),'PROCESSED');
    assert.equal(await syncDailyCategoryJob(h.env,h.job,1,runner),'IGNORED');
    assert.equal(runs,1);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE_CATEGORY'").get().status,'COMPLETED');
  }finally{h.close()}
});
test('ambiguous Sheets outcomes retain a lease and block retries and new approval',async()=>{
  const h=await setup();try{
    const runner=async()=>{throw new SheetsMutationOutcomeUnknownError(new Error('timeout'))};
    assert.equal(await syncDailyCategoryJob(h.env,h.job,1,runner),'BUSY');
    const row=h.sqlite.prepare("SELECT status,last_error,lease_until FROM sync_jobs WHERE entity_type='EXPENSE_CATEGORY'").get();
    assert.equal(row.status,'PROCESSING');assert.match(row.last_error,/SHEETS_MUTATION_OUTCOME_UNKNOWN/);assert.ok(row.lease_until);
    assert.equal(await syncDailyCategoryJob(h.env,h.job,1,async()=>{throw new Error('must not run')}),'BUSY');
  }finally{h.close()}
});
test('a newer expense version prevents an old pending category projection',async()=>{
  const h=await setup();try{
    h.sqlite.exec("UPDATE expense_events SET version=3 WHERE expense_id='exp_sync'");
    assert.equal(await syncDailyCategoryJob(h.env,h.job,1,async()=>{throw new Error('must not run')}),'IGNORED');
    assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE_CATEGORY'").get().status,'COMPLETED');
  }finally{h.close()}
});
test('normal expense sync cannot overlap a category write or replay a superseded version',async()=>{
  const h=await setup();try{
    h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='category',lease_until='9999-01-01T00:00:00Z' WHERE entity_type='EXPENSE_CATEGORY'");
    h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('normal','EXPENSE','exp_sync',2,'normal','PENDING',0,'now')");
    const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_sync',entityVersion:2,traceId:'normal'};
    assert.equal(await claimSheetSyncJob(h.env,job),null);
    assert.equal(await syncJob(h.env,job),'BUSY');
    h.sqlite.exec("UPDATE sync_jobs SET status='COMPLETED',lease_until=NULL WHERE entity_type='EXPENSE_CATEGORY'");
    h.sqlite.exec("UPDATE sync_jobs SET entity_version=1 WHERE job_id='normal'");job.entityVersion=1;
    assert.equal(await syncJob(h.env,job),'IGNORED');
    assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='normal'").get().status,'COMPLETED');
  }finally{h.close()}
});
