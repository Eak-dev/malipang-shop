import { getStaffActorByLineId } from "../access/repository";
import type { Employee, Env, LineEvent, SheetsSyncJob } from "../types";
import { stableWorkbookInReview } from "../sheets/stable-workbook-claim";
import {recoveryGateConfigured,activeStableRecoveryTarget} from '../sheets/stable-recovery-admission';
import {stablePacingConfigured,stablePacingValid} from '../sheets/stable-sheet-pacing';

export type InboundClaim="CLAIMED"|"BUSY"|"TERMINAL";
export class InboundBusyError extends Error{constructor(){super("Inbound event is still processing");this.name="InboundBusyError";}}
export async function claimInboundEvent(env:Env,event:LineEvent,traceId:string,receivedAtIso:string):Promise<InboundClaim>{
  const webhookId=event.webhookEventId||`message:${event.message?.id||traceId}`,now=new Date().toISOString(),expired=new Date(Date.now()-15*60*1000).toISOString();
  const result=await env.DB.prepare(`INSERT INTO inbound_events(webhook_event_id,message_id,line_user_id,message_type,route,status,attempt_count,error,trace_id,received_at,last_attempt_at) VALUES(?,?,?,?,?,'PROCESSING',1,'',?,?,?) ON CONFLICT(webhook_event_id) DO UPDATE SET status='PROCESSING',attempt_count=inbound_events.attempt_count+1,error='',trace_id=excluded.trace_id,last_attempt_at=excluded.last_attempt_at,completed_at=NULL WHERE inbound_events.status IN ('FAILED','STALE') OR (inbound_events.status='PROCESSING' AND inbound_events.last_attempt_at<?)`)
    .bind(webhookId,event.message?.id||"",event.source.userId||"",event.message?.type||event.type,"UNROUTED",traceId,receivedAtIso,now,expired).run();
  if(Number(result.meta.changes||0)===1)return"CLAIMED";
  const row=await env.DB.prepare(`SELECT status FROM inbound_events WHERE webhook_event_id=?`).bind(webhookId).first<{status:string}>();return row?.status==="PROCESSING"?"BUSY":"TERMINAL";
}
export async function completeInboundEvent(env:Env,webhookEventId:string,route:string,status:string,error=""):Promise<void>{
  await env.DB.prepare(`UPDATE inbound_events SET route=?,status=?,error=?,completed_at=? WHERE webhook_event_id=?`).bind(route,status,error,new Date().toISOString(),webhookEventId).run();
}
export async function getEmployeeByLineId(env:Env,lineUserId:string):Promise<Employee|null>{
  const actor=await getStaffActorByLineId(env,lineUserId);
  return actor?.employee||null;
}
export async function incrementDailyUsage(env:Env,key:string):Promise<number>{
  const day=new Date().toISOString().slice(0,10);await env.DB.prepare(`INSERT INTO usage_daily(day,metric,value) VALUES(?,?,1) ON CONFLICT(day,metric) DO UPDATE SET value=value+1`).bind(day,key).run();
  const row=await env.DB.prepare(`SELECT value FROM usage_daily WHERE day=? AND metric=?`).bind(day,key).first<{value:number}>();return Number(row?.value||0);
}
export async function recordMetric(env:Env,traceId:string,name:string,valueMs:number,labels:Record<string,string>={}):Promise<void>{
  await env.DB.prepare(`INSERT INTO metrics(trace_id,name,value_ms,labels_json,created_at) VALUES(?,?,?,?,?)`).bind(traceId,name,Math.round(valueMs),JSON.stringify(labels),new Date().toISOString()).run();
}
export async function safeRecordMetric(env:Env,traceId:string,name:string,valueMs:number,labels:Record<string,string>={}):Promise<void>{
  try{await recordMetric(env,traceId||"untraced",name,valueMs,labels);}catch(error){console.error("metric",name,error);}
}
function failedJobKey(payload:unknown):string{
  const job=payload as{kind?:string;entityType?:string;entityKey?:string;entityVersion?:number;retryKey?:string;event?:{webhookEventId?:string;message?:{id?:string}}};
  if(job.kind==="SHEETS_SYNC")return`${job.entityType||"UNKNOWN"}:${job.entityKey||"UNKNOWN"}:${job.entityVersion||0}`;
  if(job.kind==="LINE_EVENT")return`LINE_EVENT:${job.event?.webhookEventId||job.event?.message?.id||"UNKNOWN"}`;
  if(job.kind==="LINE_NOTIFICATION")return`LINE_NOTIFICATION:${job.retryKey||"UNKNOWN"}`;
  return"UNKNOWN";
}
function isSheetSyncJob(payload:unknown):boolean{
  const job=payload as {kind?:string;entityType?:string}|null;
  return job?.kind==='SHEETS_SYNC';
}
export async function createFailedJob(env:Env,queue:string,traceId:string,payload:unknown,error:unknown):Promise<'RECORDED'|'ABSENT'>{
  const now=new Date().toISOString(),jobKey=failedJobKey(payload);
  // Once an OPEN sheet event is terminal, retain both its sentinel and
  // original payload until an explicit per-item reconciliation resolves it.
  const terminal="failed_jobs.status='OPEN' AND failed_jobs.error='DEAD_LETTER_MAX_RETRIES'";
  const preserved=isSheetSyncJob(payload)?`payload_json=CASE WHEN ${terminal} THEN failed_jobs.payload_json ELSE excluded.payload_json END,error=CASE WHEN ${terminal} THEN failed_jobs.error ELSE excluded.error END`:'payload_json=excluded.payload_json,error=excluded.error';
  const candidate=payload as {kind?:string;entityType?:string;entityKey?:unknown}|null;
  const guarded=env.EXPENSE_OUTBOX_SOURCE_GUARD_ENABLED==='true'&&candidate?.kind==='SHEETS_SYNC'&&candidate.entityType==='EXPENSE';
  const conflict=`ON CONFLICT(queue_name,trace_id,job_key) DO UPDATE SET ${preserved},status='OPEN',attempt_count=failed_jobs.attempt_count+1,updated_at=excluded.updated_at,resolved_at=NULL`;
  const args=[crypto.randomUUID(),queue,traceId,jobKey,JSON.stringify(payload),String(error),now,now];
  if(!guarded){await env.DB.prepare(`INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,?,'OPEN',1,?,?) ${conflict}`).bind(...args).run();return 'RECORDED';}
  if(typeof candidate.entityKey!=='string'||!candidate.entityKey)throw Error('EXPENSE_FAILED_JOB_ID_UNCERTAIN');
  const db=env.DB,key=candidate.entityKey,rows=await db.batch([
   db.prepare(`INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) SELECT ?,?,?,?,?,?,'OPEN',1,?,? WHERE EXISTS(SELECT 1 FROM expense_events WHERE expense_id=?) OR EXISTS(SELECT 1 FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=?) ${conflict}`).bind(...args,key,key),
   db.prepare("SELECT EXISTS(SELECT 1 FROM expense_events WHERE expense_id=?) OR EXISTS(SELECT 1 FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=?) AS present").bind(key,key)
  ]);
  if(env.DB!==db||rows.length!==2||rows.some(r=>r.success!==true)||!Number.isSafeInteger(rows[0]!.meta?.changes)||!Array.isArray(rows[1]!.results)||rows[1]!.results.length!==1)throw Error('EXPENSE_FAILED_JOB_UNCERTAIN');
  const changed=Number(rows[0]!.meta.changes),present=Number((rows[1]!.results[0] as {present?:unknown}).present);
  if(changed===1&&present===1)return 'RECORDED';
  if(changed===0&&present===0)return 'ABSENT';
  throw Error('EXPENSE_FAILED_JOB_UNCERTAIN');
}
export async function resolveFailedJobs(env:Env,queue:string,traceId:string,payload:unknown):Promise<void>{
  // A duplicate success/IGNORED cannot erase a terminal sheet incident.
  const terminalFence=isSheetSyncJob(payload)?" AND error<>'DEAD_LETTER_MAX_RETRIES'":'';
  await env.DB.prepare(`UPDATE failed_jobs SET status='RESOLVED',resolved_at=?,updated_at=? WHERE queue_name=? AND trace_id=? AND job_key=? AND status='OPEN'${terminalFence}`).bind(new Date().toISOString(),new Date().toISOString(),queue,traceId,failedJobKey(payload)).run();
}
export async function findOpenFailedJobPayload<T>(env:Env,queue:string,traceId:string,payload:unknown):Promise<T|null>{
  const row=await env.DB.prepare(`SELECT payload_json FROM failed_jobs WHERE queue_name=? AND trace_id=? AND job_key=? AND status='OPEN' LIMIT 1`).bind(queue,traceId,failedJobKey(payload)).first<{payload_json:string}>();
  if(!row?.payload_json)return null;
  try{return JSON.parse(row.payload_json) as T;}catch{return null;}
}
export async function enqueueSheetSync(env:Env,job:SheetsSyncJob):Promise<void>{
  await enqueueSheetSyncBatch(env,[job]);
}
interface ScheduledSheetJob{body:SheetsSyncJob;delaySeconds:number;nextAttemptAt:string}
interface RecoverableSheetJobRow{entity_type:unknown;entity_key:unknown;entity_version:unknown;trace_id:unknown;status:unknown;updated_at:unknown;next_attempt_at:unknown;lease_until:unknown;terminal_dlq_open?:unknown}
const SHEETS_SAFE_WRITES_PER_MINUTE=40;
export function sheetJobDelaySeconds(index:number,rateLimited:boolean):number{return rateLimited?Math.floor(index/SHEETS_SAFE_WRITES_PER_MINUTE)*60:0;}
function scheduleSheetJobs(jobs:SheetsSyncJob[],rateLimited:boolean,nowMs=Date.now(),controlledDrain=false):ScheduledSheetJob[]{
  return jobs.map((body,index)=>{const delaySeconds=controlledDrain?index*90:sheetJobDelaySeconds(index,rateLimited);return{body,delaySeconds,nextAttemptAt:new Date(nowMs+delaySeconds*1000).toISOString()};});
}
export function isRecoverableSheetJob(row:Pick<RecoverableSheetJobRow,"status"|"updated_at"|"next_attempt_at"|"lease_until">,nowIso:string,staleBeforeIso:string):boolean{
  const status=String(row.status||"");
  if(status==="PROCESSING")return Boolean(row.lease_until)&&String(row.lease_until)<=nowIso;
  if(status!=="PENDING"&&status!=="FAILED")return false;
  return String(row.updated_at||"")<staleBeforeIso&&(!row.next_attempt_at||String(row.next_attempt_at)<=nowIso);
}
async function sendScheduledSheetJobs(env:Env,jobs:ScheduledSheetJob[]):Promise<void>{
  for(let offset=0;offset<jobs.length;offset+=100){
    const messages=jobs.slice(offset,offset+100).map(({body,delaySeconds})=>delaySeconds?{body,delaySeconds}:{body});
    await env.JOB_QUEUE.sendBatch(messages);
  }
}
const LEGACY_FORCE_ENQUEUE_SQL=`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,?,?,?,?,'PENDING',0,?,?,NULL,NULL) ON CONFLICT(entity_type,entity_key,entity_version) DO UPDATE SET trace_id=excluded.trace_id,status='PENDING',last_error=NULL,updated_at=excluded.updated_at,next_attempt_at=excluded.next_attempt_at,lease_until=NULL,lease_token=NULL WHERE sync_jobs.status!='PROCESSING' OR (sync_jobs.lease_until IS NOT NULL AND sync_jobs.lease_until<=excluded.updated_at)`;
export async function enqueueSheetSyncBatch(env:Env,jobs:SheetsSyncJob[],force=false):Promise<number>{
  if(env.SHEETS_SYNC_ENABLED!=="true"||!jobs.length)return 0;
  const unique=[...new Map(jobs.map(job=>[`${job.entityType}|${job.entityKey}|${job.entityVersion}`,job])).values()],nowMs=Date.now(),now=new Date(nowMs).toISOString(),scheduled=scheduleSheetJobs(unique,force,nowMs,stablePacingConfigured(env));
  // Forced reconciliation is not proof of an expense provider outcome, even
  // when its version has no local job: an older version, legacy writer or
  // delayed provider request may have written. Hold all expense force jobs
  // for explicit reconciliation. Existing non-expense behavior is unchanged.
  if(force&&env.EXPENSE_FORCE_RECONCILE_HOLD_ENABLED!=='true'){
    // Flag off: the pre-candidate forced enqueue, unchanged.
    for(let offset=0;offset<scheduled.length;offset+=50){
      const statements=scheduled.slice(offset,offset+50).map(({body:job,nextAttemptAt})=>env.DB.prepare(LEGACY_FORCE_ENQUEUE_SQL)
        .bind(crypto.randomUUID(),job.entityType,job.entityKey,job.entityVersion,job.traceId,now,nextAttemptAt));
      await env.DB.batch(statements);
    }
    await sendScheduledSheetJobs(env,scheduled);
    return unique.length;
  }
  const accepted:ScheduledSheetJob[]=[];
  for(let offset=0;offset<scheduled.length;offset+=50){
    const chunk=scheduled.slice(offset,offset+50);
    const statementOffsets:number[]=[],guardedIndexes=new Set<number>();
    const statements=chunk.flatMap(({body:job,nextAttemptAt},index)=>{
      const guarded=!force&&env.EXPENSE_OUTBOX_SOURCE_GUARD_ENABLED==='true'&&job.entityType==='EXPENSE';
      const normalValues=guarded?`SELECT ?,?,?,?,?,'PENDING',0,?,?,NULL,NULL WHERE EXISTS(SELECT 1 FROM expense_events WHERE expense_id=?)`:`VALUES(?,?,?,?,?,'PENDING',0,?,?,NULL,NULL)`;
      statementOffsets.push(index+guardedIndexes.size);if(guarded)guardedIndexes.add(index);
      const insert=env.DB.prepare(force
      ?`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) SELECT ?,?,?,?,?,'PENDING',0,?,?,NULL,NULL WHERE ?<>'EXPENSE' AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=? AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') ON CONFLICT(entity_type,entity_key,entity_version) DO UPDATE SET trace_id=excluded.trace_id,status='PENDING',last_error=NULL,updated_at=excluded.updated_at,next_attempt_at=excluded.next_attempt_at,lease_until=NULL,lease_token=NULL WHERE sync_jobs.entity_type<>'EXPENSE' AND sync_jobs.status NOT IN ('REVIEW','PROCESSING','FAILED') AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=sync_jobs.entity_type||':'||sync_jobs.entity_key||':'||sync_jobs.entity_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')`
      :`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) ${normalValues} ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING`)
      .bind(crypto.randomUUID(),job.entityType,job.entityKey,job.entityVersion,job.traceId,now,nextAttemptAt,...(force?[job.entityType,`${job.entityType}:${job.entityKey}:${job.entityVersion}`]:guarded?[job.entityKey]:[]));
      return guarded?[insert,env.DB.prepare('SELECT EXISTS(SELECT 1 FROM expense_events WHERE expense_id=?) AS present').bind(job.entityKey)]:[insert];
    });
    const db=env.DB,results=await db.batch(statements);
    if(force){
      if(results.length!==chunk.length||results.some(r=>r.success===false||!Number.isSafeInteger(r.meta?.changes)||Number(r.meta.changes)<0||Number(r.meta.changes)>1))throw Error('SHEETS_FORCE_ENQUEUE_UNCERTAIN');
      for(let i=0;i<chunk.length;i++)if(Number(results[i]!.meta.changes)===1)accepted.push(chunk[i]!);
    }else if(guardedIndexes.size){
      if(env.DB!==db||results.length!==statements.length||results.some(r=>r.success!==true))throw Error('EXPENSE_PRODUCER_GUARD_UNCERTAIN');
      for(let i=0;i<chunk.length;i++){
        if(!guardedIndexes.has(i)){accepted.push(chunk[i]!);continue;}
        const insertion=results[statementOffsets[i]!]!,check=results[statementOffsets[i]!+1]!;
        if(insertion?.success!==true||!Number.isSafeInteger(insertion.meta?.changes)||Number(insertion.meta.changes)<0||Number(insertion.meta.changes)>1||check?.success!==true||!Array.isArray(check.results)||check.results.length!==1)throw Error('EXPENSE_PRODUCER_GUARD_UNCERTAIN');
        const present=Number((check.results[0] as {present?:unknown}).present);if(present===1)accepted.push(chunk[i]!);else if(present!==0||insertion.meta.changes!==0)throw Error('EXPENSE_PRODUCER_GUARD_UNCERTAIN');
      }
    }else accepted.push(...chunk);
  }
  await sendScheduledSheetJobs(env,accepted);
  return accepted.length;
}
/** While the recovery gate is armed, cron may send ONLY its exact target.
 * Never redrive terminal DLQ, other expenses, or unrelated HR. The lease
 * transition is guarded by the same ARMED epoch and original job identity.
 * This is an enqueue, not a provider write or an authorization to replay. */
