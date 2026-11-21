import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url);
const {holdStableSyncJob}=require('../dist/sheets/stable-phase1-dispatch.js');
const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'synthetic',entityVersion:1,traceId:'fixture'};

test('hold accepts one returned job even when alert trigger adds changes; stale lease fails',async()=>{
 const h=expenseSqlite();
 try{
  h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_token,lease_until) VALUES('test-job','EXPENSE','synthetic',1,'fixture','PROCESSING',1,'before','lease','2099-01-01')");
  const prepare=h.DB.prepare.bind(h.DB);
  h.DB.prepare=sql=>{const s=prepare(sql),all=s.all.bind(s);s.all=async()=>({...await all(),success:true,meta:{changes:2}});return s;};
  await assert.rejects(holdStableSyncJob(h.env,job,'wrong','STABLE_SYNC_REVIEW'),/STABLE_JOB_HOLD_UNCERTAIN/);
  assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='test-job'").get().status,'PROCESSING');
  await holdStableSyncJob(h.env,job,'lease','STABLE_SYNC_REVIEW');
  const row=h.sqlite.prepare("SELECT status,lease_token,last_error FROM sync_jobs WHERE job_id='test-job'").get();
  assert.equal(row.status,'REVIEW');assert.equal(row.lease_token,null);assert.equal(row.last_error,'STABLE_SYNC_REVIEW');
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_alert_incidents WHERE kind='JOB' AND source_id='test-job' AND state='OPEN'").get().n,1);
  await assert.rejects(holdStableSyncJob(h.env,job,'lease','STABLE_SYNC_REVIEW'),/STABLE_JOB_HOLD_UNCERTAIN/);
 }finally{h.close();}
});

test('malformed, failed and lost acknowledgements never report success',async()=>{
 for(const response of [{success:false,results:[{job_id:'one'}]}, {success:true,results:[]}, {success:true,results:[{job_id:'one'},{job_id:'two'}]}, {success:true,results:[{}]}]){
  const env={DB:{prepare(){return{bind(){return{async all(){return response;}}}}}}};
  await assert.rejects(holdStableSyncJob(env,job,'lease','STABLE_SYNC_REVIEW'),/STABLE_JOB_HOLD_UNCERTAIN/);
 }
 const env={DB:{prepare(){return{bind(){return{async all(){throw Error('lost response');}}}}}}};
 await assert.rejects(holdStableSyncJob(env,job,'lease','STABLE_SYNC_REVIEW'),/lost response/);
});
