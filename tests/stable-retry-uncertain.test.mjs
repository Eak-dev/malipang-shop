import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const {recoverPendingSheetJobs}=require('../dist/db/repositories.js');
const {claimSheetSyncJob}=require('../dist/sheets/sync.js');

test('stable recovery holds uncertain failures and expired leases but sends ordinary pending work',async()=>{
 const h=expenseSqlite();try{
  h.env.STABLE_PHASE1_ENABLED='true';h.env.GOOGLE_SPREADSHEET_ID='book';
  const insert=h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,last_error,lease_until,lease_token) VALUES(?,'DAILY_PAYROLL',?,1,'trace',?,1,'2020-01-01T00:00:00.000Z',?,?,?)");
  insert.run('p','pending','PENDING',null,null,null);
  insert.run('f','failed','FAILED','unknown Sheets result',null,null);
  insert.run('e','expired','PROCESSING',null,'2020-01-01T00:01:00.000Z','expired-lease');
  insert.run('a','active','PROCESSING',null,'2999-01-01T00:01:00.000Z','active-lease');
  insert.run('t','terminal','FAILED','terminal',null,null);
  h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('dlq','malipang-jobs','trace','DAILY_PAYROLL:terminal:1','{}','DEAD_LETTER_MAX_RETRIES','OPEN',1,'2020','2020')").run();
  const job=entityKey=>({kind:'SHEETS_SYNC',entityType:'DAILY_PAYROLL',entityKey,entityVersion:1,traceId:'trace'});
  // An already delivered queue message cannot race ahead of scheduled recovery.
  assert.equal(await claimSheetSyncJob(h.env,job('failed')),null);
  assert.equal(await claimSheetSyncJob(h.env,job('expired')),null);
  assert.equal(await recoverPendingSheetJobs(h.env,300,true),1);
  assert.deepEqual(h.queue.map(x=>x.body.entityKey),['pending']);
  const get=key=>h.sqlite.prepare('SELECT status,last_error,lease_token FROM sync_jobs WHERE entity_key=?').get(key);
  assert.deepEqual({...get('failed')},{status:'REVIEW',last_error:'unknown Sheets result',lease_token:null});
  assert.deepEqual({...get('expired')},{status:'REVIEW',last_error:'STABLE_REDRIVE_UNCERTAIN',lease_token:null});
  assert.equal(get('active').status,'PROCESSING');
  assert.equal(get('terminal').status,'FAILED');
  assert.ok(await claimSheetSyncJob(h.env,job('pending')));
 }finally{h.close();}
});

test('legacy mode keeps existing failed and expired lease recovery behavior',async()=>{
 const h=expenseSqlite();try{
  const insert=h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES(?,'DAILY_PAYROLL',?,1,'trace',?,1,'2020-01-01T00:00:00.000Z',?,?)");
  insert.run('f','failed','FAILED',null,null);
  insert.run('e','expired','PROCESSING','2020-01-01T00:01:00.000Z','expired-lease');
  assert.equal(await recoverPendingSheetJobs(h.env,300),2);
  assert.deepEqual(h.queue.map(x=>x.body.entityKey).sort(),['expired','failed']);
 }finally{h.close();}
});
