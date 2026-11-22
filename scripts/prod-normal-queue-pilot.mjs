import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {requireVerifiedBackup} from './prod-monthly-report.mjs';

const phases=['PROBE','SETTLE','HANDOVER_ONE','INSPECT_HANDOVER','READBACK'];
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
const mutating=phase=>['SETTLE','HANDOVER_ONE'].includes(phase);
function stop(code){throw Error(code);}
export function pilotInputs(env){
  const phase=env.PILOT_PHASE;
  if(!phases.includes(phase)||env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_RUN_ATTEMPT!=='1'||
    !/^[a-f0-9]{40}$/.test(env.EXPECTED_SHA)||env.EXPECTED_SHA!==env.GITHUB_SHA||
    !digest.test(env.EXPECTED_WORKER_VERSION_SHA256))stop('PILOT_INPUT_INVALID');
  if(!env.CLOUDFLARE_ACCOUNT_ID||!env.CLOUDFLARE_API_TOKEN||!env.MALIPANG_ADMIN_TOKEN)stop('PILOT_AUTH_UNAVAILABLE');
  if(mutating(phase)&&(!/^[1-9][0-9]{0,19}$/.test(env.BACKUP_RUN_ID||'')||!env.GITHUB_TOKEN||
    env.OWNER_SUPERVISING!=='true'||env.EXTERNAL_WRITERS_FENCED!=='true'))stop('PILOT_PREFLIGHT_MISSING');
  const base=new URL(env.MALIPANG_WORKER_URL);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')stop('PILOT_URL_INVALID');
  return {phase,base:base.origin};
}

const candidates=`SELECT j.job_id FROM sync_jobs j JOIN expense_events e
  ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version
  JOIN continuous_daily_post_cutover_expenses p ON p.expense_id=e.expense_id
  JOIN continuous_daily_cutovers c ON c.spreadsheet_id=p.spreadsheet_id AND c.state='ACTIVE'
  WHERE j.status='PENDING' AND j.attempt_count=0 AND j.lease_token IS NULL AND j.lease_until IS NULL
    AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND e.status='CONFIRMED' AND e.version=1 AND substr(e.transaction_date,1,7)=strftime('%Y-%m','now','+7 hours')
    AND NOT EXISTS(SELECT 1 FROM admin_audit WHERE action='ISSUE296_PAUSED_NOTICE_HANDOVER')
  ORDER BY j.updated_at,j.entity_key LIMIT 1`;
const reserved="SELECT entity_key AS job_id,reason AS fingerprint FROM admin_audit WHERE action='ISSUE296_PAUSED_NOTICE_HANDOVER' LIMIT 2";

