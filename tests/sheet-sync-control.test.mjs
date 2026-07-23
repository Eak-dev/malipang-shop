import test from 'node:test';
import assert from 'node:assert/strict';
import {isRecoverableSheetJob,recoverPendingSheetJobs} from '../dist/db/repositories.js';
import {claimSheetSyncJob} from '../dist/sheets/sync.js';

const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_lease',entityVersion:1,traceId:'lease_test'};

test('recovery ignores delayed jobs until eligible and only recovers expired leases',()=>{
  const now='2026-07-23T12:10:00.000Z',stale='2026-07-23T12:05:00.000Z';
  assert.equal(isRecoverableSheetJob({status:'PENDING',updated_at:'2026-07-23T12:00:00.000Z',next_attempt_at:'2026-07-23T12:11:00.000Z',lease_until:null},now,stale),false);
  assert.equal(isRecoverableSheetJob({status:'FAILED',updated_at:'2026-07-23T12:00:00.000Z',next_attempt_at:'2026-07-23T12:09:00.000Z',lease_until:null},now,stale),true);
  assert.equal(isRecoverableSheetJob({status:'PROCESSING',updated_at:'2026-07-23T11:00:00.000Z',next_attempt_at:null,lease_until:'2026-07-23T12:11:00.000Z'},now,stale),false);
  assert.equal(isRecoverableSheetJob({status:'PROCESSING',updated_at:'2026-07-23T12:09:00.000Z',next_attempt_at:null,lease_until:'2026-07-23T12:09:59.000Z'},now,stale),true);
});

test('cron recovery does not enqueue a job whose queue delay is still active',async()=>{
  const future=new Date(Date.now()+60_000).toISOString(),old=new Date(Date.now()-600_000).toISOString(),sent=[];
  const rows=[
    {entity_type:'EXPENSE',entity_key:'delayed',entity_version:1,trace_id:'t1',status:'PENDING',updated_at:old,next_attempt_at:future,lease_until:null},
    {entity_type:'EXPENSE',entity_key:'ready',entity_version:1,trace_id:'t2',status:'FAILED',updated_at:old,next_attempt_at:old,lease_until:null}
  ];
  const env={SHEETS_SYNC_ENABLED:'true',DB:{prepare(sql){return{bind(){return this;},async all(){assert.match(sql,/next_attempt_at/);return{results:rows};},async run(){return{meta:{changes:1}};}};}},JOB_QUEUE:{async sendBatch(messages){sent.push(...messages);}}};
  assert.equal(await recoverPendingSheetJobs(env,300),1);
  assert.equal(sent.length,1);
  assert.equal(sent[0].body.entityKey,'ready');
});

test('only one concurrent worker can claim the same sync job lease',async()=>{
  let state={status:'PENDING',nextAttemptAt:'2026-07-23T11:00:00.000Z',leaseUntil:null,leaseToken:null};
  const env={DB:{prepare(sql){
    let args=[];
    return{
      bind(...values){args=values;return this;},
      async run(){
        if(sql.startsWith('INSERT INTO sync_jobs'))return{meta:{changes:0}};
        assert.match(sql,/lease_token/);
        assert.doesNotMatch(sql,/status!='COMPLETED'/);
        const now=args[0],eligible=(state.status==='PENDING'||state.status==='FAILED')&&(!state.nextAttemptAt||state.nextAttemptAt<=now)||(state.status==='PROCESSING'&&state.leaseUntil!=null&&state.leaseUntil<=now);
        if(!eligible)return{meta:{changes:0}};
        state={status:'PROCESSING',nextAttemptAt:null,leaseUntil:args[1],leaseToken:args[2]};
        return{meta:{changes:1}};
      }
    };
  }}};
  const now=Date.parse('2026-07-23T12:00:00.000Z');
  const claims=await Promise.all([claimSheetSyncJob(env,job,now),claimSheetSyncJob(env,job,now)]);
  assert.equal(claims.filter(Boolean).length,1);
  assert.equal(state.status,'PROCESSING');
});
