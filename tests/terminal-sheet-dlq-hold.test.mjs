import test from 'node:test';
import assert from 'node:assert/strict';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {createFailedJob,resolveFailedJobs,enqueueSheetSyncBatchDetailed,recoverPendingSheetJobs} from '../dist/db/repositories.js';
import {syncJob} from '../dist/sheets/sync.js';
import {handleAdmin} from '../dist/admin/handler.js';
import {createRequire} from 'node:module';
const worker=createRequire(import.meta.url)('../dist/index.js').default;

const job=(id,version=1)=>({kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:id,entityVersion:version,traceId:`trace_${id}_${version}`});
const old='2000-01-01T00:00:00.000Z';
async function seed(h,id='expense_a'){
  const original=job(id);
  h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,last_error,updated_at,next_attempt_at) VALUES(?,'EXPENSE',?,1,?,'FAILED',6,'old failure',?,?)`).run(`job_${id}`,id,original.traceId,old,old);
  await createFailedJob(h.env,'malipang-jobs',original.traceId,original,'DEAD_LETTER_MAX_RETRIES');
  return original;
}

test('terminal DLQ holds same and newer expense versions through forced admin reconcile and recovery',async()=>{
  const h=expenseSqlite();try{
    const first=await seed(h),newer=job('expense_a',2),other=job('expense_b');
    const result=await enqueueSheetSyncBatchDetailed(h.env,[first,newer,other],true);
    assert.deepEqual(result,{enqueued:1,held:2,disabled:0});
    assert.deepEqual(h.queue.map(x=>x.body.entityKey),['expense_b']);
    const rows=h.sqlite.prepare(`SELECT entity_version,status,trace_id,last_error FROM sync_jobs WHERE entity_key='expense_a' ORDER BY entity_version`).all().map(x=>({...x}));
    assert.deepEqual(rows,[{entity_version:1,status:'REVIEW',trace_id:first.traceId,last_error:'SHEET_SYNC_TERMINAL_DLQ_REVIEW_REQUIRED'},{entity_version:2,status:'REVIEW',trace_id:newer.traceId,last_error:'SHEET_SYNC_TERMINAL_DLQ_REVIEW_REQUIRED'}]);
    h.sqlite.prepare(`UPDATE sync_jobs SET status='COMPLETED' WHERE entity_key='expense_b'`).run();
    h.sqlite.prepare(`UPDATE sync_jobs SET updated_at=?,next_attempt_at=? WHERE entity_key='expense_a'`).run(old,old);
    assert.equal(await recoverPendingSheetJobs(h.env,0,true),0,'legacy override cannot revive either version');
    assert.equal(h.queue.length,1);
    h.sqlite.prepare(`UPDATE failed_jobs SET status='RESOLVED' WHERE job_key=?`).run('EXPENSE:expense_a:1');
    assert.equal(await recoverPendingSheetJobs(h.env,0,true),0,'resolved DLQ alone cannot release persistent review');
    assert.equal((await enqueueSheetSyncBatchDetailed(h.env,[newer],true)).held,1);
  }finally{h.close();}
});

test('already queued same or newer versions cannot claim or clear terminal DLQ evidence',async()=>{
  const h=expenseSqlite();try{
    const first=await seed(h);
    assert.equal(await syncJob(h.env,first),'TERMINAL_HOLD');
    assert.equal(await syncJob(h.env,job('expense_a',2)),'TERMINAL_HOLD');
    let acknowledged=0;
    await worker.queue({queue:'malipang-jobs',messages:[{body:first,attempts:1,ack(){acknowledged++},retry(){assert.fail('held job should not retry')}}]},h.env,{});
    assert.equal(acknowledged,1);
    const failure=h.sqlite.prepare(`SELECT status,error,attempt_count FROM failed_jobs WHERE job_key=?`).get('EXPENSE:expense_a:1');
    assert.deepEqual({...failure},{status:'OPEN',error:'DEAD_LETTER_MAX_RETRIES',attempt_count:1});
    assert.equal(h.sqlite.prepare(`SELECT COUNT(*) n FROM sync_jobs WHERE status='PROCESSING'`).get().n,0);
    h.sqlite.prepare(`UPDATE failed_jobs SET status='RESOLVED' WHERE job_key=?`).run('EXPENSE:expense_a:1');
    assert.equal(await syncJob(h.env,job('expense_a',2)),'TERMINAL_HOLD','review survives DLQ resolution');
    assert.equal(await recoverPendingSheetJobs(h.env,0,true),0);
  }finally{h.close();}
});

test('disabled sync persists terminal quarantine and does not resolve failed-job evidence',async()=>{
  const h=expenseSqlite();try{
    const first=await seed(h);h.env.SHEETS_SYNC_ENABLED='false';let acknowledged=0;
    await worker.queue({queue:'malipang-jobs',messages:[{body:first,attempts:1,ack(){acknowledged++},retry(){assert.fail('disabled message should be acknowledged')}}]},h.env,{});
    assert.equal(acknowledged,1);
    assert.deepEqual({...h.sqlite.prepare(`SELECT status,error FROM failed_jobs WHERE job_key=?`).get('EXPENSE:expense_a:1')},{status:'OPEN',error:'DEAD_LETTER_MAX_RETRIES'});
    assert.equal(h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_key='expense_a'`).get().status,'REVIEW');
    h.sqlite.prepare(`UPDATE failed_jobs SET status='RESOLVED' WHERE job_key=?`).run('EXPENSE:expense_a:1');h.env.SHEETS_SYNC_ENABLED='true';
    assert.equal(await recoverPendingSheetJobs(h.env,0,true),0);
  }finally{h.close();}
});

