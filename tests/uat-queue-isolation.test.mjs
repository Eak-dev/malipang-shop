import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
const require=createRequire(import.meta.url),{resolveQueueNames,classifyQueue,LOGICAL_JOB_QUEUE_NAME}=require('../dist/shared/queue-names.js'),worker=require('../dist/index.js').default,sync=require('../dist/sheets/sync.js'),line=require('../dist/line/api.js');
const uat={APP_ENV:'uat',JOB_QUEUE_NAME:'malipang-jobs-uat',JOB_DLQ_NAME:'malipang-jobs-uat-dlq'};
const job={kind:'SHEETS_SYNC',entityType:'EXPENSE_CORRECTION',entityKey:'exp_uat_synthetic',entityVersion:2,traceId:'trace_uat_synthetic'};
const msg=()=>{const counts={ack:0,retry:0};return {counts,message:{body:job,ack(){counts.ack++},retry(){counts.retry++}}}};

test('queue names default only for production and classify both UAT queues',()=>{
  assert.deepEqual(resolveQueueNames({APP_ENV:'production'}),{job:'malipang-jobs',dlq:'malipang-jobs-dlq'});
  assert.equal(resolveQueueNames({}),null);
  assert.equal(classifyQueue(uat,'malipang-jobs-uat'),'JOB');assert.equal(classifyQueue(uat,'malipang-jobs-uat-dlq'),'DLQ');
  assert.equal(classifyQueue(uat,'malipang-jobs'),null);assert.equal(LOGICAL_JOB_QUEUE_NAME,'malipang-jobs');
  for(const env of [{APP_ENV:'uat'},{...uat,APP_ENV:undefined},{...uat,APP_ENV:''},{...uat,JOB_QUEUE_NAME:undefined},{...uat,JOB_DLQ_NAME:''},{...uat,JOB_DLQ_NAME:uat.JOB_QUEUE_NAME},{...uat,JOB_QUEUE_NAME:'malipang-jobs'},{...uat,JOB_DLQ_NAME:'malipang-jobs-dlq'},{...uat,JOB_QUEUE_NAME:'bad/name'},{...uat,JOB_QUEUE_NAME:' UAT'}])assert.equal(resolveQueueNames(env),null,JSON.stringify(env));
});
test('invalid configuration and unknown queues retry without processing or acknowledgments',async()=>{
  const h=ownerOrderFixture(),old=sync.syncJob;let calls=0;try{
    sync.syncJob=async()=>{calls++;return 'PROCESSED'};
    for(const [settings,queue] of [[{APP_ENV:'uat'},'malipang-jobs'],[uat,'other-queue'],[{...uat,JOB_DLQ_NAME:'malipang-jobs-uat'},'malipang-jobs-uat']]){
      Object.assign(h.env,settings);if(!Object.hasOwn(settings,'JOB_QUEUE_NAME'))delete h.env.JOB_QUEUE_NAME;if(!Object.hasOwn(settings,'JOB_DLQ_NAME'))delete h.env.JOB_DLQ_NAME;
      const x=msg();await worker.queue({queue,messages:[x.message]},h.env,{});assert.deepEqual(x.counts,{ack:0,retry:1});
    }
    assert.equal(calls,0);assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM failed_jobs').get().n,0);
  }finally{sync.syncJob=old;h.close()}
});
test('isolated UAT DLQ records the logical queue and does not execute the job',async()=>{
  const h=ownerOrderFixture(),oldSync=sync.syncJob,oldAlert=line.pushOwnerAlert;let executed=0,alerts=0;try{
    Object.assign(h.env,uat);sync.syncJob=async()=>{executed++;return 'PROCESSED'};line.pushOwnerAlert=async()=>{alerts++};
    const x=msg();await worker.queue({queue:uat.JOB_DLQ_NAME,messages:[x.message]},h.env,{});
    assert.deepEqual(x.counts,{ack:1,retry:0});assert.equal(executed,0);assert.equal(alerts,1);
    const row=h.sqlite.prepare('SELECT queue_name,status,error FROM failed_jobs').get();assert.equal(row.queue_name,LOGICAL_JOB_QUEUE_NAME);assert.equal(row.status,'OPEN');assert.equal(row.error,'DEAD_LETTER_MAX_RETRIES');
  }finally{sync.syncJob=oldSync;line.pushOwnerAlert=oldAlert;h.close()}
});
test('UAT job failures and success use the same logical key for safe recovery',async()=>{
  const h=ownerOrderFixture(),old=sync.syncJob;try{
    Object.assign(h.env,uat);sync.syncJob=async()=>{throw Error('synthetic failure')};const first=msg();await worker.queue({queue:uat.JOB_QUEUE_NAME,messages:[first.message]},h.env,{});
    assert.deepEqual(first.counts,{ack:0,retry:1});let row=h.sqlite.prepare('SELECT queue_name,status FROM failed_jobs').get();assert.equal(row.queue_name,LOGICAL_JOB_QUEUE_NAME);assert.equal(row.status,'OPEN');
    sync.syncJob=async()=> 'PROCESSED';const second=msg();await worker.queue({queue:uat.JOB_QUEUE_NAME,messages:[second.message]},h.env,{});
    assert.deepEqual(second.counts,{ack:1,retry:0});row=h.sqlite.prepare('SELECT queue_name,status FROM failed_jobs').get();assert.equal(row.queue_name,LOGICAL_JOB_QUEUE_NAME);assert.equal(row.status,'RESOLVED');
  }finally{sync.syncJob=old;h.close()}
});
