import test from 'node:test';
import assert from 'node:assert/strict';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {createFailedJob,enqueueSheetSyncBatchDetailed,recoverPendingSheetJobs} from '../dist/db/repositories.js';
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
    assert.deepEqual(rows,[{entity_version:1,status:'FAILED',trace_id:first.traceId,last_error:'old failure'},{entity_version:2,status:'PENDING',trace_id:newer.traceId,last_error:null}]);
    h.sqlite.prepare(`UPDATE sync_jobs SET status='COMPLETED' WHERE entity_key='expense_b'`).run();
    h.sqlite.prepare(`UPDATE sync_jobs SET updated_at=?,next_attempt_at=? WHERE entity_key='expense_a'`).run(old,old);
    assert.equal(await recoverPendingSheetJobs(h.env,0,true),0,'legacy override cannot revive either version');
    assert.equal(h.queue.length,1);
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
