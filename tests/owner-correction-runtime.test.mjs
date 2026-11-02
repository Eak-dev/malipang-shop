import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
const require=createRequire(import.meta.url),runtime=require('../dist/sheets/owner-correction-runtime.js'),sync=require('../dist/sheets/sync.js'),worker=require('../dist/index.js').default;

test('correction queue continues committed work with owner input disabled and preserves its outcomes',async()=>{
  const h=ownerOrderFixture(),original=runtime.processOwnerCorrectionRuntime;try{
    let calls=0,outcome='COMPLETED';runtime.processOwnerCorrectionRuntime=async(_env,job)=>{calls++;assert.deepEqual(job,{expenseId:'exp_queue',version:2});return outcome};
    const job={kind:'SHEETS_SYNC',entityType:'EXPENSE_CORRECTION',entityKey:'exp_queue',entityVersion:2,traceId:'trace_queue'},env=h.env;
    env.OWNER_EXPENSE_CORRECTION_ENABLED='false';assert.equal(await sync.syncJob(env,job),'PROCESSED');assert.equal(calls,1);
    env.OWNER_EXPENSE_CORRECTION_ENABLED='true';outcome='BUSY';assert.equal(await sync.syncJob(env,job),'BUSY');outcome='REVIEW';assert.equal(await sync.syncJob(env,job),'REVIEW');outcome='IGNORED';assert.equal(await sync.syncJob(env,job),'IGNORED');
    env.SHEETS_SYNC_ENABLED='false';assert.equal(await sync.syncJob(env,job),'BUSY');assert.equal(calls,4);
  }finally{runtime.processOwnerCorrectionRuntime=original;h.close()}
});

test('missing and partial migrations hold correction jobs without invoking runtime',async()=>{
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE_CORRECTION',entityKey:'exp_queue',entityVersion:2,traceId:'trace_queue'};
  for(const table of ['expense_events','sync_jobs','expense_documents','expense_document_links','expense_document_items','owner_correction_daily_write_fences','expense_owner_correction_sync','expense_owner_corrections']){
    const h=ownerOrderFixture(),original=runtime.processOwnerCorrectionRuntime;try{
      h.sqlite.exec(`DROP TABLE ${table}`);let calls=0;runtime.processOwnerCorrectionRuntime=async()=>{calls++;return 'COMPLETED'};
      assert.equal(await sync.syncJob(h.env,job),'BUSY',table);assert.equal(calls,0,table);
    }finally{runtime.processOwnerCorrectionRuntime=original;h.close()}
  }
});

test('a D1 outage is surfaced for retry rather than mistaken for a missing schema',async()=>{
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE_CORRECTION',entityKey:'exp_queue',entityVersion:2,traceId:'trace_outage'};
  const env={SHEETS_SYNC_ENABLED:'true',DB:{prepare(){return{async all(){throw new Error('D1 temporarily unavailable')}}}}};
  await assert.rejects(sync.syncJob(env,job),/D1 temporarily unavailable/);
});

test('an incomplete recovery table is held before runtime can write',async()=>{
  const h=ownerOrderFixture(),original=runtime.processOwnerCorrectionRuntime;try{
    h.sqlite.exec('ALTER TABLE expense_owner_correction_sync DROP COLUMN last_error');
    let calls=0;runtime.processOwnerCorrectionRuntime=async()=>{calls++;return 'COMPLETED'};
    assert.equal(await sync.syncJob(h.env,{kind:'SHEETS_SYNC',entityType:'EXPENSE_CORRECTION',entityKey:'exp_queue',entityVersion:2,traceId:'trace_queue'}),'BUSY');assert.equal(calls,0);
  }finally{runtime.processOwnerCorrectionRuntime=original;h.close()}
});

test('recovery does not depend on an unrelated newer migration',async()=>{
  const h=ownerOrderFixture(),original=runtime.processOwnerCorrectionRuntime;try{
    h.sqlite.exec('DROP TABLE expense_owner_correction_move_reservations');runtime.processOwnerCorrectionRuntime=async()=> 'COMPLETED';
    assert.equal(await sync.syncJob(h.env,{kind:'SHEETS_SYNC',entityType:'EXPENSE_CORRECTION',entityKey:'exp_queue',entityVersion:2,traceId:'trace_queue'}),'PROCESSED');
  }finally{runtime.processOwnerCorrectionRuntime=original;h.close()}
});

test('queue retains a committed correction when Sheets is off or recovery schema is missing',async()=>{
  for(const mode of ['sheets-off','missing-schema','send-fails']){
    const h=ownerOrderFixture();try{
      const job={kind:'SHEETS_SYNC',entityType:'EXPENSE_CORRECTION',entityKey:'exp_queue',entityVersion:2,traceId:`trace_${mode}`};
      h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('job_queue','EXPENSE_CORRECTION','exp_queue',2,?,'PENDING',0,'2026-01-01')`).run(job.traceId);
      if(mode==='missing-schema')h.sqlite.exec('DROP TABLE expense_owner_correction_sync');
      if(mode!=='missing-schema')h.env.SHEETS_SYNC_ENABLED='false';
      const sent=[];h.env.JOB_QUEUE.send=async(body,options)=>{if(mode==='send-fails')throw new Error('synthetic queue unavailable');sent.push({body,options});};
      let ack=0,retry=0;const message={body:job,ack(){ack++},retry(){retry++}};
      await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});
      if(mode==='send-fails'){assert.equal(ack,0);assert.equal(retry,1);assert.equal(sent.length,0);}
      else{assert.equal(ack,1);assert.equal(retry,0);assert.deepEqual(sent,[{body:job,options:{delaySeconds:30}}]);}
      assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job_queue'").get().status,'PENDING');
    }finally{h.close()}
  }
});

test('a review outcome is recorded as an open failed job and is not retried blindly',async()=>{
  const h=ownerOrderFixture(),original=sync.syncJob;try{
    sync.syncJob=async()=> 'REVIEW';let acked=0,retried=0;
    const job={kind:'SHEETS_SYNC',entityType:'EXPENSE_CORRECTION',entityKey:'exp_queue',entityVersion:2,traceId:'synthetic_review'},message={body:job,ack(){acked++},retry(){retried++}};
    await worker.queue({queue:'malipang-jobs',messages:[message]},h.env,{});
    assert.equal(acked,1);assert.equal(retried,0);const failed=h.sqlite.prepare('SELECT status,error FROM failed_jobs').get();assert.equal(failed.status,'OPEN');assert.equal(failed.error,'CORRECTION_REVIEW_REQUIRED');
  }finally{sync.syncJob=original;h.close()}
});