test('disabled sync retains ordinary failed outbox and can recover it after transport resumes',async()=>{
  const h=expenseSqlite();try{
    const first=await seed(h);h.sqlite.prepare(`UPDATE failed_jobs SET error='temporary' WHERE job_key=?`).run('EXPENSE:expense_a:1');h.sqlite.prepare(`UPDATE sync_jobs SET status='FAILED',updated_at=?,next_attempt_at=? WHERE entity_key='expense_a'`).run(old,old);h.env.SHEETS_SYNC_ENABLED='false';let acknowledged=0;
    await worker.queue({queue:'malipang-jobs',messages:[{body:first,attempts:1,ack(){acknowledged++},retry(){assert.fail('disabled message should be acknowledged')}}]},h.env,{});
    assert.equal(acknowledged,1);assert.equal(h.sqlite.prepare(`SELECT status FROM failed_jobs WHERE job_key=?`).get('EXPENSE:expense_a:1').status,'OPEN');
    assert.equal(h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_key='expense_a'`).get().status,'FAILED');
    h.env.SHEETS_SYNC_ENABLED='true';assert.equal(await recoverPendingSheetJobs(h.env,0),1);assert.equal(h.queue.length,1);
  }finally{h.close();}
});

test('late errors and success cannot overwrite or auto-resolve open terminal Sheet evidence',async()=>{
  const h=expenseSqlite();try{
    const first=await seed(h),before=h.sqlite.prepare(`SELECT payload_json FROM failed_jobs WHERE job_key=?`).get('EXPENSE:expense_a:1').payload_json;
    await createFailedJob(h.env,'malipang-jobs',first.traceId,{...first,extra:'late'},'late network error');
    await resolveFailedJobs(h.env,'malipang-jobs',first.traceId,first);
    const row=h.sqlite.prepare(`SELECT status,error,payload_json,attempt_count FROM failed_jobs WHERE job_key=?`).get('EXPENSE:expense_a:1');
    assert.deepEqual({...row},{status:'OPEN',error:'DEAD_LETTER_MAX_RETRIES',payload_json:before,attempt_count:2});
  }finally{h.close();}
});

test('non-forced enqueue quarantines new versions before a terminal record is resolved',async()=>{
  const h=expenseSqlite();try{
    await seed(h);const newer=job('expense_a',2);
    await enqueueSheetSyncBatchDetailed(h.env,[newer],false);
    h.sqlite.prepare(`UPDATE failed_jobs SET status='RESOLVED' WHERE job_key=?`).run('EXPENSE:expense_a:1');
    assert.equal(h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_key='expense_a' AND entity_version=2`).get().status,'REVIEW');
    assert.equal(await syncJob(h.env,newer),'TERMINAL_HOLD');assert.equal(await recoverPendingSheetJobs(h.env,0,true),0);
  }finally{h.close();}
});

