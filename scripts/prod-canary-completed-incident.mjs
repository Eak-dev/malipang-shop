import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const phases={PROBE:{before:null,after:null},TIME:{before:null,after:'TIME_ACKED'},PROBE_STATUS:{before:'TIME_ACKED',after:'TIME_ACKED'},STATUS:{before:'TIME_ACKED',after:'STATUS_ACKED'},COMMIT:{before:'STATUS_ACKED',after:'COMPLETE'}};
const fail=code=>{throw Error(code)};
export function validateInputs(e){
 const sha=e.EXPECTED_SHA||'',phase=e.RECOVERY_PHASE||'';
 if(!/^[a-f0-9]{40}$/.test(sha)||sha!==e.GITHUB_SHA||e.GITHUB_REF!=='refs/heads/main'||e.GITHUB_RUN_ATTEMPT!=='1')fail('COMPLETED_SHA_GUARD');
 if(!Object.hasOwn(phases,phase)||e.CONFIRMATION!==`OWNER APPROVES COMPLETED ${phase} ${sha.slice(0,7)}`)fail('COMPLETED_CONFIRMATION_INVALID');
 if(!/^[a-f0-9]{64}$/.test(e.EXPECTED_WORKER_VERSION_SHA256||'')||e.EXTERNAL_WRITERS_FENCED!=='true'||e.OWNER_SUPERVISING!=='true')fail('COMPLETED_ATTESTATION_MISSING');
 if(!e.CLOUDFLARE_ACCOUNT_ID||!e.CLOUDFLARE_API_TOKEN||!e.MALIPANG_ADMIN_TOKEN||!e.MALIPANG_WORKER_URL)fail('COMPLETED_CREDENTIALS_MISSING');
 const url=new URL(e.MALIPANG_WORKER_URL);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('COMPLETED_URL_INVALID');
 return {phase,base:url.origin};
}
export function verifyState(phase,rows,after=false){
 if(!Object.hasOwn(phases,phase)||!Array.isArray(rows)||rows.length!==1)fail('COMPLETED_STATE_INVALID');
 const r=rows[0],notice=phases[phase][after?'after':'before'],done=phase==='COMMIT'&&after;
 const want={canary:'ARMED_CONFIRM',source:'CONFIRMED',version:1,job:'COMPLETED',notice,notice_count:notice===null?0:1,claims:done?0:1,review_claims:done?0:1,epochs_armed:done?0:1,epochs_complete:done?1:0,admissions:done?0:1,verified_admissions:done?1:0,projections:3,unverified_projections:0,unverified_cancellations:0,processing:0,staff:0};
 if(Object.entries(want).some(([k,v])=>r[k]!==v))fail('COMPLETED_STATE_INVALID');
}
async function main(){
 const env=process.env,{phase,base}=validateInputs(env),cfg=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')),db=cfg.d1_databases?.find(x=>x.binding==='DB');
 if(!db?.database_id||db.database_name!=='malipang-v5-2')fail('COMPLETED_DATABASE_NOT_PINNED');
 const cf=async(method,path,body)=>{const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)fail('COMPLETED_CLOUDFLARE_HTTP');const v=await r.json();if(!v.success)fail('COMPLETED_CLOUDFLARE_API_FAILED');return v.result;};
 const account=env.CLOUDFLARE_ACCOUNT_ID,dep=await cf('GET',`/accounts/${account}/workers/scripts/malipang-backend-v5-2/deployments?per_page=2`),versions=dep.deployments?.[0]?.versions||[];
 if(versions.length!==1||versions[0].percentage!==100||!/^[a-f0-9-]{36}$/.test(versions[0].version_id||''))fail('COMPLETED_WORKER_DEPLOYMENT_INVALID');
 const workerVersion=versions[0].version_id;if(createHash('sha256').update(workerVersion).digest('hex')!==env.EXPECTED_WORKER_VERSION_SHA256)fail('COMPLETED_WORKER_VERSION_CHANGED');
 const sql=`SELECT c.state canary,e.status source,e.version version,j.status job,
 (SELECT state FROM canary_completed_recovery x WHERE x.expense_id=c.expense_id) notice,(SELECT count(*) FROM canary_completed_recovery x WHERE x.expense_id=c.expense_id) notice_count,
 (SELECT count(*) FROM stable_workbook_claims) claims,(SELECT count(*) FROM stable_workbook_claims WHERE state='REVIEW' AND phase='OPERATION' AND review_reason='STABLE_EXPENSE_COMPLETION_UNCERTAIN') review_claims,
 (SELECT count(*) FROM stable_recovery_epochs ep WHERE ep.target_key=c.expense_id AND ep.target_version=1 AND ep.state='ARMED') epochs_armed,(SELECT count(*) FROM stable_recovery_epochs ep JOIN canary_completed_recovery x ON x.epoch_id=ep.epoch_id WHERE ep.target_key=c.expense_id AND ep.target_version=1 AND ep.state='COMPLETE') epochs_complete,
 (SELECT count(*) FROM stable_recovery_operations op JOIN stable_recovery_epochs ep ON ep.epoch_id=op.epoch_id WHERE ep.target_key=c.expense_id AND op.state='ADMITTED') admissions,(SELECT count(*) FROM stable_recovery_operations op JOIN canary_completed_recovery x ON x.operation_token=op.operation_token WHERE x.expense_id=c.expense_id AND op.state='VERIFIED') verified_admissions,
 (SELECT count(*) FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND p.source_version=1 AND p.state='VERIFIED' AND ((p.entity_id=c.expense_id AND p.projection IN ('DAILY','EXPENSE_RAW')) OR (p.entity_id=c.expense_id||'|'||c.item_id AND p.projection='DETAIL'))) projections,
 (SELECT count(*) FROM stable_projection_writes WHERE state<>'VERIFIED') unverified_projections,(SELECT count(*) FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED') unverified_cancellations,(SELECT count(*) FROM sync_jobs WHERE status='PROCESSING') processing,(SELECT count(*) FROM staff_config_sync_outbox WHERE status='PROCESSING') staff
 FROM continuous_canary_operator c JOIN expense_events e ON e.expense_id=c.expense_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=c.expense_id AND j.entity_version=1 WHERE c.state='ARMED_CONFIRM' AND e.description='[SYSTEM TEST] Synthetic expense - cancel after verification' AND e.amount_satang=100`;
 const read=async()=>{const x=await cf('POST',`/accounts/${account}/d1/database/${db.database_id}/query`,{sql});if(!Array.isArray(x)||x.length!==1||x[0].success!==true||!Array.isArray(x[0].results))fail('COMPLETED_D1_READ_INVALID');return x[0].results;};
 verifyState(phase,await read());console.log('COMPLETED_PRECHECK: PASS');
 let response;try{response=await fetch(base+'/admin/stable-sync/canary-completed-incident',{method:'POST',headers:{Authorization:'Bearer '+env.MALIPANG_ADMIN_TOKEN,'Content-Type':'application/json','x-malipang-expected-worker-version':workerVersion},body:JSON.stringify({action:phase}),redirect:'error',signal:AbortSignal.timeout(240000)});}catch{fail('COMPLETED_OUTCOME_UNKNOWN_NO_RETRY')}
 let result;try{result=await response.json()}catch{fail('COMPLETED_OUTCOME_UNKNOWN_NO_RETRY')}
 const expected=phase==='COMMIT'?'COMPLETE':phase==='PROBE'||phase==='PROBE_STATUS'?'READY':'IN_PROGRESS';
 if(!response.ok||result?.ok!==true||result.action!==phase||result.outcome!==expected||result.servedVersion!==workerVersion)fail('COMPLETED_OUTCOME_UNVERIFIED_NO_RETRY');
 try{verifyState(phase,await read(),true)}catch{fail('COMPLETED_POSTSTATE_UNVERIFIED_NO_RETRY')}
 console.log(`COMPLETED_${phase}: PASS; WORKER_MATCH; D1_READBACK_PASS`);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(e=>{console.error(/^[A-Z][A-Z0-9_]+$/.test(e?.message||'')?e.message:'COMPLETED_UNKNOWN_ERROR_NO_RETRY');process.exitCode=1});
