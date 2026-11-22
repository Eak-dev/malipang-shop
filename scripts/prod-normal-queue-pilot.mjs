import {createHash} from 'node:crypto';
import {appendFileSync,readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {requireVerifiedBackup} from './prod-monthly-report.mjs';

const phases=['PROBE','SETTLE','HANDOVER_ONE','INSPECT_HANDOVER','READBACK','FINISH_PILOT','RUN_SERIAL'];
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest=/^[a-f0-9]{64}$/;
const mutating=phase=>['SETTLE','HANDOVER_ONE','RUN_SERIAL'].includes(phase);
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

const pending=`SELECT j.job_id FROM sync_jobs j JOIN expense_events e
  ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version
  JOIN continuous_daily_post_cutover_expenses p ON p.expense_id=e.expense_id
  JOIN continuous_daily_cutovers c ON c.spreadsheet_id=p.spreadsheet_id AND c.state='ACTIVE'
  WHERE j.status='PENDING' AND j.attempt_count=0 AND j.lease_token IS NULL AND j.lease_until IS NULL
    AND (j.next_attempt_at IS NULL OR j.next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND e.status='CONFIRMED' AND e.version=1 AND substr(e.transaction_date,1,7)=strftime('%Y-%m','now','+7 hours')`;
const queueOrder=' ORDER BY j.updated_at,j.entity_key';
const candidates=pending+" AND NOT EXISTS(SELECT 1 FROM admin_audit WHERE action='ISSUE296_PAUSED_NOTICE_HANDOVER')"+queueOrder+' LIMIT 1';
const serialCandidates=pending+" AND length(e.transaction_date)=10 AND date(e.transaction_date,'+0 days')=e.transaction_date"+queueOrder;
const reserved="SELECT entity_key AS job_id,reason AS fingerprint FROM admin_audit WHERE action='ISSUE296_PAUSED_NOTICE_HANDOVER' LIMIT 2";

const rootAction='ISSUE296_PAUSED_NOTICE_HANDOVER';
const successorAction='ISSUE296_SERIAL_EXPENSE_HANDOVER';
const serialAudit=`SELECT id,action,entity_key AS job_id,reason AS fingerprint,
  json_extract(before_json,'$.book') AS book,json_extract(before_json,'$.predecessorJobId') AS predecessor,
  json_extract(before_json,'$.proof') AS proof,json_extract(after_json,'$.version') AS version
  FROM admin_audit WHERE action IN ('${rootAction}','${successorAction}')`;

// Reconstruct one immutable chain. Creation timestamps cannot identify a committed
// successor after response loss and cannot distinguish forks or disconnected links.
function orderedChain(audits,version){
  if(!audits.length)return [];
  const roots=audits.filter(row=>row.action===rootAction);
  if(roots.length!==1)stop('PILOT_SERIAL_CHAIN_UNVERIFIED');
  const root=roots[0],children=new Map(),jobs=new Set();
  if(!root.book||!digest.test(root.fingerprint))stop('PILOT_SERIAL_CHAIN_UNVERIFIED');
  for(const row of audits){
    if(!uuid.test(row.job_id)||jobs.has(row.job_id)||row.version!==version||
      row.book!==root.book||row.fingerprint!==root.fingerprint)stop('PILOT_SERIAL_CHAIN_UNVERIFIED');
    jobs.add(row.job_id);
    if(row===root)continue;
    if(row.action!==successorAction||!uuid.test(row.predecessor)||!digest.test(row.proof)||
      row.id!=='issue296:serial:'+row.predecessor||children.has(row.predecessor))stop('PILOT_SERIAL_CHAIN_UNVERIFIED');
    children.set(row.predecessor,row);
  }
  const chain=[root];
  while(children.has(chain.at(-1).job_id)){
    const previous=chain.at(-1).job_id;
    chain.push(children.get(previous));
    children.delete(previous);
  }
  if(children.size)stop('PILOT_SERIAL_CHAIN_UNVERIFIED');
  return chain;
}

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
  const readback=identity=>request('normal-pilot-readback',{action:'READBACK',...identity},['MATCHED']);
  const finish=async(jobId,fingerprint,serial=false)=>{
    const identity=serial?{jobId,fingerprint}:undefined;
    const status=()=>takeover({action:'FINISH_STATUS',jobId,fingerprint},
      ['NOT_STARTED','IN_PROGRESS','JOB_REVIEW','JOB_FAILED','JOB_COMPLETE','UNVERIFIED']);
    // Observe one identity throughout. No provider writes, enrollment or replay in this loop.
    for(let observation=0;observation<16;observation++){
      const snapshot=await status(), current=snapshot.outcome;
      if(current==='JOB_COMPLETE'){
        if(typeof snapshot.proof!=='string'||!digest.test(snapshot.proof))stop('PILOT_FINAL_PROOF_UNVERIFIED');
        try{await readback(identity);}catch{stop('PILOT_JOB_COMPLETE_DAILY_UNVERIFIED');}
        const after=await status();
        if(after.outcome!=='JOB_COMPLETE'||after.proof!==snapshot.proof)stop('PILOT_FINAL_STATE_CHANGED');
        return after.proof;
      }
      if(current==='JOB_REVIEW'||current==='JOB_FAILED'){
        let daily='UNVERIFIED';
        try{await readback(identity);daily='MATCHED';}catch{/* The queue outcome still requires follow-up. */}
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
    if(phase==='FINISH_PILOT'){
      await finish(audit[0].job_id,audit[0].fingerprint);
      return 'PILOT_JOB_COMPLETE_DAILY_MATCHED';
    }
    const result=await takeover({action:phase,jobId:audit[0].job_id,fingerprint:audit[0].fingerprint},['RESERVED','ADOPTED','STAGE_VERIFIED','HELD']);
    return 'PILOT_'+result.outcome;
  }
  const inspectOriginal=async()=>{
    const state=await incident({action:'INSPECT'},'INSPECTED');
    if(!digest.test(state.fingerprint))stop('PILOT_INCIDENT_UNVERIFIED');
    return state;
  };
  const settleOriginal=async(state,probeOnly)=>{
    const {fingerprint}=state;
    if(state.projectionState==='VERIFIED'&&digest.test(state.preimageDigest))return {label:'PILOT_ORIGINAL_ALREADY_SETTLED',preimageDigest:state.preimageDigest};
    if(state.projectionState!=='IN_FLIGHT'||state.preimageDigest!==null)stop('PILOT_ORIGINAL_UNVERIFIED');
    const proof=await incident({action:'PROBE',fingerprint},'MATCHED');
    if(proof.fingerprint!==fingerprint||!digest.test(proof.preimageDigest))stop('PILOT_PROOF_UNVERIFIED');
    if(probeOnly)return {label:'PILOT_ORIGINAL_MATCHED',preimageDigest:proof.preimageDigest};
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
    return {label:'PILOT_ORIGINAL_SETTLED_JOB_HELD',preimageDigest:proof.preimageDigest};
  };
  const reserveFirst=async(jobId,fingerprint,preimageDigest)=>{
    try{
      await takeover({action:'HANDOVER_ONE',jobId,fingerprint,preimageDigest,
        externalWritersFenced:true,ownerSupervising:true},['RESERVED']);
    }catch(error){
      const audit=await rows(reserved);
      if(audit.length!==1||audit[0].job_id!==jobId||audit[0].fingerprint!==fingerprint)throw error;
    }
  };
  if(phase==='RUN_SERIAL'){
    const readChain=async()=>orderedChain(await rows(serialAudit),version);
    const chain=await readChain(),tip=chain.at(-1);
    const selected=(await rows(serialCandidates)).map(row=>row.job_id);
    if(selected.some(id=>!uuid.test(id))||new Set(selected).size!==selected.length)stop('PILOT_SERIAL_SELECTION_UNVERIFIED');
    const admitted=new Set(chain.map(row=>row.job_id));
    // The current tip may already be COMPLETED or in REVIEW and absent from pending.
    // New arrivals after selection are outside this protected invocation.
    const plan=[...(tip?[tip.job_id]:[]),...selected.filter(id=>!admitted.has(id))];
    let verified=0;
    if(plan.length===0)return {outcome:'PILOT_SERIAL_FINISHED',verified,remaining:0};
    try{
      let fingerprint=tip?.fingerprint;
      if(!tip){
        const state=await inspectOriginal();
        fingerprint=state.fingerprint;
        const saved=await settleOriginal(state,false);
        await reserveFirst(plan[0],fingerprint,saved.preimageDigest);
      }
      // Leave time for an in-flight request and the final sanitized summary before
      // the 6-hour Actions limit. A later RUN_SERIAL first reconciles the recorded tip.
      const advanceDeadline=Date.now()+5*60*60*1000;
      for(const [index,jobId] of plan.entries()){
        const proof=await finish(jobId,fingerprint,true);
        verified++;
        const nextJobId=plan[index+1];
        if(!nextJobId)break;
        if(Date.now()>=advanceDeadline)stop('PILOT_SERIAL_TIME_BUDGET');
        try{
          await takeover({action:'ADVANCE_ONE',jobId,fingerprint,proof,nextJobId,
            externalWritersFenced:true,ownerSupervising:true},['RESERVED']);
        }catch(error){
          // Only the exact durable edge proves that this attempted reservation committed.
          // A different tip, even if also complete, does not authorize another advance.
          const last=(await readChain()).at(-1);
          if(last?.job_id!==nextJobId||last.predecessor!==jobId||last.proof!==proof||last.fingerprint!==fingerprint)throw error;
        }
      }
      return {outcome:'PILOT_SERIAL_FINISHED',verified,remaining:0};
    }catch(error){
      error.serialProgress={verified,remaining:plan.length-verified};
      throw error;
    }
  }
  const state=await inspectOriginal();
  if(phase==='HANDOVER_ONE'){
    if(state.projectionState!=='VERIFIED'||!digest.test(state.preimageDigest))stop('PILOT_ORIGINAL_UNVERIFIED');
    const found=await rows(candidates);
    if(found.length!==1||!uuid.test(found[0].job_id))stop('PILOT_NO_EXACT_CANDIDATE');
    await reserveFirst(found[0].job_id,state.fingerprint,state.preimageDigest);
    await finish(found[0].job_id,state.fingerprint);
    return 'PILOT_JOB_COMPLETE_DAILY_MATCHED';
  }
  return (await settleOriginal(state,phase==='PROBE')).label;
}

export function describeResult(phase,label){
  if(phase==='RUN_SERIAL')return label==='PILOT_SERIAL_FINISHED'?'ตรวจครบชุดงานที่เลือกสำหรับรอบนี้แล้ว':'รอบต่อเนื่องหยุดตามเหตุด้านล่าง เมื่อเริ่ม RUN_SERIAL อีกครั้ง ตัวรันตรวจงานที่จองล่าสุดก่อนส่งต่อ';
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
  const summarize=(label,progress)=>{
    if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      describeResult(process.env.PILOT_PHASE,label)+'\n\n`'+label+'`\n'+
      (progress?`\nยืนยันในรอบนี้ ${progress.verified} รายการ · ในชุดที่เลือกยังยืนยันไม่ครบ ${progress.remaining} รายการ\n`:''));
  };
  runNormalPilot(process.env).then(result=>{
    const label=result.outcome??result;
    console.log(label);summarize(label,result.outcome?result:undefined);
  }).catch(error=>{
    const label=/^(PILOT|MONTHLY)_[A-Z_]+$/.test(error?.message||'')?error.message:'PILOT_UNKNOWN_NO_RETRY';
    console.error(label);
    summarize(label,error.serialProgress);
    process.exitCode=1;
  });
}
