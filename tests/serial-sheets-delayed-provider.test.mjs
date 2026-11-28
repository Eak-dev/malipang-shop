import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {runNormalPilot} from '../scripts/prod-normal-queue-pilot.mjs';

const require=createRequire(import.meta.url);
const first='10000000-1111-2222-3333-444444444444';
const successor='20000000-1111-2222-3333-444444444444';
const fixture=fileURLToPath(new URL('./insert-daily-writer.test.mjs',import.meta.url));

async function waitForProviderAcceptance(child) {
 return new Promise((resolve,reject)=>{
  let output='';
  const record=chunk=>{output=(output+chunk).slice(-3000);};
  // Keep child TAP distinguishable from failures emitted by this test runner.
  const diagnostics=()=>output.trimEnd().split(/\r?\n/).map(line=>`worker: ${line}`).join('\n');
  const exit=(code,signal)=>done(Error(`worker exited before provider acceptance: ${code}/${signal}\n${diagnostics()}`));
  const message=data=>done(null,data);
  const timer=setTimeout(()=>done(Error(`provider acceptance timed out\n${diagnostics()}`)),90000);
  function done(error,data){
   clearTimeout(timer);child.off('exit',exit);child.off('error',done);child.off('message',message);
   child.stdout.off('data',record);child.stderr.off('data',record);
   if(error)reject(error);else resolve(data);
  }
  child.stdout.on('data',record);
  child.stderr.on('data',record);child.once('exit',exit);child.once('error',done);child.once('message',message);
 });
}

