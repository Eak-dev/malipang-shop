import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const phases={PROBE:{before:null,after:null},TIME:{before:null,after:'TIME_ACKED'},STATUS:{before:'TIME_ACKED',after:'STATUS_ACKED'},COMMIT:{before:'STATUS_ACKED',after:'COMPLETE'}};
const fail=code=>{throw Error(code)};
export function validateInputs(e){
 const sha=e.EXPECTED_SHA||'',phase=e.RECOVERY_PHASE||'';
 if(!/^[a-f0-9]{40}$/.test(sha)||sha!==e.GITHUB_SHA||e.GITHUB_REF!=='refs/heads/main')fail('INCIDENT_SHA_GUARD');
 if(e.GITHUB_RUN_ATTEMPT!=='1')fail('INCIDENT_RERUN_NOT_ALLOWED');
 if(!Object.hasOwn(phases,phase))fail('INCIDENT_PHASE_INVALID');
 if(e.CONFIRMATION!==`OWNER APPROVES INCIDENT ${phase} ${sha.slice(0,7)}`)fail('INCIDENT_CONFIRMATION_INVALID');
 if(!/^[a-f0-9]{64}$/.test(e.EXPECTED_WORKER_VERSION_SHA256||''))fail('INCIDENT_VERSION_HASH_INVALID');
 if(e.EXTERNAL_WRITERS_FENCED!=='true'||e.OWNER_SUPERVISING!=='true')fail('INCIDENT_ATTESTATION_MISSING');
 if(!e.CLOUDFLARE_ACCOUNT_ID||!e.CLOUDFLARE_API_TOKEN||!e.MALIPANG_ADMIN_TOKEN||!e.MALIPANG_WORKER_URL)fail('INCIDENT_CREDENTIALS_MISSING');
 const url=new URL(e.MALIPANG_WORKER_URL);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('INCIDENT_URL_INVALID');
 return{phase,base:url.origin};
}
export function verifyPhase(phase,rows,after=false){
 if(!Object.hasOwn(phases,phase)||!Array.isArray(rows))fail('INCIDENT_PHASE_INVALID');
 const expected=phases[phase][after?'after':'before'];
 if(expected===null?rows.length!==0:rows.length!==1||rows[0].state!==expected)fail('INCIDENT_PHASE_CHANGED');
}
export function verifyPreflight(rows){
 if(!Array.isArray(rows)||rows.length!==1)fail('INCIDENT_PRECHECK_INVALID');
 const r=rows[0],expected={incident:1,claims:1,epochs:1,admissions:1,processing:0,staff:0,projections:0,cancellations:0};
 if(Object.entries(expected).some(([key,value])=>typeof r[key]!=='number'||!Number.isSafeInteger(r[key])||r[key]!==value))fail('INCIDENT_PRECHECK_INVALID');
}
export function safeProbeDiagnostic(result){
 const d=result?.diagnostic;
 if(result?.ok!==false||!/^(OPERATOR_STATE|D1_EVIDENCE|ACTIVATION|NOTICE_INITIAL|SNAPSHOT_INITIAL|REPORT_HEALTH|SNAPSHOT_FINAL|NOTICE_FINAL|CONSISTENCY)$/.test(d?.stage||'')||!/^(CHECK_FAILED|UNVERIFIED|REQUEST_BUDGET|TIMEOUT|SHEETS_READ_NETWORK|SHEETS_RESPONSE_TOO_LARGE|SHEETS_HTTP_[45][0-9]{2}|GOOGLE_OAUTH_HTTP_[45][0-9]{2}|GOOGLE_OAUTH_(CREDENTIAL_INVALID|NETWORK|RESPONSE_INVALID)|REPORT_HEALTH_(MANIFEST|TARGET|READ|FORMULA|SCOPE|CAPACITY|UNVERIFIED))$/.test(d?.reason||''))return null;
 return `INCIDENT_PROBE_${d.stage}_${d.reason}`;
}
async function main(){
 const env=process.env,{phase,base}=validateInputs(env);
 const cfg=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')),db=cfg.d1_databases?.find(x=>x.binding==='DB');
 if(!db?.database_id||db.database_name!=='malipang-v5-2')fail('INCIDENT_DATABASE_NOT_PINNED');
 const cf=async(method,path,body)=>{
  const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!r.ok)fail('INCIDENT_CLOUDFLARE_HTTP');const v=await r.json();if(!v.success)fail('INCIDENT_CLOUDFLARE_API_FAILED');return v.result;
 };
 const account=env.CLOUDFLARE_ACCOUNT_ID,dep=await cf('GET',`/accounts/${account}/workers/scripts/malipang-backend-v5-2/deployments?per_page=2`),versions=dep.deployments?.[0]?.versions||[];
 if(versions.length!==1||versions[0].percentage!==100||!/^[a-f0-9-]{36}$/.test(versions[0].version_id||''))fail('INCIDENT_WORKER_DEPLOYMENT_INVALID');
 const workerVersion=versions[0].version_id;if(createHash('sha256').update(workerVersion).digest('hex')!==env.EXPECTED_WORKER_VERSION_SHA256)fail('INCIDENT_WORKER_VERSION_CHANGED');
 const query=async sql=>{const r=await cf('POST',`/accounts/${account}/d1/database/${db.database_id}/query`,{sql});if(!Array.isArray(r)||r.length!==1||r[0].success!==true||!Array.isArray(r[0].results))fail('INCIDENT_D1_READ_INVALID');return r[0].results;};
 verifyPhase(phase,await query('SELECT state FROM canary_unwritten_recovery'));
 verifyPreflight(await query(`SELECT
  (SELECT count(*) FROM continuous_canary_operator c JOIN expense_events e ON e.expense_id=c.expense_id AND e.status='CONFIRMED' AND e.version=1 JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=1 JOIN stable_workbook_claims w ON w.spreadsheet_id=c.spreadsheet_id JOIN stable_recovery_epochs epoch ON epoch.spreadsheet_id=c.spreadsheet_id AND epoch.target_key=e.expense_id AND epoch.target_type='EXPENSE' AND epoch.target_version=1 JOIN stable_recovery_operations o ON o.epoch_id=epoch.epoch_id AND o.operation_token=w.operation_token WHERE c.state='ARMED_CONFIRM' AND e.description='[SYSTEM TEST] Synthetic expense - cancel after verification' AND e.amount_satang=100 AND j.status='REVIEW' AND w.state='REVIEW' AND w.phase='OPERATION' AND w.review_reason='INSERT_DAILY_PREFLIGHT_REPORT_HEALTH_FORMULA' AND epoch.state='ARMED' AND o.state='ADMITTED') incident,
  (SELECT count(*) FROM stable_workbook_claims) claims,(SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW')) epochs,(SELECT count(*) FROM stable_recovery_operations WHERE state='ADMITTED') admissions,
  (SELECT count(*) FROM sync_jobs WHERE status='PROCESSING') processing,(SELECT count(*) FROM staff_config_sync_outbox WHERE status='PROCESSING') staff,
  (SELECT count(*) FROM stable_projection_writes WHERE state<>'VERIFIED') projections,(SELECT count(*) FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED') cancellations`));
 console.log('INCIDENT_PRECHECK: PASS');
 let response;try{response=await fetch(base+'/admin/stable-sync/canary-unwritten-recovery',{method:'POST',headers:{Authorization:'Bearer '+env.MALIPANG_ADMIN_TOKEN,'Content-Type':'application/json','x-malipang-expected-worker-version':workerVersion},body:JSON.stringify({action:phase}),redirect:'error',signal:AbortSignal.timeout(240000)});}catch{fail('INCIDENT_OUTCOME_UNKNOWN_NO_RETRY')}
 let result;try{result=await response.json()}catch{fail('INCIDENT_OUTCOME_UNKNOWN_NO_RETRY')}
 const outcome=phase==='PROBE'?'READY':phase==='COMMIT'?'RESUMED':'IN_PROGRESS';
 if(phase==='PROBE'){const diagnostic=safeProbeDiagnostic(result);if(diagnostic)console.log(diagnostic);}
 if(!response.ok||result?.ok!==true||result.action!==phase||result.outcome!==outcome||result.servedVersion!==workerVersion)fail('INCIDENT_OUTCOME_UNVERIFIED_NO_RETRY');
 try{verifyPhase(phase,await query('SELECT state FROM canary_unwritten_recovery'),true)}catch{fail('INCIDENT_POSTSTATE_UNVERIFIED_NO_RETRY')}
 console.log(`INCIDENT_${phase}: PASS; WORKER_MATCH; D1_READBACK_PASS`);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(e=>{console.error(/^[A-Z][A-Z0-9_]+$/.test(e?.message||'')?e.message:'INCIDENT_UNKNOWN_ERROR_NO_RETRY');process.exitCode=1});
