// LOCAL REVIEW CANDIDATE: deterministic evidence formatter/validator.
// Inputs MUST be read from authenticated provider responses by the runner;
// this module cannot establish provenance and does not perform any IO.
import {createHash} from 'node:crypto';
const fail=x=>{throw Error('NO_GO_'+x)};
const integer=x=>Number.isSafeInteger(x)&&x>=0;
const exactRow=r=>r?.success===true&&r?.meta?.changed_db===false&&r?.meta?.rows_written===0&&Array.isArray(r.results)&&r.results.length===1&&r.results[0]&&typeof r.results[0]==='object';
export function makeStageProof({mode,nonce,run,attempt,sourceSha,workerVersion,snapshot,extraD1}){
 if(mode!=='POST'||typeof nonce!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(nonce)||![run,attempt].every(x=>typeof x==='string'&&/^[1-9][0-9]{0,15}$/.test(x))||typeof sourceSha!=='string'||!/^[0-9a-f]{40}$/.test(sourceSha)||workerVersion!=='a9cc50ba-f2f0-4cbe-a261-ff3bb65fc86c')fail('PROVENANCE');
 const s=snapshot;
 if(!s||typeof s!=='object'||s?.params?.expectedWorkerVersion!==workerVersion)fail('SNAPSHOT');
 if(!Array.isArray(extraD1)||extraD1.length!==1||!exactRow(extraD1[0]))fail('D1_ENVELOPE');
 const d=extraD1[0].results[0],fields=['review','held','inflight','epoch_active','review_jobs','completed','open_failed'];
 if(Object.keys(d).sort().join()!==[...fields].sort().join()||fields.some(k=>!integer(d[k])))fail('D1_SHAPE');
 if(mode==='POST'){
  if(d.review!==0||d.held!==0||d.inflight!==0||d.epoch_active!==0||d.review_jobs!==0||d.completed!==3296||d.open_failed>32)fail('POST_D1');
  if(s.status?.ok!==true||s.status.claim!==null||s.status.inFlightProjections!==0||s.status.recoveryGate?.mode!=='UNARMED'||s.status.sheetPacing?.mode!=='UNARMED')fail('POST_STATUS');
  const c=s.cloudflare;
  if(!Array.isArray(c?.cron)||c.cron.length!==1||c.cron[0]?.cron!=='*/5 * * * *'||c?.queue?.queue_name!=='malipang-jobs'||c.queue?.queue_id!=='b9b12fe82e6b402291b5d16d2ce61770'||c.queue?.settings?.delivery_paused!==false||!Array.isArray(c.versions)||c.versions.length!==1||c.versions[0]?.percentage!==100||c.versions[0]?.version_id!==workerVersion)fail('POST_CF');
 }
 const status={ok:s.status.ok,claim:s.status.claim===null?null:{state:s.status.claim?.state,notice_stamp:s.status.claim?.notice_stamp},inFlightProjections:s.status.inFlightProjections,recoveryGate:{mode:s.status.recoveryGate.mode},sheetPacing:{mode:s.status.sheetPacing.mode}};
 const cloudflare={cron:s.cloudflare.cron.map(x=>({cron:x.cron})),queue:{queue_name:s.cloudflare.queue.queue_name,queue_id:s.cloudflare.queue.queue_id,settings:{delivery_paused:s.cloudflare.queue.settings.delivery_paused}},versions:s.cloudflare.versions.map(x=>({version_id:x.version_id,percentage:x.percentage}))};
 const evidence={status,cloudflare,d1:extraD1};
 return {schema:'MP248_STAGE_PROOF_V1',mode,nonce,run,attempt,sourceSha,workerVersion,observedAt:new Date().toISOString(),evidence};
}
export function evidenceDigest(proof){return createHash('sha256').update(JSON.stringify(proof)).digest('hex');}
// Parent-side verifier must receive independently read GH run/attempt, jobs,
// job log marker and R2 body, not booleans or user-provided descriptions.
export function verifyPostProof({raw,receiptKey,markerDigest,markerKey,run,jobs,expectedSha,expectedNonce,now=Date.now()}){
 if(typeof raw!=='string'||typeof expectedSha!=='string'||!/^[a-f0-9]{40}$/.test(expectedSha)||typeof expectedNonce!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(expectedNonce))fail('POST_PROVENANCE');
 let p;try{p=JSON.parse(raw)}catch{fail('POST_RECEIPT')}
 if(JSON.stringify(p)!==raw||p?.schema!=='MP248_STAGE_PROOF_V1'||p.mode!=='POST'||p.nonce!==expectedNonce||p.sourceSha!==expectedSha||p.workerVersion!=='a9cc50ba-f2f0-4cbe-a261-ff3bb65fc86c'||![p.run,p.attempt].every(x=>typeof x==='string'&&/^[1-9][0-9]{0,15}$/.test(x)))fail('POST_RECEIPT');
 const key=`release-control/pr247/g6b-stage/${p.nonce}/${p.run}-${p.attempt}.json`;
 if(receiptKey!==key||markerKey!==key||markerDigest!==evidenceDigest(p))fail('POST_MARKER');
 const ms=Date.parse(p.observedAt);if(typeof p.observedAt!=='string'||!Number.isFinite(ms)||new Date(ms).toISOString()!==p.observedAt||!Number.isFinite(now)||ms>now+30000||now-ms>300000)fail('POST_FRESHNESS');
 if(String(run?.id)!==p.run||String(run?.run_attempt)!==p.attempt||run.status!=='completed'||run.conclusion!=='success'||run.head_sha!==expectedSha||run.head_branch!=='main'||run.event!=='workflow_dispatch'||run.path!=='.github/workflows/issue248-post-cas-proof.yml')fail('POST_RUN');
 if(!Array.isArray(jobs?.jobs)||jobs.jobs.length!==1||jobs.jobs[0].name!=='post-cas-proof'||String(jobs.jobs[0].run_id)!==p.run||jobs.jobs[0].status!=='completed'||jobs.jobs[0].conclusion!=='success'||!Array.isArray(jobs.jobs[0].steps))fail('POST_JOB');
 for(const name of ['Pin reviewed source','Collect provider post-CAS state','Persist evidence and read back'])if(jobs.jobs[0].steps.filter(x=>x.name===name&&x.status==='completed'&&x.conclusion==='success').length!==1)fail('POST_STEP');
 const e=p.evidence;const s=e?.status,c=e?.cloudflare;
 if(!s||s.ok!==true||s.claim!==null||s.inFlightProjections!==0||s.recoveryGate?.mode!=='UNARMED'||s.sheetPacing?.mode!=='UNARMED')fail('POST_STATUS');
 if(!Array.isArray(c?.cron)||c.cron.length!==1||c.cron[0]?.cron!=='*/5 * * * *'||c.queue?.queue_name!=='malipang-jobs'||c.queue?.queue_id!=='b9b12fe82e6b402291b5d16d2ce61770'||c.queue?.settings?.delivery_paused!==false||!Array.isArray(c.versions)||c.versions.length!==1||c.versions[0]?.percentage!==100||c.versions[0]?.version_id!==p.workerVersion)fail('POST_CF');
 if(!Array.isArray(e.d1)||e.d1.length!==1||!exactRow(e.d1[0]))fail('D1_ENVELOPE');
 const d=e.d1[0].results[0];for(const k of ['review','held','inflight','epoch_active','review_jobs'])if(d[k]!==0)fail('POST_D1');
 if(d.completed!==3296||!integer(d.open_failed)||d.open_failed>32)fail('POST_D1');
 return e;
}
