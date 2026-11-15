import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const {enqueueSheetSyncBatch}=createRequire(import.meta.url)('../dist/db/repositories.js');

test('forced reconciliation never queues expenses, including unseen versions and terminal jobs',async()=>{
 const h=expenseSqlite();try{
  const insert=h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,last_error,lease_until,lease_token) VALUES(?,'EXPENSE',?,1,'original',?,2,'2026-01-01T00:00:00.000Z',?,?,?)");
  insert.run('r','review','REVIEW','uncertain',null,null);
  insert.run('p','processing','PROCESSING','uncertain','2026-01-01T00:00:00.000Z','old-lease');
  insert.run('t','terminal','PENDING','keep-terminal',null,null);
  insert.run('u','uncertain','FAILED','Google Sheets mutation outcome unknown',null,null);
  insert.run('o','ordinary','PENDING','retryable',null,null);
  insert.run('c','complete','COMPLETED',null,null,null);
  h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('nonfinancial','DAILY_PAYROLL','daily',1,'original','PENDING',0,'2026-01-01T00:00:00.000Z')").run();
  h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','projection-only','DAILY',1,'daily',1,?,'op','IN_FLIGHT','now')").run('a'.repeat(64));
  const failed=h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES(?,'malipang-jobs',?,?, '{}','DEAD_LETTER_MAX_RETRIES','OPEN',1,'now','now')");
  failed.run('f1','trace1','EXPENSE:terminal:1');
  failed.run('f2','trace2','EXPENSE:missing-terminal:1');
  const jobs=['review','processing','terminal','missing-terminal','uncertain','ordinary','complete','new'].map(entityKey=>({kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey,entityVersion:1,traceId:'new-trace'}));
  jobs.push({kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'complete',entityVersion:2,traceId:'new-trace'});
  jobs.push({kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'projection-only',entityVersion:2,traceId:'new-trace'});
  jobs.push({kind:'SHEETS_SYNC',entityType:'DAILY_PAYROLL',entityKey:'daily',entityVersion:1,traceId:'new-trace'});
  assert.equal(await enqueueSheetSyncBatch(h.env,jobs,true),1);
  assert.deepEqual(h.queue.map(x=>x.body.entityKey),['daily']);
  const get=key=>h.sqlite.prepare('SELECT status,last_error,trace_id,lease_token FROM sync_jobs WHERE entity_key=?').get(key);
  assert.deepEqual({...get('review')},{status:'REVIEW',last_error:'uncertain',trace_id:'original',lease_token:null});
  assert.deepEqual({...get('processing')},{status:'PROCESSING',last_error:'uncertain',trace_id:'original',lease_token:'old-lease'});
  assert.deepEqual({...get('terminal')},{status:'PENDING',last_error:'keep-terminal',trace_id:'original',lease_token:null});
  assert.deepEqual({...get('uncertain')},{status:'FAILED',last_error:'Google Sheets mutation outcome unknown',trace_id:'original',lease_token:null});
  assert.equal(get('missing-terminal'),undefined);
  assert.equal(get('new'),undefined);
  assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key='projection-only'").get(),undefined);
  assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key='complete' AND entity_version=2").get(),undefined);
  assert.deepEqual({...get('ordinary')},{status:'PENDING',last_error:'retryable',trace_id:'original',lease_token:null});
  assert.deepEqual({...get('complete')},{status:'COMPLETED',last_error:null,trace_id:'original',lease_token:null});
  assert.equal(h.sqlite.prepare("SELECT trace_id FROM sync_jobs WHERE entity_type='DAILY_PAYROLL' AND entity_key='daily'").get().trace_id,'new-trace');
 }finally{h.close();}
});
