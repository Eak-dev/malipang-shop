import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const transitions={
 PREPARE:{before:[],after:['DRAFT']}, CONFIRM:{before:['DRAFT'],after:['CONFIRMED']},
 ARM_CONFIRM:{before:['CONFIRMED'],after:['ARMED_CONFIRM']},
 ARM_DUPLICATE:{before:['ARMED_CONFIRM'],after:['DUPLICATE_ARMED','DUPLICATE_SEEN']},
 VERIFY_DUPLICATE:{before:['DUPLICATE_SEEN'],after:['DUPLICATE_VERIFIED']},
 UNDO:{before:['DUPLICATE_VERIFIED'],after:['UNDONE']}, ARM_UNDO:{before:['UNDONE'],after:['ARMED_UNDO']},
 VERIFY:{before:['ARMED_UNDO'],after:['VERIFIED']},
 RECONCILE_CONFIRM:{before:['CONFIRMING','CONFIRMED'],after:['DRAFT','CONFIRMED']},
 RECONCILE_UNDO:{before:['UNDOING'],after:['UNDONE']}
};
const fail=code=>{throw Error(code)};
export function validateInputs(e){
 const sha=e.EXPECTED_SHA||'', action=e.CANARY_ACTION||'';
 if(!/^[a-f0-9]{40}$/.test(sha)||sha!==e.GITHUB_SHA||e.GITHUB_REF!=='refs/heads/main')fail('CANARY_SHA_GUARD');
 if(!Object.hasOwn(transitions,action))fail('CANARY_ACTION_INVALID');
 if(e.CONFIRMATION!==`OWNER APPROVES ${action} ${sha.slice(0,7)}`)fail('CANARY_CONFIRMATION_INVALID');
 if(!/^[a-f0-9]{64}$/.test(e.EXPECTED_WORKER_VERSION_SHA256||''))fail('CANARY_VERSION_HASH_INVALID');
 if(e.EXTERNAL_WRITERS_FENCED!=='true'||e.OWNER_SUPERVISING!=='true')fail('CANARY_ATTESTATION_MISSING');
 if(!e.CLOUDFLARE_ACCOUNT_ID||!e.CLOUDFLARE_API_TOKEN||!e.MALIPANG_ADMIN_TOKEN||!e.MALIPANG_WORKER_URL)fail('CANARY_CREDENTIALS_MISSING');
 const url=new URL(e.MALIPANG_WORKER_URL);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('CANARY_URL_INVALID');
 return {action,base:url.origin};
}
export function verifyState(action,rows,cutover,operator,attempts,after=false,previousId=null){
 if(cutover.length!==1||cutover[0].state!=='ACTIVE'||operator.length!==1||operator[0].state!=='COMPLETE'||attempts.length!==3||new Set(attempts.map(x=>x.stage)).size!==3||!['VIEWS','DAILY_J','REPORTS'].every(stage=>attempts.some(x=>x.stage===stage&&x.state==='VERIFIED')))fail('CANARY_CUTOVER_INVALID');
 const expected=transitions[action]?.[after?'after':'before'];
 if(!expected)fail('CANARY_ACTION_INVALID');
 if(!after&&action==='PREPARE'){if(rows.length!==0)fail('CANARY_STATE_INVALID');return;}
 if(rows.length!==1||!expected.includes(rows[0].state)||!/^exp_canary_[a-f0-9]{32}$/.test(rows[0].expense_id||''))fail('CANARY_STATE_INVALID');
 if(previousId&&rows[0].expense_id!==previousId)fail('CANARY_IDENTITY_CHANGED');
}
async function main(){
 const env=process.env,{action,base}=validateInputs(env);
 const cfg=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 const db=cfg.d1_databases?.find(x=>x.binding==='DB');
 if(!db?.database_id||db.database_name!=='malipang-v5-2')fail('CANARY_DATABASE_NOT_PINNED');
 const cf=async(method,path,body)=>{
  const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!r.ok)fail('CANARY_CLOUDFLARE_HTTP');
  const v=await r.json();if(!v.success)fail('CANARY_CLOUDFLARE_API_FAILED');return v.result;
 };
 const account=env.CLOUDFLARE_ACCOUNT_ID;
 const dep=await cf('GET',`/accounts/${account}/workers/scripts/malipang-backend-v5-2/deployments?per_page=2`);
 const versions=dep.deployments?.[0]?.versions||[];
 if(versions.length!==1||versions[0].percentage!==100||!/^[a-f0-9-]{36}$/.test(versions[0].version_id||''))fail('CANARY_WORKER_DEPLOYMENT_INVALID');
 const workerVersion=versions[0].version_id;
 if(createHash('sha256').update(workerVersion).digest('hex')!==env.EXPECTED_WORKER_VERSION_SHA256)fail('CANARY_WORKER_VERSION_CHANGED');
 const query=async sql=>{
  const r=await cf('POST',`/accounts/${account}/d1/database/${db.database_id}/query`,{sql});
  if(!Array.isArray(r)||r.length!==1||r[0].success!==true||!Array.isArray(r[0].results))fail('CANARY_D1_READ_INVALID');
  return r[0].results;
 };
 const readState=async()=>Promise.all([
  query('SELECT state,expense_id FROM continuous_canary_operator'),
  query('SELECT state FROM continuous_daily_cutovers'),query('SELECT state FROM continuous_cutover_operator'),
  query('SELECT stage,state FROM continuous_report_cutover_attempts')
 ]);
 const [rows,cutover,operator,attempts]=await readState();
 verifyState(action,rows,cutover,operator,attempts);
 const blockers=await query("SELECT (SELECT count(*) FROM stable_workbook_claims) claims,(SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW')) epochs,(SELECT count(*) FROM stable_recovery_operations WHERE state='ADMITTED') recovery,(SELECT count(*) FROM sync_jobs WHERE status='PROCESSING') processing,(SELECT count(*) FROM staff_config_sync_outbox WHERE status='PROCESSING') staff,(SELECT count(*) FROM stable_projection_writes WHERE state<>'VERIFIED') projections,(SELECT count(*) FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED') cancellations");
 if(blockers.length!==1||Object.values(blockers[0]).some(x=>Number(x)!==0))fail('CANARY_NOT_QUIESCENT');
 console.log('CANARY_PRECHECK: PASS');
 let response;
 try{response=await fetch(base+'/admin/stable-sync/continuous-canary',{method:'POST',headers:{Authorization:'Bearer '+env.MALIPANG_ADMIN_TOKEN,'Content-Type':'application/json','x-malipang-expected-worker-version':workerVersion},body:JSON.stringify({action}),redirect:'error',signal:AbortSignal.timeout(240000)});}
 catch{fail('CANARY_OUTCOME_UNKNOWN_NO_RETRY')}
 let result;try{result=await response.json()}catch{fail('CANARY_OUTCOME_UNKNOWN_NO_RETRY')}
 if(!response.ok||result?.ok!==true||result.action!==action||result.servedVersion!==workerVersion)fail('CANARY_OUTCOME_UNVERIFIED_NO_RETRY');
 try{const after=await readState();verifyState(action,...after,true,rows[0]?.expense_id||null)}catch{fail('CANARY_POSTSTATE_UNVERIFIED_NO_RETRY')}
 console.log(`CANARY_${action}: PASS; WORKER_MATCH; D1_READBACK_PASS`);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)main().catch(e=>{console.error(/^[A-Z][A-Z0-9_]+$/.test(e?.message||'')?e.message:'CANARY_UNKNOWN_ERROR_NO_RETRY');process.exitCode=1});