export async function runNormalPilot(env,fetchImpl=fetch){
  const {phase,base}=pilotInputs(env);
  if(mutating(phase))await requireVerifiedBackup(env,fetchImpl);
  const cfg=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  const db=cfg.d1_databases?.find(x=>x.binding==='DB'&&x.database_name==='malipang-v5-2');
  if(!uuid.test(db?.database_id||'')||cfg.name!=='malipang-backend-v5-2')stop('PILOT_BINDINGS_INVALID');
  const cf=async(path,sql)=>{
    const response=await fetchImpl('https://api.cloudflare.com/client/v4/accounts/'+env.CLOUDFLARE_ACCOUNT_ID+path,{
      method:sql?'POST':'GET',headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'Content-Type':'application/json'},
      body:sql?JSON.stringify({sql}):undefined,redirect:'error',signal:AbortSignal.timeout(30000)
    });
    if(!response.ok)stop('PILOT_CLOUDFLARE_UNAVAILABLE');
    const data=await response.json();
    if(data.success!==true)stop('PILOT_CLOUDFLARE_UNVERIFIED');
    return data.result;
  };
  const rows=async sql=>{
    const result=await cf('/d1/database/'+db.database_id+'/query',sql);
    if(result?.length!==1||result[0]?.success!==true||!Array.isArray(result[0]?.results))stop('PILOT_D1_UNVERIFIED');
    return result[0].results;
  };
  const deployments=await cf('/workers/scripts/'+cfg.name+'/deployments?per_page=2');
  const versions=deployments.deployments?.[0]?.versions, version=versions?.[0]?.version_id;
  if(versions?.length!==1||versions[0].percentage!==100||!uuid.test(version)||
    createHash('sha256').update(version).digest('hex')!==env.EXPECTED_WORKER_VERSION_SHA256)stop('PILOT_WORKER_CHANGED');
  const request=async(route,body,expected)=>{
    let response,out;
    try{
      response=await fetchImpl(base+'/admin/stable-sync/'+route,{
        method:'POST',headers:{Authorization:'Bearer '+env.MALIPANG_ADMIN_TOKEN,'Content-Type':'application/json','x-malipang-expected-worker-version':version},
        body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(240000)
      });
      out=await response.json();
    }catch{stop('PILOT_RESPONSE_UNKNOWN_NO_RETRY');}
    if(out.servedVersion!==version||!response.ok||out.ok!==true||!expected.includes(out.outcome)){
      const allowed=['CONFIG','INCIDENT','SOURCE','NOTICE','GRID','SNAPSHOT','LEGACY','FORMAT','POSTIMAGE','ACCOUNTING','CARRIER','REPORT','FINAL_READS','PREIMAGE','SETTLEMENT','READBACK'];
      if(out.servedVersion===version&&allowed.includes(out.stage))console.log('PILOT_HELD_STAGE='+out.stage);
      stop('PILOT_RESULT_UNVERIFIED_NO_RETRY');
    }
    return out;
  };
  const incident=(body,success)=>request('exact-daily-settlement',body,[success]);
  const takeover=(body,success)=>request('normal-expense-pilot',body,success);
  if(phase==='READBACK'){
    await request('normal-pilot-readback',{action:'READBACK'},['MATCHED']);
    return 'PILOT_DAILY_D1_MATCHED';
  }
  if(phase==='INSPECT_HANDOVER'){
    const audit=await rows(reserved);
    if(audit.length===0)return 'PILOT_NO_HANDOVER_RECORDED';
    if(audit.length!==1||!uuid.test(audit[0].job_id)||!digest.test(audit[0].fingerprint))stop('PILOT_AUDIT_UNVERIFIED');
    const result=await takeover({action:phase,jobId:audit[0].job_id,fingerprint:audit[0].fingerprint},['RESERVED','ADOPTED','STAGE_VERIFIED','HELD']);
    return 'PILOT_'+result.outcome;
  }
  const state=await incident({action:'INSPECT'},'INSPECTED'), fingerprint=state.fingerprint;
  if(!digest.test(fingerprint))stop('PILOT_INCIDENT_UNVERIFIED');
  if(phase==='HANDOVER_ONE'){
    if(state.projectionState!=='VERIFIED'||!digest.test(state.preimageDigest))stop('PILOT_ORIGINAL_UNVERIFIED');
    const found=await rows(candidates);
    if(found.length!==1||!uuid.test(found[0].job_id))stop('PILOT_NO_EXACT_CANDIDATE');
    await takeover({action:phase,jobId:found[0].job_id,fingerprint,preimageDigest:state.preimageDigest,
      externalWritersFenced:true,ownerSupervising:true},['RESERVED']);
    return 'PILOT_ONE_RESERVED';
  }
  if(state.projectionState==='VERIFIED'&&digest.test(state.preimageDigest))return 'PILOT_ORIGINAL_ALREADY_SETTLED';
  if(state.projectionState!=='IN_FLIGHT'||state.preimageDigest!==null)stop('PILOT_ORIGINAL_UNVERIFIED');
  const proof=await incident({action:'PROBE',fingerprint},'MATCHED');
  if(proof.fingerprint!==fingerprint||!digest.test(proof.preimageDigest))stop('PILOT_PROOF_UNVERIFIED');
  if(phase==='PROBE')return 'PILOT_ORIGINAL_MATCHED';
  const saved=await incident({action:'SETTLE',fingerprint,preimageDigest:proof.preimageDigest,
    externalWritersFenced:true,ownerSupervising:true},'SETTLED');
  if(saved.fingerprint!==fingerprint||saved.preimageDigest!==proof.preimageDigest)stop('PILOT_SETTLEMENT_UNKNOWN_NO_RETRY');
  return 'PILOT_ORIGINAL_SETTLED_JOB_HELD';
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  runNormalPilot(process.env).then(result=>console.log(result)).catch(error=>{
    console.error(/^(PILOT|MONTHLY)_[A-Z_]+$/.test(error?.message||'')?error.message:'PILOT_UNKNOWN_NO_RETRY');
    process.exitCode=1;
  });
}
