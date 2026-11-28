// Synthetic local runner crash fixture. No real network, Google or D1 writes.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {dirname} from 'node:path';
import {realpathSync} from 'node:fs';
import {localIdentityStore} from './serial-local-identity.mjs';
import {runNormalPilot} from '../../scripts/prod-normal-queue-pilot.mjs';
const [path,cut,run]=process.argv.slice(2),db=new DatabaseSync(path);
const version='01234567-89ab-cdef-0123-456789abcdef',sha='a'.repeat(40),fingerprint='b'.repeat(64),preimageDigest='c'.repeat(64);
const jobId='12345678-1234-1234-1234-123456789abc',nextId='22345678-1234-1234-1234-123456789abc';
const env={GITHUB_SHA:sha,EXPECTED_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',PILOT_PHASE:'RUN_SERIAL',PILOT_ROUND_MODE:'true',EXPECTED_WORKER_VERSION_SHA256:createHash('sha256').update(version).digest('hex'),CLOUDFLARE_API_TOKEN:'cf-test',CLOUDFLARE_ACCOUNT_ID:'synthetic',MALIPANG_ADMIN_TOKEN:'admin-test',MALIPANG_WORKER_URL:'https://worker.invalid',BACKUP_RUN_ID:'123',GITHUB_TOKEN:'gh-test',EXTERNAL_WRITERS_FENCED:'true',OWNER_SUPERVISING:'true'};
env.PILOT_LOCAL_IDENTITY='true';env.MALIPANG_WORKER_URL='https://localhost/';
const mock=cut.startsWith('mock');const recovery=['mocknormal','mockbefore-record','mockrecord','mockdelayedclose','mockclose'].includes(cut);if(mock){env.PILOT_LOCAL_MOCK='true';env.MALIPANG_WORKER_URL='https://localhost/';}
if(run==='first'){
 db.exec(`CREATE TABLE sync_jobs(job_id,entity_key,entity_type,entity_version,status,attempt_count,lease_token,lease_until,next_attempt_at,updated_at);
 CREATE TABLE expense_events(expense_id,version,status,transaction_date); CREATE TABLE continuous_daily_cutovers(spreadsheet_id,state);
 CREATE TABLE continuous_daily_post_cutover_expenses(spreadsheet_id,expense_id); CREATE TABLE admin_audit(id,action,entity_key,reason,before_json,after_json);
 CREATE TABLE rounds(round_id,fingerprint,members,state TEXT NOT NULL DEFAULT 'OPEN'); CREATE TABLE pending_open(round_id TEXT PRIMARY KEY,fingerprint TEXT,members TEXT); CREATE TABLE pending_settle(fingerprint TEXT PRIMARY KEY); CREATE TABLE mock_quiescence(round_id TEXT PRIMARY KEY,worker_version TEXT NOT NULL,oracle_state TEXT NOT NULL,fence_digest TEXT NOT NULL,fence_generation INTEGER NOT NULL,nonce TEXT NOT NULL); CREATE TABLE pending_handover(round_id TEXT PRIMARY KEY,job_id TEXT NOT NULL); CREATE TABLE pending_close(round_id TEXT PRIMARY KEY); CREATE TABLE mock_receipts(round_id,job_id,proof,worker_version,algorithm,verified_at,PRIMARY KEY(round_id,job_id)); CREATE TABLE actions(action); CREATE TABLE mock_holds(round_id,job_id); CREATE TABLE mock_handoffs(round_id,job_id,next_id,nonce,epoch,payload,claim_digest); INSERT INTO continuous_daily_cutovers VALUES('test-book','ACTIVE')`);
 for(const id of [jobId,nextId]){db.prepare("INSERT INTO sync_jobs VALUES(?,?,'EXPENSE',1,'PENDING',0,NULL,NULL,NULL,?)").run(id,id,id);db.prepare("INSERT INTO expense_events VALUES(?,1,'CONFIRMED',date('now','+7 hours'))").run(id);db.prepare("INSERT INTO continuous_daily_post_cutover_expenses VALUES('test-book',?)").run(id);}
}
if(run==='restart'&&cut==='mockclose'){env.PILOT_PHASE='READ_ROUND';env.PILOT_ROUND_ID=db.prepare('SELECT round_id FROM rounds').get().round_id;}
if(run==='reconcile'){const row=db.prepare("SELECT r.round_id FROM rounds r JOIN mock_quiescence q ON q.round_id=r.round_id AND q.worker_version=? AND q.oracle_state='QUIESCENT_FENCED' WHERE r.state='OPEN'").get(version);if(!recovery||!row)throw Error('MOCK_QUIESCENCE_REQUIRED');env.PILOT_PHASE='CLOSE_MOCK_ROUND';env.PILOT_ROUND_ID=row.round_id;}
const reply=(outcome,more={})=>Response.json({ok:true,outcome,servedVersion:version,...more});
function record(id,previous,proof,roundId){db.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?)').run(previous?'issue296:serial:'+previous:'issue296:parked:synthetic',previous?'ISSUE296_SERIAL_EXPENSE_HANDOVER':'ISSUE296_PAUSED_NOTICE_HANDOVER',id,fingerprint,JSON.stringify({book:'test-book',predecessorJobId:previous,proof}),JSON.stringify({version,roundId}));}
const request=async(input,opts)=>{
 const url=String(input);
 if(url.includes('/deployments?'))return Response.json({success:true,result:{deployments:[{versions:[{version_id:version,percentage:100}]}]}});
 if(url.includes('/d1/database/')){const {sql}=JSON.parse(opts.body);if(!sql.startsWith('SELECT '))throw Error('non-read D1 query');
  const results=sql.startsWith('SELECT h.round_id,h.worker_version,h.nonce,h.fence_digest,h.fence_generation FROM serial_pilot_attested_handoffs')?db.prepare("SELECT h.round_id,q.worker_version,h.nonce,q.fence_digest,q.fence_generation FROM mock_handoffs h JOIN rounds r ON r.round_id=h.round_id AND r.state='OPEN' JOIN mock_quiescence q ON q.round_id=h.round_id AND q.nonce=h.nonce").all():db.prepare(sql).all();
  return Response.json({success:true,result:[{success:true,results}]});}
 if(url.includes('/actions/runs/')){const job={name:'ops',id:1234,status:'completed',conclusion:'success',steps:[{name:'Backup and migration rehearsal',conclusion:'success'}]};return Response.json(url.includes('/jobs?')?{jobs:[job]}:{path:'.github/workflows/prod-ops-readonly.yml',event:'workflow_dispatch',status:'completed',conclusion:'success',head_sha:sha,created_at:new Date().toISOString()});}
 if(url.endsWith('/jobs/1234/logs'))return new Response(null,{status:302,headers:{location:'https://log.invalid/download'}});
 if(url==='https://log.invalid/download')return new Response(['export','backup_upload','backup_checksum','restore','integrity_before','foreign_keys_before','preexisting_rows_unchanged','integrity_after','foreign_keys_after','smoke_all'].map(k=>'- '+k+': PASS').join('\n'));
 if(new URL(url).origin!==new URL(env.MALIPANG_WORKER_URL).origin)throw Error('unexpected request');
 const body=JSON.parse(opts.body);db.prepare('INSERT INTO actions VALUES(?)').run(body.action);
 const saved=()=>db.prepare('SELECT * FROM rounds').get();
 if(body.action==='LIST_OPEN'){const row=saved();return reply('OPEN_ROUNDS',{rounds:row?.state==='OPEN'?[{roundId:row.round_id,selectedCount:2}]:[]});}
 if(body.action==='READ'){const row=saved(),receipt=db.prepare('SELECT * FROM mock_receipts WHERE round_id=?').get(row.round_id),receipts=receipt?[{jobId:receipt.job_id,proof:receipt.proof,proofAlgorithm:receipt.algorithm,workerVersion:receipt.worker_version,verifiedAt:receipt.verified_at}]:[];
  const more={fingerprint:row.fingerprint,members:JSON.parse(row.members),selected:2,receipts};
  if(row.state==='CLOSED')Object.assign(more,{mockOracleAndFenceOnly:true,recordedResultsAreCurrentProviderProof:false,readRevalidatesRecordedIntegrity:false,results:[{jobId,category:'PARKED',evidence:'MOCK_ATTESTED_HANDOFF',successorJobId:nextId},{jobId:nextId,category:'VERIFIED',evidence:'VERIFIED_RECEIPT',successorJobId:null}]});
  return reply(row.state,more);}

 if(body.action==='OPEN_INITIAL'){if(run==='first'&&cut==='open-before-commit'){db.prepare('INSERT INTO pending_open VALUES(?,?,?)').run(body.roundId,body.fingerprint,JSON.stringify(body.jobs));process.kill(process.pid,'SIGKILL');}db.prepare('INSERT INTO rounds(round_id,fingerprint,members) VALUES(?,?,?)').run(body.roundId,body.fingerprint,JSON.stringify(body.jobs));if(run==='first'&&cut==='open')process.kill(process.pid,'SIGKILL');return reply('OPEN');}
 if(body.action==='INSPECT')return reply('INSPECTED',{fingerprint,projectionState:cut==='settle-before-commit'?'IN_FLIGHT':'VERIFIED',preimageDigest:cut==='settle-before-commit'?null:preimageDigest});
 if(body.action==='PROBE')return reply('MATCHED',{fingerprint,preimageDigest});
 if(body.action==='SETTLE'){if(run==='first'&&cut==='settle-before-commit'){db.prepare('INSERT INTO pending_settle VALUES(?)').run(body.fingerprint);process.kill(process.pid,'SIGKILL');}return reply('SETTLED',{fingerprint,preimageDigest});}
 if(body.action==='HANDOVER_ONE'){if(run==='first'&&cut==='handover-before-commit'){db.prepare('INSERT INTO pending_handover VALUES(?,?)').run(body.roundId,body.jobId);process.kill(process.pid,'SIGKILL');}record(body.jobId,undefined,undefined,body.roundId);if(run==='first'&&cut==='handover')process.kill(process.pid,'SIGKILL');return reply('RESERVED');}
 if(body.action==='HOLD_RESERVED'){db.prepare('INSERT INTO mock_holds VALUES(?,?)').run(body.roundId,body.jobId);if(run==='first'&&cut==='mockhold')process.kill(process.pid,'SIGKILL');return reply('RECONCILIATION_REQUIRED');}
 if(body.action==='FINISH_STATUS'){if(run==='restart'&&!recovery)return reply('UNVERIFIED');if(run==='first'&&cut==='mockbefore-record')process.kill(process.pid,'SIGKILL');return reply('JOB_COMPLETE',{proof:createHash('sha256').update(body.jobId).digest('hex')});}
 if(body.action==='READBACK')return reply('MATCHED');
 if(body.action==='RECORD_VERIFIED'){
  db.prepare('INSERT INTO mock_receipts VALUES(?,?,?,?,?,?)').run(body.roundId,body.jobId,body.proof,version,'pilot-finish-v2','2026-11-23T00:00:00.000Z');
  if(run==='first'&&cut==='mockrecord')process.kill(process.pid,'SIGKILL');return reply('RECORDED');}
 if(body.action==='CLOSE_MOCK_PARKED'){
  const receipt=db.prepare('SELECT * FROM mock_receipts WHERE round_id=? AND job_id=?').get(body.roundId,nextId);if(!receipt)throw Error('missing exact receipt');
  if(run==='first'&&cut==='mockdelayedclose'){db.prepare('INSERT INTO pending_close VALUES(?)').run(body.roundId);process.kill(process.pid,'SIGKILL');}
  db.prepare("UPDATE rounds SET state='CLOSED' WHERE round_id=? AND state='OPEN'").run(body.roundId);
  if(run==='first'&&cut==='mockclose')process.kill(process.pid,'SIGKILL');
  return reply('CLOSED',{fingerprint,members:[jobId,nextId],selected:2,mockOracleAndFenceOnly:true,recordedResultsAreCurrentProviderProof:false,readRevalidatesRecordedIntegrity:false,results:[{jobId,category:'PARKED',evidence:'MOCK_ATTESTED_HANDOFF',successorJobId:nextId},{jobId:nextId,category:'VERIFIED',evidence:'VERIFIED_RECEIPT',successorJobId:null}],receipts:[{jobId:nextId,proof:receipt.proof,proofAlgorithm:receipt.algorithm,workerVersion:receipt.worker_version,verifiedAt:receipt.verified_at}]});}

 if(body.action==='ADVANCE_ONE'){record(body.nextJobId,body.jobId,body.proof,body.roundId);if(run==='first'&&cut==='advance')process.kill(process.pid,'SIGKILL');return reply('RESERVED');}
 throw Error('unexpected action '+body.action);
};
const nonce='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',epoch='normal_pilot296_cccccccc-cccc-4ccc-8ccc-cccccccccccc',payload='d'.repeat(64),claimDigest='e'.repeat(64);
const coordinator=mock?{
 async proveQuiescence(ctx){const row=db.prepare("SELECT * FROM mock_quiescence WHERE round_id=? AND worker_version=? AND oracle_state='QUIESCENT_FENCED'").get(ctx.roundId,ctx.workerVersion);return row?{...ctx,state:row.oracle_state,fenceDigest:row.fence_digest,fenceGeneration:row.fence_generation,nonce:row.nonce}:null;},
 async prepare(ctx){return {...ctx,nonce,payloadDigest:payload,claimDigest};},
 async reserve(intent){
  db.prepare('INSERT INTO actions VALUES(?)').run('MOCK_TRANSFER');db.prepare('INSERT INTO mock_handoffs VALUES(?,?,?,?,?,?,?)').run(intent.roundId,jobId,nextId,nonce,epoch,payload,claimDigest);
  db.prepare('INSERT INTO admin_audit VALUES(?,?,?,?,?,?)').run('issue296:serial:'+jobId,'ISSUE296_SERIAL_EXPENSE_HANDOVER',nextId,fingerprint,JSON.stringify({book:'test-book',predecessorJobId:jobId,proof:payload}),JSON.stringify({version,roundId:intent.roundId,epoch,attestationNonce:nonce}));
  if(run==='first'&&cut==='mocktransfer')process.kill(process.pid,'SIGKILL');
 },
 async inspect(expected){const row=db.prepare('SELECT * FROM mock_handoffs WHERE round_id=? AND job_id=? AND next_id=? AND nonce=? AND epoch=? AND payload=?').get(expected.roundId,expected.predecessorJobId,expected.successorJobId,expected.nonce,expected.epochId,expected.payloadDigest);return row?{...expected,outcome:'RESERVATION_RECORDED',claimDigest:row.claim_digest}:null;}
}:undefined;
try{const result=await runNormalPilot(env,request,async()=>{},coordinator,localIdentityStore(realpathSync(dirname(path))));db.prepare('INSERT INTO actions VALUES(?)').run(recovery?'SUCCESS:'+result.outcome:'UNEXPECTED_SUCCESS');}
catch(error){db.prepare('INSERT INTO actions VALUES(?)').run('STOP:'+error.message);}
finally{db.close();}
