import {createHash} from 'node:crypto';
import {appendFileSync,readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {requireVerifiedBackup} from './prod-monthly-report.mjs';

const phases=['PROBE','SETTLE','HANDOVER_ONE','INSPECT_HANDOVER','READBACK','FINISH_PILOT'];
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

export async function runNormalPilot(env,fetchImpl=fetch,sleep=delay){
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
        body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(body.action==='FINISH_STATUS'?15000:240000)
      });
      out=await response.json();
    }catch{stop('PILOT_RESPONSE_UNKNOWN_NO_RETRY');}
    if(out?.servedVersion!==version||!response.ok||out.ok!==true||!expected.includes(out.outcome)){
      if(body.action==='FINISH_STATUS'&&out?.servedVersion===version&&out.ok===false&&out.outcome==='UNVERIFIED')stop('PILOT_FINISH_UNVERIFIED');
      const allowed=['CONFIG','INCIDENT','SOURCE','NOTICE','GRID','SNAPSHOT','LEGACY','FORMAT','POSTIMAGE','ACCOUNTING','CARRIER','REPORT','FINAL_READS','PREIMAGE','SETTLEMENT','READBACK'];
      if(out?.servedVersion===version&&allowed.includes(out.stage))stop('PILOT_RESULT_UNVERIFIED_AT_'+out.stage);
      stop('PILOT_RESULT_UNVERIFIED_NO_RETRY');
    }
    return out;
  };
  const incident=(body,success)=>request('exact-daily-settlement',body,[success]);
  const takeover=(body,success)=>request('normal-expense-pilot',body,success);
  const readback=()=>request('normal-pilot-readback',{action:'READBACK'},['MATCHED']);
  const finish=async(jobId,fingerprint)=>{
    const status=async()=>(await takeover({action:'FINISH_STATUS',jobId,fingerprint},
      ['NOT_STARTED','IN_PROGRESS','JOB_REVIEW','JOB_FAILED','JOB_COMPLETE','UNVERIFIED'])).outcome;
    // Observe one identity throughout. No provider writes, enrollment or replay in this loop.
    for(let observation=0;observation<16;observation++){
      const current=await status();
      if(current==='JOB_COMPLETE'){
        try{await readback();}catch{stop('PILOT_JOB_COMPLETE_DAILY_UNVERIFIED');}
        if(await status()!=='JOB_COMPLETE')stop('PILOT_FINAL_STATE_CHANGED');
        return 'PILOT_JOB_COMPLETE_DAILY_MATCHED';
      }
      if(current==='JOB_REVIEW'||current==='JOB_FAILED'){
        let daily='UNVERIFIED';
        try{await readback();daily='MATCHED';}catch{/* The queue outcome still requires follow-up. */}
        stop('PILOT_'+current+'_DAILY_'+daily);
      }
      if(current!=='IN_PROGRESS')stop('PILOT_FINISH_'+current);
      if(observation<15)await sleep(60000);
    }
    stop('PILOT_OBSERVATION_TIMEOUT_IN_PROGRESS');
  };
  if(phase==='READBACK'){
    await readback();
    return 'PILOT_DAILY_D1_MATCHED';
  }
  if(phase==='INSPECT_HANDOVER'||phase==='FINISH_PILOT'){
    const audit=await rows(reserved);
    if(audit.length===0){
      if(phase==='FINISH_PILOT')stop('PILOT_FINISH_NOT_STARTED');
      return 'PILOT_NO_HANDOVER_RECORDED';
    }
    if(audit.length!==1||!uuid.test(audit[0].job_id)||!digest.test(audit[0].fingerprint))stop('PILOT_AUDIT_UNVERIFIED');
    if(phase==='FINISH_PILOT')return finish(audit[0].job_id,audit[0].fingerprint);
    const result=await takeover({action:phase,jobId:audit[0].job_id,fingerprint:audit[0].fingerprint},['RESERVED','ADOPTED','STAGE_VERIFIED','HELD']);
    return 'PILOT_'+result.outcome;
  }
  const state=await incident({action:'INSPECT'},'INSPECTED'), fingerprint=state.fingerprint;
  if(!digest.test(fingerprint))stop('PILOT_INCIDENT_UNVERIFIED');
  if(phase==='HANDOVER_ONE'){
    if(state.projectionState!=='VERIFIED'||!digest.test(state.preimageDigest))stop('PILOT_ORIGINAL_UNVERIFIED');
    const found=await rows(candidates);
    if(found.length!==1||!uuid.test(found[0].job_id))stop('PILOT_NO_EXACT_CANDIDATE');
    const jobId=found[0].job_id;
    try{
      await takeover({action:phase,jobId,fingerprint,preimageDigest:state.preimageDigest,
        externalWritersFenced:true,ownerSupervising:true},['RESERVED']);
    }catch(error){
      // A lost response may follow a committed transfer. Only the matching audit can resume observation.
      const audit=await rows(reserved);
      if(audit.length!==1||audit[0].job_id!==jobId||audit[0].fingerprint!==fingerprint)throw error;
    }
    return finish(jobId,fingerprint);
  }
  if(state.projectionState==='VERIFIED'&&digest.test(state.preimageDigest))return 'PILOT_ORIGINAL_ALREADY_SETTLED';
  if(state.projectionState!=='IN_FLIGHT'||state.preimageDigest!==null)stop('PILOT_ORIGINAL_UNVERIFIED');
  const proof=await incident({action:'PROBE',fingerprint},'MATCHED');
  if(proof.fingerprint!==fingerprint||!digest.test(proof.preimageDigest))stop('PILOT_PROOF_UNVERIFIED');
  if(phase==='PROBE')return 'PILOT_ORIGINAL_MATCHED';
  try{
    const saved=await incident({action:'SETTLE',fingerprint,preimageDigest:proof.preimageDigest,
      externalWritersFenced:true,ownerSupervising:true},'SETTLED');
    if(saved.fingerprint!==fingerprint||saved.preimageDigest!==proof.preimageDigest)stop('PILOT_SETTLEMENT_UNKNOWN_NO_RETRY');
  }catch(error){
    // INSPECT authenticates the exact original REVIEW job, OPEN failure and stored preimage.
    // Positive proof can close the run even if the SETTLE acknowledgment was lost.
    const after=await incident({action:'INSPECT'},'INSPECTED');
    if(after.projectionState!=='VERIFIED'||after.fingerprint!==fingerprint||after.preimageDigest!==proof.preimageDigest)throw error;
  }
  return 'PILOT_ORIGINAL_SETTLED_JOB_HELD';
}

