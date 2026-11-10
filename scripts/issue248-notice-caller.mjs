// Reviewed prototype only. Called by manual Workflow with scoped secret; never writes Sheets/D1.
import {randomBytes,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {checkDiagnostic,checkAudit} from './issue248-notice-caller-proof.mjs';
const e=process.env, base='release-control/pr247/g6b', repo='Eak-dev/malipang-shop', temp=e.RUNNER_TEMP;
const run=(file,args)=>execFileSync(file,args,{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});
const read=(key,file)=>{run('npx',['wrangler','r2','object','get',`malipang-private-backups/${key}`,`--file=${file}`,'--remote']);return JSON.parse(readFileSync(file,'utf8'));};
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const digits=x=>/^\d+$/.test(x||'');
async function main(){
 if(e.GITHUB_REPOSITORY!==repo||!temp||!digits(e.GITHUB_RUN_ID)||!digits(e.GITHUB_RUN_ATTEMPT)||!digits(e.DEPLOY_RUN)||!digits(e.DEPLOY_ATTEMPT)||e.DIAGNOSTIC_SOURCE!=='c4b4ab96e2f2cb08a8633c003294375a0f458095'||!/^[a-f0-9]{40}$/.test(e.GITHUB_SHA||'')||!e.DIAGNOSTIC_WORKER_VERSION||!e.MALIPANG_ADMIN_TOKEN)throw Error('CALLER_CONFIG_INVALID');
 const deploy=read(`release-control/pr247/g6b-diagnostic/${e.DEPLOY_RUN}-${e.DEPLOY_ATTEMPT}-verified.json`,`${temp}/deploy.json`);
 if(e.DEPLOY_RUN!=='42816833410'||e.DEPLOY_ATTEMPT!=='1')throw Error('DEPLOY_RUN_NOT_REVIEWED');
 const deployInfo=JSON.parse(run('gh',['api',`repos/${repo}/actions/runs/${e.DEPLOY_RUN}/attempts/${e.DEPLOY_ATTEMPT}`]));
 if(deployInfo.status!=='completed'||deployInfo.conclusion!=='success'||deployInfo.event!=='workflow_dispatch'||deployInfo.path!=='.github/workflows/issue248-original-notice-diagnostic-deploy.yml'||deployInfo.head_sha!==e.DIAGNOSTIC_SOURCE||String(deployInfo.id)!==e.DEPLOY_RUN||String(deployInfo.run_attempt)!==e.DEPLOY_ATTEMPT)throw Error('DEPLOY_RUN_UNVERIFIED');
 const deployJobs=JSON.parse(run('gh',['api',`repos/${repo}/actions/runs/${e.DEPLOY_RUN}/attempts/${e.DEPLOY_ATTEMPT}/jobs?per_page=100`]));
 const deploySteps=['Require G6a A_POST before deploy','Verify or restore explicit active Queue under scoped evidence','Read back guard and observe'];
 if(deployJobs.total_count!==1||!Array.isArray(deployJobs.jobs)||deployJobs.jobs.length!==1||deployJobs.jobs[0].name!=='deploy'||deployJobs.jobs[0].status!=='completed'||deployJobs.jobs[0].conclusion!=='success'||!Array.isArray(deployJobs.jobs[0].steps)||deploySteps.some(name=>deployJobs.jobs[0].steps.filter(x=>x.name===name&&x.status==='completed'&&x.conclusion==='success').length!==1))throw Error('DEPLOY_JOB_UNVERIFIED');
 if(deploy.schema!=='MP248_NOTICE_DIAGNOSTIC_V1'||deploy.state!=='VERIFIED_COMPLETED'||deploy.expected_sha!==e.DIAGNOSTIC_SOURCE||deploy.base_sha!=='acc65da7312315d442e362d331b3be9816a3fddd'||deploy.prior_worker_version!=='e26b593e-7fa5-4492-a62f-5a0c68f3533f'||deploy.worker_version!==e.DIAGNOSTIC_WORKER_VERSION||deploy.g5_sha!=='0d1dda77f3a0e5cfaec1872cb588b59dddfe5bdf'||deploy.run_id!==e.DEPLOY_RUN||deploy.run_attempt!==e.DEPLOY_ATTEMPT)throw Error('DEPLOY_RECEIPT_INVALID');
 const url=new URL(e.MALIPANG_WORKER_URL);if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw Error('WORKER_URL_INVALID');
 const mode=e.NOTICE_MODE;if(!['PAUSED','READY'].includes(mode))throw Error('MODE_INVALID');
 let id=e.AUDIT_ID, audit=null;
 if(mode==='PAUSED')id=randomBytes(24).toString('base64url');
 else {
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(id||''))throw Error('AUDIT_ID_INVALID');
  const paused=read(`${base}/${id}/00_paused_provider.json`,`${temp}/paused.json`),a1=read(`${base}/${id}/01_preimage.json`,`${temp}/a1.json`),a2=read(`${base}/${id}/02_write_intent.json`,`${temp}/a2.json`);
  if(!digits(paused.caller_run)||!digits(paused.caller_attempt)||!/^[a-f0-9]{40}$/.test(paused.caller_source_sha||''))throw Error('CALLER_PROVENANCE_INVALID');
  const info=JSON.parse(run('gh',['api',`repos/${repo}/actions/runs/${paused.caller_run}/attempts/${paused.caller_attempt}`]));
  if(info.status!=='completed'||info.conclusion!=='success'||info.event!=='workflow_dispatch'||info.path!=='.github/workflows/issue248-notice-caller.yml'||info.head_sha!==paused.caller_source_sha||String(info.id)!==paused.caller_run||String(info.run_attempt)!==paused.caller_attempt)throw Error('CALLER_RUN_UNVERIFIED');
  const jobs=JSON.parse(run('gh',['api',`repos/${repo}/actions/runs/${paused.caller_run}/attempts/${paused.caller_attempt}/jobs?per_page=100`]));
  const required=['Pin exact source and live Worker','Read diagnostic and persist supervised evidence','Guard again after observation'];
  if(jobs.total_count!==1||!Array.isArray(jobs.jobs)||jobs.jobs.length!==1||jobs.jobs[0].name!=='notice-proof'||jobs.jobs[0].status!=='completed'||jobs.jobs[0].conclusion!=='success'||!Number.isSafeInteger(jobs.jobs[0].id)||!Array.isArray(jobs.jobs[0].steps)||required.some(name=>jobs.jobs[0].steps.filter(x=>x.name===name&&x.status==='completed'&&x.conclusion==='success').length!==1))throw Error('CALLER_JOB_UNVERIFIED');
  const logs=run('gh',['run','view','--job',String(jobs.jobs[0].id),'--repo',repo,'--log']);
  const matches=[...logs.matchAll(/\bMP248_PAUSED_RECEIPT_SHA256=([a-f0-9]{64})\b/g)];if(matches.length!==1||matches[0][1]!==hash(paused))throw Error('CALLER_LOG_UNVERIFIED');
  audit=checkAudit({id,paused,audit1:a1,audit2:a2,source:e.DIAGNOSTIC_SOURCE,worker:e.DIAGNOSTIC_WORKER_VERSION,deployRun:e.DEPLOY_RUN,deployAttempt:e.DEPLOY_ATTEMPT,callerRun:paused.caller_run,callerAttempt:paused.caller_attempt,callerSource:paused.caller_source_sha});
 }
 const nonce=randomBytes(24).toString('base64url');if(mode==='READY'&&nonce===audit.originalNonce)throw Error('NONCE_REUSED');const headers={authorization:`Bearer ${e.MALIPANG_ADMIN_TOKEN}`,'x-mp248-nonce':nonce};
 if(mode==='READY')Object.assign(headers,{'x-mp248-claim-fingerprint':audit.claim,'x-mp248-style-fingerprint':audit.style,'x-mp248-ready-time':audit.readyTime,'x-mp248-ready-status':'NORMAL'});
 const response=await fetch(new URL(mode==='PAUSED'?'/admin/stable-sync/original-paused-notice':'/admin/stable-sync/original-ready-notice',url),{headers,signal:AbortSignal.timeout(20000),redirect:'error'});
 if(response.status!==200)throw Error('PROVIDER_DIAGNOSTIC_UNAVAILABLE');
 const body=await response.json();checkDiagnostic({mode,expectedNonce:nonce,response:body,...(audit||{})});
 const receipt={schema:'MP248_NOTICE_CALLER_V1',phase:mode,audit_id:id,diagnostic_source:e.DIAGNOSTIC_SOURCE,worker_version:e.DIAGNOSTIC_WORKER_VERSION,deploy_run:e.DEPLOY_RUN,deploy_attempt:e.DEPLOY_ATTEMPT,caller_run:e.GITHUB_RUN_ID,caller_attempt:e.GITHUB_RUN_ATTEMPT,caller_source_sha:e.GITHUB_SHA,nonce,claim_fingerprint:body.claim_fingerprint,style_fingerprint:body.style_fingerprint,binding:body.binding};
 if(mode==='READY')receipt.ready_time=audit.readyTime;
 const file=`${temp}/notice-caller-receipt.json`, key=`${base}/${id}/${mode==='PAUSED'?'00_paused_provider.json':`04_ready_provider-${e.GITHUB_RUN_ID}-${e.GITHUB_RUN_ATTEMPT}.json`}`;
 writeFileSync(file,JSON.stringify(receipt),{mode:0o600});run('npx',['wrangler','r2','object','put',`malipang-private-backups/${key}`,`--file=${file}`,'--remote']);
 const actual=read(key,`${temp}/notice-caller-readback.json`);if(JSON.stringify(actual)!==JSON.stringify(receipt))throw Error('RECEIPT_READBACK_FAILED');
 console.log(`MP248_${mode}_RECEIPT_SHA256=${hash(receipt)}`);console.log(`MP248_${mode}_RECEIPT_KEY=${key}`);
}
main().catch(()=>{console.error('NOTICE_CALLER_FAILED: provider, receipt or provenance unverified; inspect privately.');process.exitCode=1;});