for(const [name,pattern,chain] of [
 ['B has no successor yet','with round evidence worker-mock close verified-two',[first]],
 ['C was already reserved','with round evidence worker-mock close raw-lost',[first,successor]],
])test(`delayed RAW provider commit after Worker death preserves OPEN round when ${name}`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'mp348-delayed-provider-'));
 const env={...process.env,ISSUE348_KILL_D1_DIR:dir,ISSUE348_DELAY_RAW_COMMIT:'true'};
 delete env.NODE_TEST_CONTEXT; // IPC carries only the provider message, not outer test-runner events.
 const child=spawn(process.execPath,['--test-force-exit',`--test-name-pattern=${pattern}`,fixture],{
  env,detached:true,stdio:['ignore','pipe','pipe','ipc'],
 });
 const originalFetch=globalThis.fetch;
 let mf;
 try {
  const accepted=await waitForProviderAcceptance(child);
  assert.equal(accepted.cut,'provider-accepted-before-commit');
  assert.equal(accepted.jobId,chain.at(-1));
  // The parent models the provider and owns the accepted request. Killing the
  // sender cannot cancel this exact one-cell compare-and-replace.
  const {job,jobId,roundId,replacement,previousCell}=accepted;
  let cell=previousCell, commits=0,restartedRequests=0;
  const applyAcceptedRequest=()=>{
   if(cell!==replacement.find)return;
   cell=replacement.replacement;
   commits++;
  };
  const exited=once(child,'exit');
  process.kill(-child.pid,'SIGKILL');
  assert.deepEqual(await exited,[null,'SIGKILL']);

  mf=new Miniflare({modules:true,d1Databases:{DB:'fixture'},d1Persist:dir,
   script:'export default {async fetch(_r,e){await e.DB.prepare("SELECT 1").first();return new Response("ok")}}'});
  const db=await mf.getD1Database('DB');
  const snapshot=async()=>{
   const rows=await db.batch([
    db.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').bind(roundId),
    db.prepare("SELECT operation_token,state,phase FROM stable_workbook_claims WHERE spreadsheet_id='book'"),
    db.prepare("SELECT operation_token,state FROM stable_projection_writes WHERE spreadsheet_id='book' AND entity_id=? AND projection='EXPENSE_RAW'").bind(job.entityKey),
    db.prepare("SELECT job_id,status,last_error FROM sync_jobs WHERE job_id IN (?,?) ORDER BY job_id").bind(first,successor),
    db.prepare('SELECT count(*) AS n FROM serial_pilot_round_results WHERE round_id=?').bind(roundId),
    db.prepare("SELECT count(*) AS n FROM admin_audit WHERE action='ISSUE296_SERIAL_EXPENSE_HANDOVER' AND json_extract(after_json,'$.roundId')=?").bind(roundId),
    db.prepare("SELECT epoch_id,state FROM stable_recovery_epochs WHERE state='ARMED' ORDER BY epoch_id"),
   ]);
   return rows.map(x=>x.results);
  };
  const before=await snapshot();
  assert.deepEqual(before[0],[{state:'OPEN'}]);
  assert.equal(before[1].length,1);
  assert.deepEqual(before[2],[{operation_token:before[1][0].operation_token,state:'IN_FLIGHT'}]);
  assert.equal(before[3].find(x=>x.job_id===jobId)?.status,'PROCESSING');
  if(chain.length===1)assert.equal(before[3].find(x=>x.job_id===successor)?.status,'PENDING');
  assert.deepEqual(before[4],[{n:0}]);
  assert.deepEqual(before[5],[{n:chain.length-1}]);
  assert.equal(before[6].length,1);

  const originalVersion=accepted.env.CF_VERSION_METADATA.id;
  const currentVersion='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  assert.notEqual(currentVersion,originalVersion);
  const secret='a'.repeat(40),worker=require('../dist/index.js').default,queueSends=[];
  const restarted={...accepted.env,DB:db,ADMIN_TOKEN:secret,CF_VERSION_METADATA:{id:currentVersion},
   LINE_CHANNEL_SECRET:'local',LINE_CHANNEL_ACCESS_TOKEN:'local',LINE_OWNER_USER_ID:'U'+'a'.repeat(32),
   GOOGLE_SERVICE_ACCOUNT_EMAIL:'local@example.invalid',GOOGLE_PRIVATE_KEY_BASE64:'local',
   STABLE_REDRIVE_HOLD_ENABLED:'true',JOB_QUEUE:{async send(body,options){queueSends.push({body,options});}}};
  const sha='a'.repeat(40),runner={GITHUB_SHA:sha,EXPECTED_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',
   PILOT_PHASE:'RECOVER_ROUND',PILOT_ROUND_ID:roundId,MALIPANG_WORKER_URL:'https://synthetic.invalid/',
   EXPECTED_WORKER_VERSION_SHA256:createHash('sha256').update(currentVersion).digest('hex'),
   CLOUDFLARE_ACCOUNT_ID:'local',CLOUDFLARE_API_TOKEN:'local',MALIPANG_ADMIN_TOKEN:secret};
  const actions=[],workerResponses=[];
  const fetcher=async(input,opts)=>{
   const url=new URL(input);
   if(url.hostname==='api.cloudflare.com'){
    assert.equal(opts.method,'GET');assert.match(url.pathname,/\/deployments$/);
    return Response.json({success:true,result:{deployments:[{versions:[{version_id:currentVersion,percentage:100}]}]}});
   }
   assert.equal(url.origin,'https://synthetic.invalid');
   assert.equal(url.pathname,'/admin/stable-sync/serial-round-recovery');
   const action=JSON.parse(opts.body);actions.push(action);
   const response=await worker.fetch(new Request(input,opts),restarted,{});
   workerResponses.push({status:response.status,body:await response.clone().json()});
   return response;
  };
  const recover=()=>assert.rejects(runNormalPilot(runner,fetcher),error=>{
   assert.equal(error.message,'PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION',JSON.stringify(workerResponses));
   assert.deepEqual(error.serialProgress.reservationChain,{jobIds:chain,workerVersion:originalVersion});
   assert.equal(error.serialProgress.jobs[0].successorJobId,chain[1]??null);
   assert.equal(error.serialProgress.jobs.find(x=>x.jobId===jobId)?.unresolvedStages,1);
   return true;
  });
  globalThis.fetch=async()=>{restartedRequests++;throw Error('unexpected provider request after Worker restart');};
  assert.equal(cell,replacement.find,'the accepted request has not written the carrier');
  await Promise.all([recover(),recover()]);
  assert.deepEqual(await snapshot(),before);
  // Advance the lease clock only in this persisted synthetic D1. Restore
  // the immutability guard in the same transaction, as in the crash suite.
  const {sql}=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_job_provenance_update_guard'").first();
  assert.ok(sql);
  await db.batch([db.prepare('DROP TRIGGER serial_job_provenance_update_guard'),
   db.prepare("UPDATE sync_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE job_id=?").bind(jobId),db.prepare(sql)]);
  let acks=0;
  await worker.queue({queue:'malipang-jobs',messages:[{body:job,attempts:2,ack(){acks++;},retry(){assert.fail('unexpected retry');}}]},restarted,{});
  assert.equal(acks,1);
  assert.equal(cell,previousCell);
  assert.equal(restartedRequests,0);
  const afterRedelivery=await snapshot();
  for(const section of [0,1,2,4,5,6])assert.deepEqual(afterRedelivery[section],before[section]);
  const replayedJob=afterRedelivery[3].find(x=>x.job_id===jobId);
  if(chain.length===1){
   assert.equal(afterRedelivery[3].find(x=>x.job_id===successor)?.status,'PENDING');
   assert.equal(replayedJob?.status,'PROCESSING');
   assert.equal(queueSends.length,1,'current B path may defer the same message');
   assert.deepEqual(queueSends[0].body,job);
   assert.ok(queueSends[0].options?.delaySeconds>0);
  } else {
   assert.equal(replayedJob?.status,'REVIEW');
   assert.equal(replayedJob?.last_error,'SERIAL_EXPIRED_PROVIDER_UNCERTAIN');
   assert.deepEqual(queueSends,[],'the held C does not re-enqueue');
  }
  applyAcceptedRequest();
  assert.equal(cell,replacement.replacement);
  assert.equal(commits,1);
  await recover();
  assert.equal(restartedRequests,0);
  assert.deepEqual(actions,Array.from({length:3},()=>({action:'READ',roundId})));
  assert.deepEqual(await snapshot(),afterRedelivery,'a late provider commit supplies no D1 transition or successor by itself');
 } finally {
  globalThis.fetch=originalFetch;
  if(child.exitCode===null&&child.signalCode===null){
   const exited=once(child,'exit');
   try{process.kill(-child.pid,'SIGKILL');await exited;}catch{}
  }
  try{if(mf)await mf.dispose();}finally{rmSync(dir,{recursive:true,force:true});}
 }
});