export function describeResult(phase,label){
  if(label==='PILOT_JOB_COMPLETE_DAILY_MATCHED')return 'งานทดลองเสร็จ 1 รายการ รอบคิวปิดแล้ว และแถวรายวันตรงกับ D1';
  if(label==='PILOT_JOB_COMPLETE_DAILY_UNVERIFIED')return 'พบงานและรอบคิวปิดแล้ว แต่ยังยืนยันแถวรายวันกับ D1 ไม่ได้ ให้ตรวจ READBACK ก่อนขยายงาน';
  if(label==='PILOT_ORIGINAL_SETTLED_JOB_HELD'||label==='PILOT_ORIGINAL_ALREADY_SETTLED')
    return 'จบการตรวจ DAILY ของรายการเดิม ผลเขียนได้รับการยืนยัน งานเดิมพัก 1 รายการใน REVIEW ตามที่อนุมัติ';
  if(label==='PILOT_ORIGINAL_MATCHED')return 'ตรวจพบหลักฐาน DAILY ตรงกัน ขั้นบันทึก SETTLE ยังต้องตรวจแยก';
  if(phase==='SETTLE'||phase==='PROBE')return 'รอบนี้ยังยืนยันผลเดิมไม่ครบ ตรวจขั้นที่รายงานและหลักฐาน D1 ก่อนพิจารณาครั้งถัดไป';
  if(label==='PILOT_OBSERVATION_TIMEOUT_IN_PROGRESS')return 'หมดรอบติดตาม งานยังทำต่อได้ในคิว ใช้ FINISH_PILOT เพื่อตรวจผลต่อ';
  if(label.startsWith('PILOT_JOB_REVIEW_')||label.startsWith('PILOT_JOB_FAILED_')){
    const row=label.endsWith('_MATCHED')?'แถวรายวันตรงกับ D1':'ยังยืนยันแถวรายวันไม่ได้';
    return 'งานทดลองยังไม่สำเร็จ 1 รายการ '+row+' ผู้ดูแลตรวจเหตุใน sync_jobs และ failed_jobs ของงานทดลองก่อนดำเนินการต่อ';
  }
  if(label==='PILOT_FINISH_NOT_STARTED'||label==='PILOT_NO_HANDOVER_RECORDED')return 'ยังไม่มีหลักฐานการจองงานทดลอง';
  if(phase==='HANDOVER_ONE'||phase==='FINISH_PILOT')return 'ยังยืนยันผลจบงานทดลองไม่ได้ ตรวจหลักฐานการส่งมอบและใช้ FINISH_PILOT เพื่อติดตามงานที่จองไว้';
  return 'ผลของขั้นตรวจที่เลือกแสดงในรหัสด้านล่าง';
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
  const summarize=label=>{
    if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      describeResult(process.env.PILOT_PHASE,label)+'\n\n`'+label+'`\n');
  };
  runNormalPilot(process.env).then(result=>{console.log(result);summarize(result);}).catch(error=>{
    const label=/^(PILOT|MONTHLY)_[A-Z_]+$/.test(error?.message||'')?error.message:'PILOT_UNKNOWN_NO_RETRY';
    console.error(label);
    summarize(label);
    process.exitCode=1;
  });
}
