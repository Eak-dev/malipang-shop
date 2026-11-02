import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
const require=createRequire(import.meta.url),runtime=require('../dist/sheets/owner-correction-runtime.js'),sync=require('../dist/sheets/sync.js'),worker=require('../dist/index.js').default;

test('correction queue uses the guarded runtime only when enabled and preserves its outcomes',async()=>{
  const original=runtime.processOwnerCorrectionRuntime;try{
    let calls=0,outcome='COMPLETED';runtime.processOwnerCorrectionRuntime=async(_env,job)=>{calls++;assert.deepEqual(job,{expenseId:'exp_queue',version:2});return outcome};
    const job={kind:'SHEETS_SYNC',entityType:'EXPENSE_CORRECTION',entityKey:'exp_queue',entityVersion:2,traceId:'trace_queue'},env={SHEETS_SYNC_ENABLED:'true'};
    assert.equal(await sync.syncJob(env,job),'IGNORED');assert.equal(calls,0);env.OWNER_EXPENSE_CORRECTION_ENABLED='true';
    assert.equal(await sync.syncJob(env,job),'PROCESSED');outcome='BUSY';assert.equal(await sync.syncJob(env,job),'BUSY');outcome='REVIEW';assert.equal(await sync.syncJob(env,job),'REVIEW');outcome='IGNORED';assert.equal(await sync.syncJob(env,job),'IGNORED');
  }finally{runtime.processOwnerCorrectionRuntime=original}
});

test('a review outcome is recorded as an open failed job and is not retried blindly',async()=>{
  const h=ownerOrderFixture(),original=sync.syncJob;try{
    sync.syncJob=async()=> 'REVIEW';let acked=0,retried=0;
    const job={kind:'SHEETS_SYNC',entityType:'EXPENSE_CORRECTION',entityKey:'exp_queue',entityVersion:2,traceId:'synthetic_review'},message={body:job,ack(){acked++},retry(){retried++}};
    await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});
    assert.equal(acked,1);assert.equal(retried,0);const failed=h.sqlite.prepare('SELECT status,error FROM failed_jobs').get();assert.equal(failed.status,'OPEN');assert.equal(failed.error,'CORRECTION_REVIEW_REQUIRED');
  }finally{sync.syncJob=original;h.close()}
});
