import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const phases={
 VERIFY:{before:['IN_FLIGHT',null],after:['VERIFIED',null]},
 TIME:{before:['VERIFIED',null],after:['VERIFIED','TIME_IN_FLIGHT']},
 TIME_READBACK:{before:['VERIFIED','TIME_IN_FLIGHT'],after:['VERIFIED','TIME_VERIFIED']},
 PROBE_STATUS:{before:['VERIFIED','TIME_VERIFIED'],after:['VERIFIED','TIME_VERIFIED']},
 STATUS:{before:['VERIFIED','TIME_VERIFIED'],after:['VERIFIED','STATUS_ACKED']},
 COMMIT:{before:['VERIFIED','STATUS_ACKED'],after:['VERIFIED','COMPLETE']}
};
const fail=code=>{throw Error(code)};
export function validateInputs(e){
 const sha=e.EXPECTED_SHA||'',phase=e.RECOVERY_PHASE||'';
 if(!/^[a-f0-9]{40}$/.test(sha)||sha!==e.GITHUB_SHA||e.GITHUB_REF!=='refs/heads/main'||e.GITHUB_RUN_ATTEMPT!=='1')fail('RAW_SHA_GUARD');
 if(!Object.hasOwn(phases,phase)||e.CONFIRMATION!==`OWNER APPROVES RAW ${phase} ${sha.slice(0,7)}`)fail('RAW_CONFIRMATION_INVALID');
 if(!/^[a-f0-9]{64}$/.test(e.EXPECTED_WORKER_VERSION_SHA256||'')||e.EXTERNAL_WRITERS_FENCED!=='true'||e.OWNER_SUPERVISING!=='true')fail('RAW_ATTESTATION_MISSING');
 if(!e.CLOUDFLARE_ACCOUNT_ID||!e.CLOUDFLARE_API_TOKEN||!e.MALIPANG_ADMIN_TOKEN||!e.MALIPANG_WORKER_URL)fail('RAW_CREDENTIALS_MISSING');
 const url=new URL(e.MALIPANG_WORKER_URL);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('RAW_URL_INVALID');
 return {phase,base:url.origin};
}
export function verifyState(phase,rows,after=false){
 if(!Object.hasOwn(phases,phase)||!Array.isArray(rows)||rows.length!==1)fail('RAW_STATE_INVALID');
 const r=rows[0],expected=phases[phase][after?'after':'before'],done=phase==='COMMIT'&&after;
 const values={canary:'ARMED_CONFIRM',source:'CONFIRMED',version:1,projection:expected[0],notice:expected[1],notice_count:expected[1]===null?0:1,claims:done?0:1,epochs:1,admissions:done?0:1,verified_admissions:done?1:0,processing:0,staff:0,unverified_projections:expected[0]==='IN_FLIGHT'?1:0,unverified_cancellations:0,job:done?'PENDING':'REVIEW'};
 if(Object.entries(values).some(([k,v])=>r[k]!==v))fail('RAW_STATE_INVALID');
}
async function main(){
 const env=process.env,{phase,base}=validateInputs(env),cfg=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')),db=cfg.d1_databases?.find(x=>x.binding==='DB');
 if(!db?.database_id||db.database_name!=='malipang-v5-2')fail('RAW_DATABASE_NOT_PINNED');
 const cf=async(method,path,body)=>{const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});if(!r.ok)fail('RAW_CLOUDFLARE_HTTP');const v=await r.json();if(!v.success)fail('RAW_CLOUDFLARE_API_FAILED');return v.result;};
 const account=env.CLOUDFLARE_ACCOUNT_ID,dep=await cf('GET',`/accounts/${account}/workers/scripts/malipang-backend-v5-2/deployments?per_page=2`),versions=dep.deployments?.[0]?.versions||[];
 if(versions.length!==1||versions[0].percentage!==100||!/^[a-f0-9-]{36}$/.test(versions[0].version_id||''))fail('RAW_WORKER_DEPLOYMENT_INVALID');
 const workerVersion=versions[0].version_id;if(createHash('sha256').update(workerVersion).digest('hex')!==env.EXPECTED_WORKER_VERSION_SHA256)fail('RAW_WORKER_VERSION_CHANGED');
 const sql=`SELECT c.state canary,e.status source,e.version version,j.status job,p.state projection,
 (SELECT n.state FROM continuous_review_notice_close n WHERE n.expense_id=c.expense_id AND n.projection='EXPENSE_RAW' AND n.source_version=1 LIMIT 1) notice,
 (SELECT count(*) FROM continuous_review_notice_close n WHERE n.expense_id=c.expense_id AND n.projection='EXPENSE_RAW' AND n.source_version=1) notice_count,
 (SELECT count(*) FROM stable_workbook_claims) claims,(SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW')) epochs,
 (SELECT count(*) FROM stable_recovery_operations o JOIN stable_recovery_epochs ep ON ep.epoch_id=o.epoch_id WHERE ep.target_key=c.expense_id AND o.state='ADMITTED') admissions,
 (SELECT count(*) FROM stable_recovery_operations o JOIN stable_recovery_epochs ep ON ep.epoch_id=o.epoch_id WHERE ep.target_key=c.expense_id AND o.state='VERIFIED' AND o.operation_token=p.operation_token) verified_admissions,
 (SELECT count(*) FROM sync_jobs WHERE status='PROCESSING') processing,(SELECT count(*) FROM staff_config_sync_outbox WHERE status='PROCESSING') staff,
 (SELECT count(*) FROM stable_projection_writes WHERE state<>'VERIFIED') unverified_projections,(SELECT count(*) FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED') unverified_cancellations
 FROM continuous_canary_operator c JOIN expense_events e ON e.expense_id=c.expense_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=c.expense_id AND j.entity_version=1 JOIN stable_projection_writes p ON p.entity_type='EXPENSE' AND p.entity_id=c.expense_id AND p.projection='EXPENSE_RAW' AND p.source_version=1 WHERE c.state='ARMED_CONFIRM' AND e.description='[SYSTEM TEST] Synthetic expense - cancel after verification' AND e.amount_satang=100`;
 const read=async()=>{const x=await cf('POST',`/accounts/${account}/d1/database/${db.database_id}/query`,{sql});if(!Array.isArray(x)||x.length!==1||x[0].success!==true||!Array.isArray(x[0].results))fail('RAW_D1_READ_INVALID');return x[0].results;};
 verifyState(phase,await read());console.log('RAW_PRECHECK: PASS');
 let response;try{response=await fetch(base+'/admin/stable-sync/canary-raw-incident',{method:'POST',headers:{Authorization:'Bearer '+env.MALIPANG_ADMIN_TOKEN,'Content-Type':'application/json','x-malipang-expected-worker-version':workerVersion},body:JSON.stringify({action:phase}),redirect:'error',signal:AbortSignal.timeout(240000)});}catch{fail('RAW_OUTCOME_UNKNOWN_NO_RETRY')}
 let result;try{result=await response.json()}catch{fail('RAW_OUTCOME_UNKNOWN_NO_RETRY')}
 if(phase==='PROBE_STATUS'&&result?.ok===false){const d=result.diagnostic;if(/^(PRECHECK|AUTH|SCOPE|ACTIVATION|D1_EVIDENCE|SOURCE|GRID|SNAPSHOT|LEGACY|FORMAT|NOTICE|POSTIMAGE|ACCOUNTING|CARRIER|REPORT|FINAL_READS|RETAINED|NOTICE_STYLE)$/.test(d?.stage||'')&&Number.isInteger(d.remaining)&&d.remaining>=-1&&d.remaining<=40)console.log(`RAW_PROBE_${d.stage}_REMAINING_${d.remaining}`);}
 if(!response.ok||result?.ok!==true||result.action!==phase||result.outcome!==(phase==='COMMIT'?'RESUMED':phase==='PROBE_STATUS'?'READY':'IN_PROGRESS')||result.servedVersion!==workerVersion)fail('RAW_OUTCOME_UNVERIFIED_NO_RETRY');
 try{verifyState(phase,await read(),true)}catch{fail('RAW_POSTSTATE_UNVERIFIED_NO_RETRY')}
 console.log(`RAW_${phase}: PASS; WORKER_MATCH; D1_READBACK_PASS`);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(e=>{console.error(/^[A-Z][A-Z0-9_]+$/.test(e?.message||'')?e.message:'RAW_UNKNOWN_ERROR_NO_RETRY');process.exitCode=1});
