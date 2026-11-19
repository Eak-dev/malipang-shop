import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const allowedActions=['PRECHECK','START_REVIEW','VIEWS','DAILY_J','REPORTS','ACTIVATE','RELEASE'];
const fail=c=>{throw new Error(c)};
export function validateInputs(e){
 const sha=e.EXPECTED_SHA||'',action=e.CUTOVER_ACTION||'';
 if(!/^[0-9a-f]{40}$/.test(sha)||sha!==e.GITHUB_SHA||e.GITHUB_REF!=='refs/heads/main')fail('CUTOVER_SHA_GUARD');
 if(!allowedActions.includes(action))fail('CUTOVER_ACTION_INVALID');
 if(e.CONFIRMATION!=='OWNER APPROVES '+action+' '+sha.slice(0,7))fail('CUTOVER_CONFIRMATION_INVALID');
 if(!/^[0-9a-f]{64}$/.test(e.EXPECTED_WORKER_VERSION_SHA256||''))fail('CUTOVER_VERSION_HASH_INVALID');
 if(action!=='PRECHECK'&&[e.EXTERNAL_WRITERS_FENCED,e.PROVIDER_OUTCOME_REVIEWED,e.OWNER_SUPERVISING].some(x=>x!=='true'))fail('CUTOVER_OWNER_ATTESTATION_MISSING');
 if(!e.CLOUDFLARE_ACCOUNT_ID||!e.CLOUDFLARE_API_TOKEN||!e.MALIPANG_ADMIN_TOKEN||!e.MALIPANG_WORKER_URL)fail('CUTOVER_CREDENTIALS_MISSING');
 const url=new URL(e.MALIPANG_WORKER_URL);
 if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!(url.pathname==='/'||url.pathname===''))fail('CUTOVER_URL_INVALID');
 return {sha,action,base:url.origin};
}
export const expectedBefore={PRECHECK:[],START_REVIEW:[],VIEWS:[],DAILY_J:['VIEWS'],REPORTS:['VIEWS','DAILY_J'],ACTIVATE:['VIEWS','DAILY_J','REPORTS'],RELEASE:['VIEWS','DAILY_J','REPORTS']};
export function verifyReadiness(action,claims,operators,attempts,cutover,unknown){
 if(Object.values(unknown).some(x=>Number(x)!==0))fail('CUTOVER_UNRESOLVED_D1');
 if(claims.length!==1||!['REVIEW','HELD'].includes(claims[0].state))fail('CUTOVER_CLAIM_INVALID');
 if(action==='PRECHECK'||action==='START_REVIEW'){
  if(claims[0].state!=='REVIEW'||claims[0].phase!=='OPERATION'||claims[0].review_reason!=='STABLE_DAILY_REVIEW'||operators.length!==0||attempts.length!==0||cutover.length!==0)fail('CUTOVER_START_NOT_READY');return;
 }
 if(claims[0].state!=='HELD'||operators.length!==1||operators[0].state!=='HELD')fail('CUTOVER_OPERATOR_NOT_HELD');
 const expected=expectedBefore[action];
 if(attempts.length!==expected.length||attempts.some(x=>x.state!=='VERIFIED')||new Set(attempts.map(x=>x.stage)).size!==attempts.length||!expected.every(s=>attempts.some(x=>x.stage===s)))fail('CUTOVER_STAGES_NOT_READY');
 if(action==='RELEASE'?cutover.length!==1||cutover[0].state!=='ACTIVE':cutover.length!==0)fail('CUTOVER_ACTIVE_STATE_INVALID');
}
async function main(){
 const env=process.env,{action,base}=validateInputs(env);
 const cfg=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
 const db=cfg.d1_databases?.find(x=>x.binding==='DB');
 if(!db?.database_id||db.database_name!=='malipang-v5-2')fail('CUTOVER_DATABASE_NOT_PINNED');
 const account=env.CLOUDFLARE_ACCOUNT_ID,token=env.CLOUDFLARE_API_TOKEN;
 const cf=async(method,path,body)=>{
  const r=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{Authorization:'Bearer '+token,Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(30000)});
  if(!r.ok)fail('CUTOVER_CLOUDFLARE_HTTP_'+r.status);
  const v=await r.json();if(!v.success)fail('CUTOVER_CLOUDFLARE_API_FAILED');return v.result;
 };
 const dep=await cf('GET','/accounts/'+account+'/workers/scripts/malipang-backend-v5-2/deployments?per_page=2');
 const versions=dep.deployments?.[0]?.versions||[];
 if(versions.length!==1||versions[0]?.percentage!==100||!/^[a-f0-9-]{36}$/.test(versions[0]?.version_id||''))fail('CUTOVER_WORKER_DEPLOYMENT_INVALID');
 const workerVersion=versions[0].version_id;
 if(createHash('sha256').update(workerVersion).digest('hex')!==env.EXPECTED_WORKER_VERSION_SHA256)fail('CUTOVER_WORKER_VERSION_CHANGED');
 const query=async(sql,params=[])=>{
  const result=await cf('POST','/accounts/'+account+'/d1/database/'+db.database_id+'/query',{sql,params});
  if(!Array.isArray(result)||result.length!==1||result[0].success!==true||!Array.isArray(result[0].results))fail('CUTOVER_D1_READ_INVALID');
  return result[0].results;
 };
 const status=await query("SELECT (SELECT count(*) FROM stable_projection_writes WHERE state <> 'VERIFIED') AS projections,(SELECT count(*) FROM stable_expense_cancellation_writes WHERE state <> 'VERIFIED') AS cancellations,(SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW')) AS epochs,(SELECT count(*) FROM stable_recovery_operations WHERE state='ADMITTED') AS recovery,(SELECT count(*) FROM sync_jobs WHERE status='PROCESSING') AS processing,(SELECT count(*) FROM staff_config_sync_outbox WHERE status='PROCESSING') AS staff,(SELECT count(*) FROM stable_projection_writes p JOIN stable_workbook_claims c ON p.operation_token=c.operation_token WHERE c.state='REVIEW') AS claim_writes,(SELECT count(*) FROM stable_expense_cancellation_writes p JOIN stable_workbook_claims c ON p.operation_token=c.operation_token WHERE c.state='REVIEW') AS claim_cancels");
 const readState=async()=>Promise.all([query('SELECT state,phase,review_reason FROM stable_workbook_claims'),query('SELECT state FROM continuous_cutover_operator'),query('SELECT stage,state FROM continuous_report_cutover_attempts'),query('SELECT state FROM continuous_daily_cutovers')]);
 const [claims,operators,attempts,cutover]=await readState();
 verifyReadiness(action,claims,operators,attempts,cutover,status[0]);
 console.log('CUTOVER_PRECHECK: PASS');
 if(action==='PRECHECK')return;
 let body={action};
 if(action==='ACTIVATE'){
  const receipts=JSON.parse(env.MALIPANG_CUTOVER_RECEIPTS||'null');
  if(!Array.isArray(receipts)||receipts.length!==2||receipts[0]===receipts[1]||receipts.some(x=>typeof x!=='string'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(x)))fail('CUTOVER_RECEIPTS_MISSING');
  const matches=await query('SELECT expense_id,status FROM expense_events WHERE expense_id IN (?,?)',receipts);
  if(matches.length!==2||matches.some(x=>x.status!=='CANCELLED'))fail('CUTOVER_RECEIPTS_NOT_CANCELLED');
  body={action,expenseIds:receipts};
 }
 // Exactly one HTTP POST; no retry even if the outcome is unknown.
 let response;
 try{response=await fetch(base+'/admin/stable-sync/continuous-cutover',{method:'POST',headers:{Authorization:'Bearer '+env.MALIPANG_ADMIN_TOKEN,'Content-Type':'application/json','x-malipang-expected-worker-version':workerVersion},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(240000)});}
 catch{fail('CUTOVER_OUTCOME_UNKNOWN_NO_RETRY')}
 let result;
 try{result=await response.json();}catch{fail('CUTOVER_OUTCOME_UNKNOWN_NO_RETRY')}
 if(!response.ok||result?.ok!==true||result?.action!==action||result?.servedVersion!==workerVersion)fail('CUTOVER_OUTCOME_UNVERIFIED_NO_RETRY');
 const [afterClaims,afterOperators,afterAttempts,afterCutover]=await readState();
 if(action==='RELEASE'){
  if(afterClaims.length!==0||afterOperators.length!==1||afterOperators[0].state!=='COMPLETE'||afterCutover.length!==1||afterCutover[0].state!=='ACTIVE'||afterAttempts.length!==3||afterAttempts.some(x=>x.state!=='VERIFIED'))fail('CUTOVER_POSTSTATE_UNVERIFIED_NO_RETRY');
 }else{
  if(afterClaims.length!==1||afterClaims[0].state!=='HELD'||afterOperators.length!==1||afterOperators[0].state!=='HELD')fail('CUTOVER_POSTSTATE_UNVERIFIED_NO_RETRY');
  const expectedAfter=action==='START_REVIEW'?[]:[...expectedBefore[action],action==='ACTIVATE'?'':action].filter(Boolean);
  if(afterAttempts.length!==expectedAfter.length||!expectedAfter.every(s=>afterAttempts.some(x=>x.stage===s&&x.state==='VERIFIED'))||action==='ACTIVATE'&&!(afterCutover.length===1&&afterCutover[0].state==='ACTIVE'))fail('CUTOVER_POSTSTATE_UNVERIFIED_NO_RETRY');
 }
 console.log('CUTOVER_'+action+': PASS; WORKER_MATCH; D1_READBACK_PASS');
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
 main().catch(e=>{console.error(/^[A-Z][A-Z0-9_]+$/.test(e?.message||'')?e.message:'CUTOVER_UNKNOWN_ERROR_NO_RETRY');process.exitCode=1});
}
