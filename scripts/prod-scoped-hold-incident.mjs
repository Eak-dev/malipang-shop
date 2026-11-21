import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const phases={PROBE:{before:null,after:null},TIME:{before:null,after:'TIME_ACKED'},PROBE_STATUS:{before:'TIME_ACKED',after:'TIME_ACKED'},STATUS:{before:'TIME_ACKED',after:'STATUS_ACKED'},COMMIT:{before:'STATUS_ACKED',after:'COMPLETE'}};
const pinned='1545b09540405efeec440ca8c9317188bb7574518b81c3b19e47ca4fd9cae083';
const fail=code=>{throw Error(code)};
export function validateInputs(e){
 const sha=e.EXPECTED_SHA||'',phase=e.RECOVERY_PHASE||'';
 if(!/^[a-f0-9]{40}$/.test(sha)||sha!==e.GITHUB_SHA||e.GITHUB_REF!=='refs/heads/main'||e.GITHUB_RUN_ATTEMPT!=='1')fail('SCOPED_HOLD_SHA_GUARD');
 if(!Object.hasOwn(phases,phase)||e.CONFIRMATION!==`OWNER APPROVES SCOPED_HOLD ${phase} ${sha.slice(0,7)}`)fail('SCOPED_HOLD_CONFIRMATION_INVALID');
 if(!/^[a-f0-9]{64}$/.test(e.EXPECTED_WORKER_VERSION_SHA256||'')||e.EXTERNAL_WRITERS_FENCED!=='true'||e.OWNER_SUPERVISING!=='true')fail('SCOPED_HOLD_ATTESTATION_MISSING');
 if(!e.CLOUDFLARE_ACCOUNT_ID||!e.CLOUDFLARE_API_TOKEN||!e.MALIPANG_ADMIN_TOKEN||!e.MALIPANG_WORKER_URL)fail('SCOPED_HOLD_CREDENTIALS_MISSING');
 const url=new URL(e.MALIPANG_WORKER_URL);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('SCOPED_HOLD_URL_INVALID');return {phase,base:url.origin};
}
export function verifyState(phase,rows,after=false,identityHash=pinned){
 if(!Object.hasOwn(phases,phase)||!Array.isArray(rows)||rows.length!==1)fail('SCOPED_HOLD_STATE_INVALID');
 const r=rows[0],notice=phases[phase][after?'after':'before'],done=phase==='COMMIT'&&after;
 if(typeof r.token!=='string'||typeof r.job_id!=='string'||createHash('sha256').update(r.token+'\n'+r.job_id).digest('hex')!==identityHash)fail('SCOPED_HOLD_IDENTITY_INVALID');
 const want={source:'CANCELLED',version:2,job:'REVIEW',undo:'PENDING',notice,notice_count:notice===null?0:1,claims:done?0:1,review_claims:done?0:1,epochs:0,projections:0,cancellations:0,mappings:0,unverified_projections:0,unverified_cancellations:0,processing:0,staff:0};
 if(Object.entries(want).some(([k,v])=>r[k]!==v))fail('SCOPED_HOLD_STATE_INVALID');
}
async function main(){
 const env=process.env,{phase,base}=validateInputs(env),cfg=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')),db=cfg.d1_databases?.find(x=>x.binding==='DB');
 if(!db?.database_id||db.database_name!=='malipang-v5-2')fail('SCOPED_HOLD_DATABASE_NOT_PINNED');
 const cf=async(method,path,body)=>{const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)fail('SCOPED_HOLD_CLOUDFLARE_HTTP');const v=await r.json();if(!v.success)fail('SCOPED_HOLD_CLOUDFLARE_API_FAILED');return v.result;};
 const account=env.CLOUDFLARE_ACCOUNT_ID,dep=await cf('GET',`/accounts/${account}/workers/scripts/malipang-backend-v5-2/deployments?per_page=2`),versions=dep.deployments?.[0]?.versions||[];
 if(versions.length!==1||versions[0].percentage!==100||!/^[a-f0-9-]{36}$/.test(versions[0].version_id||''))fail('SCOPED_HOLD_WORKER_DEPLOYMENT_INVALID');
 const workerVersion=versions[0].version_id;if(createHash('sha256').update(workerVersion).digest('hex')!==env.EXPECTED_WORKER_VERSION_SHA256)fail('SCOPED_HOLD_WORKER_VERSION_CHANGED');
 const sql=`SELECT j.job_id,coalesce(w.operation_token,x.operation_token) token,e.status source,e.version,j.status job,u.status undo,x.state notice,(SELECT count(*) FROM scoped_hold_incident_recovery) notice_count,
 (SELECT count(*) FROM stable_workbook_claims) claims,(SELECT count(*) FROM stable_workbook_claims WHERE state='REVIEW' AND phase='OPERATION' AND review_reason='STABLE_EXPENSE_SOURCE_UNVERIFIED') review_claims,
 (SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW')) epochs,
 (SELECT count(*) FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|')) projections,
 (SELECT count(*) FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|')) cancellations,
 (SELECT count(*) FROM sheet_row_index i WHERE i.entity_key=j.entity_key OR substr(i.entity_key,1,length(j.entity_key)+1)=j.entity_key||'|') mappings,
 (SELECT count(*) FROM stable_projection_writes WHERE state<>'VERIFIED') unverified_projections,(SELECT count(*) FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED') unverified_cancellations,(SELECT count(*) FROM sync_jobs WHERE status='PROCESSING') processing,(SELECT count(*) FROM staff_config_sync_outbox WHERE status='PROCESSING') staff
 FROM sync_jobs j JOIN expense_events e ON e.expense_id=j.entity_key JOIN sync_jobs u ON u.entity_type='EXPENSE' AND u.entity_key=j.entity_key AND u.entity_version=2 LEFT JOIN stable_workbook_claims w ON w.state='REVIEW' AND w.phase='OPERATION' AND w.review_reason='STABLE_EXPENSE_SOURCE_UNVERIFIED' LEFT JOIN scoped_hold_incident_recovery x ON x.job_id=j.job_id WHERE j.entity_type='EXPENSE' AND j.entity_version=1 AND j.status='REVIEW' AND j.last_error='STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED'`;
 const read=async()=>{const x=await cf('POST',`/accounts/${account}/d1/database/${db.database_id}/query`,{sql});if(!Array.isArray(x)||x.length!==1||x[0].success!==true||!Array.isArray(x[0].results))fail('SCOPED_HOLD_D1_READ_INVALID');return x[0].results;};
 verifyState(phase,await read());console.log('SCOPED_HOLD_PRECHECK: PASS');
 let response;try{response=await fetch(base+'/admin/stable-sync/scoped-hold-incident',{method:'POST',headers:{Authorization:'Bearer '+env.MALIPANG_ADMIN_TOKEN,'Content-Type':'application/json','x-malipang-expected-worker-version':workerVersion},body:JSON.stringify({action:phase}),redirect:'error',signal:AbortSignal.timeout(240000)});}catch{fail('SCOPED_HOLD_OUTCOME_UNKNOWN_NO_RETRY')}
 let result;try{result=await response.json()}catch{fail('SCOPED_HOLD_OUTCOME_UNKNOWN_NO_RETRY')}
 const expected=phase==='COMMIT'?'COMPLETE':phase==='PROBE'||phase==='PROBE_STATUS'?'READY':'IN_PROGRESS';
 if(!response.ok||result?.ok!==true||result.action!==phase||result.outcome!==expected||result.servedVersion!==workerVersion)fail('SCOPED_HOLD_OUTCOME_UNVERIFIED_NO_RETRY');
 try{verifyState(phase,await read(),true)}catch{fail('SCOPED_HOLD_POSTSTATE_UNVERIFIED_NO_RETRY')}
 console.log(`SCOPED_HOLD_${phase}: PASS; WORKER_MATCH; D1_READBACK_PASS`);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(e=>{console.error(/^[A-Z][A-Z0-9_]+$/.test(e?.message||'')?e.message:'SCOPED_HOLD_UNKNOWN_ERROR_NO_RETRY');process.exitCode=1});
