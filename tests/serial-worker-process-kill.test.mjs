import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';

for(const [mode,projection,count] of [['postlost','DAILY',1],['raw-lost','EXPENSE_RAW',2],['detail-lost','DETAIL',3]])for(const workerVersion of ['same','new'])test(`SIGKILL after model ${projection} commit retains intent with ${workerVersion} Worker and never repeats the write`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'serial-worker-kill-')),state=join(dir,'provider.json');
 const child=spawn(process.execPath,[`--test-name-pattern=worker-mock close ${mode}`,fileURLToPath(new URL('./insert-daily-writer.test.mjs',import.meta.url))],{
  env:{...process.env,ISSUE348_KILL_D1_DIR:dir,ISSUE348_KILL_STATE_FILE:state},detached:true,stdio:['ignore','ignore','pipe','ipc']
 });
 let stderr='',mf,originalFetch=globalThis.fetch;child.stderr.on('data',data=>{stderr+=data.toString();});
 try{
  await new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('worker cut timed out: '+stderr.slice(-3000))),120000);
   child.once('message',message=>{clearTimeout(timer);message?.cut==='provider-committed'?resolve():reject(Error('unexpected cut'));});
   child.once('exit',(code,signal)=>{clearTimeout(timer);reject(Error(`worker exited before cut: ${code}/${signal} ${stderr.slice(-3000)}`));});
  });
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  process.kill(-child.pid,'SIGKILL');assert.equal((await exited).signal,'SIGKILL');
  const saved=JSON.parse(readFileSync(state,'utf8'));assert.equal(saved.posts,count);assert.ok(saved.formula.length>0);assert.ok(saved.effective.length>0);assert.ok(saved.raw.length>0);assert.ok(saved.detail.length>0);
  // D1 disallows integrity_check through its API; inspect the stopped local
  // SQLite file read-only before reopening it through Miniflare instead.
  const folder=join(dir,'miniflare-D1DatabaseObject'),file=readdirSync(folder).find(x=>x.endsWith('.sqlite'));assert.ok(file);
  const inspected=new DatabaseSync(join(folder,file),{readOnly:true});try{assert.equal(inspected.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{inspected.close();}
  mf=new Miniflare({modules:true,d1Databases:{DB:'fixture'},d1Persist:dir,script:'export default {async fetch(_r,e){await e.DB.prepare("SELECT 1").first();return new Response("ok")}}'});
  const db=await mf.getD1Database('DB');
  const claim=await db.prepare("SELECT state,phase,operation_token FROM stable_workbook_claims WHERE spreadsheet_id='book'").first();
  assert.ok(['HELD','REVIEW'].includes(claim?.state));
  const entity=projection==='DETAIL'?saved.job.entityKey+'|item_next':saved.job.entityKey;
  const intent=await db.prepare("SELECT state FROM stable_projection_writes WHERE spreadsheet_id='book' AND entity_id=? AND projection=?").bind(entity,projection).first();
  assert.ok(['IN_FLIGHT','REVIEW'].includes(intent?.state));
  let providerWrites=0;const queueSends=[];globalThis.fetch=async()=>{providerWrites++;throw Error('unexpected provider call after process death');};
  const env={...saved.env,DB:db,JOB_QUEUE:{async send(body,options){queueSends.push({body,options});},async sendBatch(messages){queueSends.push(...messages);}}};
  if(workerVersion==='new')env.CF_VERSION_METADATA={id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
  const worker=createRequire(import.meta.url)('../dist/index.js').default;
  const deliver=()=>worker.queue({queue:'malipang-jobs',messages:[{body:saved.job,attempts:2,ack(){},retry(){}}]},env,{});
  await deliver();
  // Simulate elapsed D1 time in this synthetic fixture while preserving the
  // original lease identity/generation and restoring its immutable guard in
  // the same batch; this is not a migration or production clock operation.
  const jobBefore=await db.prepare("SELECT lease_until,lease_token,serial_lease_generation FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=?").bind(saved.job.entityKey).first();
  assert.ok(jobBefore?.lease_until);
  const guard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_job_provenance_update_guard'").first();assert.ok(guard?.sql);
  await db.batch([db.prepare('DROP TRIGGER serial_job_provenance_update_guard'),db.prepare("UPDATE sync_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE entity_type='EXPENSE' AND entity_key=?").bind(saved.job.entityKey),db.prepare(guard.sql)]);
  const {dispatchStablePhase1}=createRequire(import.meta.url)('../dist/sheets/stable-phase1-dispatch.js');
  if(projection!=='DAILY'){
   await db.batch([db.prepare('DROP TRIGGER serial_job_provenance_update_guard'),db.prepare("UPDATE sync_jobs SET lease_token='other-lease' WHERE entity_type='EXPENSE' AND entity_key=?").bind(saved.job.entityKey),db.prepare(guard.sql)]);
   await dispatchStablePhase1(env,saved.job,2);
   assert.equal((await db.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=?").bind(saved.job.entityKey).first()).status,'PROCESSING','different lease cannot use the old permit');
   await db.batch([db.prepare('DROP TRIGGER serial_job_provenance_update_guard'),db.prepare("UPDATE sync_jobs SET lease_token=? WHERE entity_type='EXPENSE' AND entity_key=?").bind(jobBefore.lease_token,saved.job.entityKey),db.prepare(guard.sql)]);
   await db.batch([db.prepare('DROP TRIGGER serial_job_provenance_update_guard'),db.prepare("UPDATE sync_jobs SET serial_lease_generation=0 WHERE entity_type='EXPENSE' AND entity_key=?").bind(saved.job.entityKey),db.prepare(guard.sql)]);
   await dispatchStablePhase1(env,saved.job,2);
   assert.equal((await db.prepare("SELECT status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=?").bind(saved.job.entityKey).first()).status,'PROCESSING','decreased generation cannot use a later permit');
   await db.batch([db.prepare('DROP TRIGGER serial_job_provenance_update_guard'),db.prepare("UPDATE sync_jobs SET serial_lease_generation=? WHERE entity_type='EXPENSE' AND entity_key=?").bind(jobBefore.serial_lease_generation,saved.job.entityKey),db.prepare(guard.sql)]);
  }
  const firstRenewal=await db.prepare("UPDATE sync_jobs SET lease_until='2099-01-01T00:00:00.000Z',serial_lease_generation=serial_lease_generation+1 WHERE entity_type='EXPENSE' AND entity_key=? AND status='PROCESSING' AND lease_token=? RETURNING serial_lease_generation").bind(saved.job.entityKey,jobBefore.lease_token).all();
  assert.equal(firstRenewal.results.length,1);const renewedGeneration=firstRenewal.results[0].serial_lease_generation;
  await db.batch([db.prepare('DROP TRIGGER serial_job_provenance_update_guard'),db.prepare("UPDATE sync_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE entity_type='EXPENSE' AND entity_key=?").bind(saved.job.entityKey),db.prepare(guard.sql)]);
  // Renewal and the hold CAS compete over the same row. Either renewal wins
  // and remains PROCESSING, or the hold wins and renewal changes no row.
  const [delivery,renewal]=await Promise.allSettled([deliver(),db.prepare("UPDATE sync_jobs SET lease_until='2099-01-01T00:00:00.000Z',serial_lease_generation=serial_lease_generation+1 WHERE entity_type='EXPENSE' AND entity_key=? AND status='PROCESSING' AND lease_token=? AND serial_lease_generation=? RETURNING job_id").bind(saved.job.entityKey,jobBefore.lease_token,renewedGeneration).all()]);
  assert.equal(delivery.status,'fulfilled');assert.equal(renewal.status,'fulfilled');
  const raced=await db.prepare("SELECT status,lease_until,serial_lease_generation FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=?").bind(saved.job.entityKey).first();
  if(raced.status==='PROCESSING'){
   assert.equal(renewal.value.results.length,1);assert.equal(raced.lease_until,'2099-01-01T00:00:00.000Z');
   // Fixture only: advance the renewed lease to expiry, retaining its new
   // generation; expiration does not itself alter the generation.
   await db.batch([db.prepare('DROP TRIGGER serial_job_provenance_update_guard'),db.prepare("UPDATE sync_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE entity_type='EXPENSE' AND entity_key=?").bind(saved.job.entityKey),db.prepare(guard.sql)]);
  }else{assert.equal(raced.status,'REVIEW');assert.equal(renewal.value.results.length,0);}
  const before=queueSends.length;for(let i=0;i<3;i++)await deliver();
  assert.equal(providerWrites,0,'no provider requests');
  for(const queued of queueSends){assert.deepEqual(queued.body,saved.job,'only the same existing C delivery may be delayed');assert.ok(queued.options?.delaySeconds>0);}
  assert.equal(queueSends.length,before,'expired uncertain job must stop re-enqueueing');
  assert.equal((await db.prepare("SELECT status,last_error FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=?").bind(saved.job.entityKey).first()).last_error,'SERIAL_EXPIRED_PROVIDER_UNCERTAIN');
  const {observeSerialRound}=createRequire(import.meta.url)('../dist/admin/serial-round-store.js');
  const observation=await observeSerialRound(db,saved.roundId);
  assert.equal(observation.find(x=>x.job_id===saved.jobId)?.hold_reason,'SERIAL_EXPIRED_PROVIDER_UNCERTAIN');
  assert.equal((await db.prepare("SELECT operation_token FROM stable_workbook_claims WHERE spreadsheet_id='book'").first())?.operation_token,claim.operation_token);
  assert.ok(['IN_FLIGHT','REVIEW'].includes((await db.prepare("SELECT state FROM stable_projection_writes WHERE spreadsheet_id='book' AND entity_id=? AND projection=?").bind(entity,projection).first())?.state));
  assert.equal(JSON.parse(readFileSync(state,'utf8')).posts,count,'provider model commits persisted without replay');
 }finally{
  globalThis.fetch=originalFetch;if(child.exitCode===null&&child.signalCode===null){try{process.kill(-child.pid,'SIGKILL');}catch{}}
  if(mf)await mf.dispose();rmSync(dir,{recursive:true,force:true});
 }
});