export async function recoverArmedSheetJob(env:Env,staleAfterSeconds=300,nowMs=Date.now()):Promise<number>{
  const target=await activeStableRecoveryTarget(env);
  if(!target||target.entityType==='STAFF_CONFIG_SYNC')return 0;
  const seconds=Math.min(3600,Math.max(0,Math.floor(staleAfterSeconds)));
  const now=new Date(nowMs).toISOString(),stale=new Date(nowMs-seconds*1000).toISOString();
  // R4: with STABLE_REDRIVE_HOLD_ENABLED off the armed target is re-sent from
  // FAILED or an expired lease exactly as on main; on, only PENDING is re-sent,
  // matching scheduled recovery outside the gate.
  const hold=env.STABLE_PHASE1_ENABLED==='true'&&env.STABLE_REDRIVE_HOLD_ENABLED==='true';
  const row=await env.DB.prepare(`SELECT entity_type,entity_key,entity_version,trace_id,status,updated_at,next_attempt_at,lease_until
    FROM sync_jobs s WHERE entity_type=? AND entity_key=? AND entity_version=?
    AND ${hold?"status='PENDING'":"status IN ('PENDING','FAILED','PROCESSING')"}
    AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs'
      AND f.job_key=s.entity_type||':'||s.entity_key||':'||s.entity_version
      AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') LIMIT 1`)
    .bind(target.entityType,target.entityKey,target.entityVersion).first<RecoverableSheetJobRow>();
  if(!row||!isRecoverableSheetJob(row,now,stale))return 0;
  const job:SheetsSyncJob={kind:'SHEETS_SYNC',entityType:target.entityType as SheetsSyncJob['entityType'],
    entityKey:target.entityKey,entityVersion:target.entityVersion,traceId:String(row.trace_id)};
  const result=await env.DB.prepare(`UPDATE sync_jobs SET status='PENDING',updated_at=?,
    next_attempt_at=NULL,lease_until=NULL,lease_token=NULL
    WHERE entity_type=? AND entity_key=? AND entity_version=?
    AND EXISTS(SELECT 1 FROM stable_recovery_epochs e WHERE e.epoch_id=? AND e.spreadsheet_id=?
      AND e.state='ARMED' AND e.target_type=sync_jobs.entity_type
      AND e.target_key=sync_jobs.entity_key AND e.target_version=sync_jobs.entity_version)
    AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs'
      AND f.job_key=sync_jobs.entity_type||':'||sync_jobs.entity_key||':'||sync_jobs.entity_version
      AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')
    AND ${hold?"status='PENDING' AND updated_at<? AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND ? IS NOT NULL":`(((status IN ('PENDING','FAILED')) AND updated_at<? AND
          (next_attempt_at IS NULL OR next_attempt_at<=?))
         OR(status='PROCESSING' AND lease_until IS NOT NULL AND lease_until<=?))`}`)
   .bind(now,target.entityType,target.entityKey,target.entityVersion,target.epochId,env.GOOGLE_SPREADSHEET_ID,stale,now,now).run();
  if(result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('STABLE_RECOVERY_ENQUEUE_CAS_UNKNOWN');
  if(Number(result.meta.changes)!==1)return 0;
  await env.JOB_QUEUE.send(job);
  return 1;
}
export async function recoverPendingSheetJobs(env:Env,staleAfterSeconds=300,includeTerminalDlq=false):Promise<number>{
  if(env.SHEETS_SYNC_ENABLED!=="true")return 0;
  // Every writer is blocked by a retained review claim. Jobs stay durable and
  // are re-sent by the first recovery after an operator resolves the review.
  if(await stableWorkbookInReview(env)||stablePacingConfigured(env)&&!stablePacingValid(env))return 0;
  if(recoveryGateConfigured(env))return recoverArmedSheetJob(env,staleAfterSeconds);
  const stable=env.STABLE_PHASE1_ENABLED==='true'&&env.STABLE_REDRIVE_HOLD_ENABLED==='true';
  const seconds=Math.min(3600,Math.max(0,Math.floor(staleAfterSeconds))),nowMs=Date.now(),now=new Date(nowMs).toISOString(),stale=new Date(nowMs-seconds*1000).toISOString(),terminalDlqAllowed=includeTerminalDlq&&!stable?1:0;
  const rows=await env.DB.prepare(`SELECT s.entity_type,s.entity_key,s.entity_version,s.trace_id,s.status,s.updated_at,s.next_attempt_at,s.lease_until,EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=s.entity_type || ':' || s.entity_key || ':' || s.entity_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') AS terminal_dlq_open FROM sync_jobs s WHERE s.status IN ('PENDING','FAILED','PROCESSING') AND (?=1 OR NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=s.entity_type || ':' || s.entity_key || ':' || s.entity_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')) ORDER BY s.updated_at LIMIT 200`).bind(terminalDlqAllowed).all<RecoverableSheetJobRow>();
  const recoverable=(rows.results||[]).filter(row=>(terminalDlqAllowed===1||Number(row.terminal_dlq_open||0)!==1)&&isRecoverableSheetJob(row,now,stale));
  if(stable){
    for(const row of recoverable.filter(r=>r.status==='FAILED'||r.status==='PROCESSING')){
      // No projection writer for these historical states records enough
      // evidence to establish a no-write result. Keep the old error and stop
      // automatic retries, even if the provider failure was actually benign.
      await env.DB.prepare(`UPDATE sync_jobs SET status='REVIEW',last_error=COALESCE(last_error,'STABLE_REDRIVE_UNCERTAIN'),updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL WHERE entity_type=? AND entity_key=? AND entity_version=? AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=sync_jobs.entity_type||':'||sync_jobs.entity_key||':'||sync_jobs.entity_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') AND ((status='FAILED' AND updated_at<? AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='PROCESSING' AND lease_until IS NOT NULL AND lease_until<=?))`).bind(now,row.entity_type,row.entity_key,row.entity_version,stale,now,now).run();
    }
  }
  const jobs:SheetsSyncJob[]=recoverable.filter(row=>!stable||row.status==='PENDING').slice(0,stablePacingConfigured(env)?4:50).map(r=>({kind:"SHEETS_SYNC",entityType:String(r.entity_type) as SheetsSyncJob["entityType"],entityKey:String(r.entity_key),entityVersion:Number(r.entity_version),traceId:String(r.trace_id)}));
  const scheduled=scheduleSheetJobs(jobs,true,nowMs,stablePacingConfigured(env)),claimed:ScheduledSheetJob[]=[];
  for(const item of scheduled){
    const recoverableCas=stable?"(status='PENDING' AND updated_at<? AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND ? IS NOT NULL)":"(((status='PENDING' OR status='FAILED') AND updated_at<? AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='PROCESSING' AND lease_until IS NOT NULL AND lease_until<=?))";
    const job=item.body,result=await env.DB.prepare(`UPDATE sync_jobs SET status='PENDING',trace_id=?,last_error=NULL,updated_at=?,next_attempt_at=?,lease_until=NULL,lease_token=NULL WHERE entity_type=? AND entity_key=? AND entity_version=? AND (?=1 OR NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':' || sync_jobs.entity_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')) AND ${recoverableCas}`).bind(job.traceId,now,item.nextAttemptAt,job.entityType,job.entityKey,job.entityVersion,terminalDlqAllowed,stale,now,now).run();
    if(Number(result.meta.changes||0)===1)claimed.push(item);
  }
  if(claimed.length)await sendScheduledSheetJobs(env,claimed);
  return claimed.length;
}