test('opening terminal atomically quarantines pre-existing pending versions even if subsequently resolved',async()=>{
  const h=expenseSqlite();try{
    const newer=job('expense_a',2);
    h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at) VALUES('preexisting','EXPENSE','expense_a',2,?,'PENDING',0,?,?)`).run(newer.traceId,old,old);
    await seed(h);
    assert.equal(h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_key='expense_a' AND entity_version=2`).get().status,'REVIEW');
    h.sqlite.prepare(`UPDATE failed_jobs SET status='RESOLVED' WHERE job_key=?`).run('EXPENSE:expense_a:1');
    assert.equal(await recoverPendingSheetJobs(h.env,0,true),0);assert.equal(h.queue.length,0);
  }finally{h.close();}
});

test('recovery backfills a persistent review hold for terminal records predating rollout',async()=>{
  const h=expenseSqlite();try{
    const first=job('expense_a');
    h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at) VALUES('legacy_pending','EXPENSE','expense_a',2,?,'PENDING',0,?,?)`).run(first.traceId,old,old);
    h.sqlite.prepare(`INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('legacy_failure','malipang-jobs',?,?,?,'DEAD_LETTER_MAX_RETRIES','OPEN',1,?,?)`).run(first.traceId,'EXPENSE:expense_a:1',JSON.stringify(first),old,old);
    assert.equal(await recoverPendingSheetJobs(h.env,0,true),0);
    assert.equal(h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_key='expense_a'`).get().status,'REVIEW');
    h.sqlite.prepare(`UPDATE failed_jobs SET status='RESOLVED' WHERE job_key=?`).run('EXPENSE:expense_a:1');
    assert.equal(await recoverPendingSheetJobs(h.env,0,true),0);assert.equal(h.queue.length,0);
  }finally{h.close();}
});

test('opening terminal quarantines an in-flight job without pretending its dispatch was cancelled',async()=>{
  const h=expenseSqlite();try{
    const first=job('expense_a');
    h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('active','EXPENSE','expense_a',1,?,'PROCESSING',1,?,'2099-01-01T00:00:00.000Z','old-lease')`).run(first.traceId,old);
    await createFailedJob(h.env,'malipang-jobs',first.traceId,first,'DEAD_LETTER_MAX_RETRIES');
    const active=h.sqlite.prepare(`SELECT status,last_error FROM sync_jobs WHERE entity_key='expense_a'`).get();
    assert.deepEqual({...active},{status:'REVIEW',last_error:'SHEET_SYNC_TERMINAL_DLQ_REVIEW_REQUIRED'});
    await resolveFailedJobs(h.env,'malipang-jobs',first.traceId,first);
    assert.equal(h.sqlite.prepare(`SELECT status FROM failed_jobs WHERE job_key=?`).get('EXPENSE:expense_a:1').status,'OPEN');
  }finally{h.close();}
});

test('terminal and quarantine transaction rolls back together if quarantine fails',async()=>{
  const h=expenseSqlite();try{
    const first=job('expense_a');h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('active','EXPENSE','expense_a',1,?,'PROCESSING',0,?)`).run(first.traceId,old);
    h.DB.failAt=1;await assert.rejects(createFailedJob(h.env,'malipang-jobs',first.traceId,first,'DEAD_LETTER_MAX_RETRIES'),/fixture batch failure/);
    assert.equal(h.sqlite.prepare(`SELECT count(*) n FROM failed_jobs`).get().n,0);
    assert.equal(h.sqlite.prepare(`SELECT status FROM sync_jobs WHERE entity_key='expense_a'`).get().status,'PROCESSING');
  }finally{h.close();}
});

test('admin retry endpoint refuses a terminal override and reports review required',async()=>{
  const h=expenseSqlite();try{
    await seed(h);h.env.ADMIN_TOKEN='synthetic_admin_token_32_chars_only';
    const request=new Request('https://synthetic.invalid/admin/retry-sync',{method:'POST',headers:{authorization:`Bearer ${h.env.ADMIN_TOKEN}`,'content-type':'application/json'},body:JSON.stringify({staleAfterSeconds:0,includeTerminalDlq:true})});
    const response=await handleAdmin(request,h.env,{});
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true,enqueued:0,terminalDlq:'REVIEW_REQUIRED'});assert.equal(h.queue.length,0);
  }finally{h.close();}
});

test('terminal hold is scoped to the correct entity, not similar prefixes',async()=>{
  const h=expenseSqlite();try{
    await seed(h,'expense_a');
    const result=await enqueueSheetSyncBatchDetailed(h.env,[job('expense_ab')],true);
    assert.equal(result.enqueued,1);assert.equal(result.held,0);
  }finally{h.close();}
});
