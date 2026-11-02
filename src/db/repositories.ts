import { getStaffActorByLineId } from "../access/repository";
import type { Employee, Env, LineEvent, SheetsSyncJob } from "../types";

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
export async function createFailedJob(env:Env,queue:string,traceId:string,payload:unknown,error:unknown):Promise<void>{
  const now=new Date().toISOString(),jobKey=failedJobKey(payload),isSheets=(payload as {kind?:unknown})?.kind==='SHEETS_SYNC'?1:0;
  const write=env.DB.prepare(`INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,?,'OPEN',1,?,?) ON CONFLICT(queue_name,trace_id,job_key) DO UPDATE SET payload_json=CASE WHEN ?=1 AND failed_jobs.status='OPEN' AND failed_jobs.error='DEAD_LETTER_MAX_RETRIES' THEN failed_jobs.payload_json ELSE excluded.payload_json END,error=CASE WHEN ?=1 AND failed_jobs.status='OPEN' AND failed_jobs.error='DEAD_LETTER_MAX_RETRIES' THEN failed_jobs.error ELSE excluded.error END,status='OPEN',attempt_count=failed_jobs.attempt_count+1,updated_at=excluded.updated_at,resolved_at=NULL`).bind(crypto.randomUUID(),queue,traceId,jobKey,JSON.stringify(payload),String(error),now,now,isSheets,isSheets);
  if(isSheets)await env.DB.batch([write,quarantineTerminalSheetJobs(env,payload as SheetsSyncJob,now)]);else await write.run();
}
export async function resolveFailedJobs(env:Env,queue:string,traceId:string,payload:unknown):Promise<void>{
  const isSheets=(payload as {kind?:unknown})?.kind==='SHEETS_SYNC'?1:0;
  await env.DB.prepare(`UPDATE failed_jobs SET status='RESOLVED',resolved_at=?,updated_at=? WHERE queue_name=? AND trace_id=? AND job_key=? AND status='OPEN' AND (?=0 OR error<>'DEAD_LETTER_MAX_RETRIES')`).bind(new Date().toISOString(),new Date().toISOString(),queue,traceId,failedJobKey(payload),isSheets).run();
}
export async function findOpenFailedJobPayload<T>(env:Env,queue:string,traceId:string,payload:unknown):Promise<T|null>{
  const row=await env.DB.prepare(`SELECT payload_json FROM failed_jobs WHERE queue_name=? AND trace_id=? AND job_key=? AND status='OPEN' LIMIT 1`).bind(queue,traceId,failedJobKey(payload)).first<{payload_json:string}>();
  if(!row?.payload_json)return null;
  try{return JSON.parse(row.payload_json) as T;}catch{return null;}
}
export async function enqueueSheetSync(env:Env,job:SheetsSyncJob):Promise<void>{
  await enqueueSheetSyncBatch(env,[job]);
}
export const SHEET_SYNC_TERMINAL_REVIEW_REASON="SHEET_SYNC_TERMINAL_DLQ_REVIEW_REQUIRED";
/** Preserve the quarantine even if the terminal failure is later resolved.
 * Run in the same D1 transaction as insertion or a claim attempt. */
export function quarantineTerminalSheetJobs(env:Env,job:SheetsSyncJob,now:string):D1PreparedStatement{
  return env.DB.prepare(`UPDATE sync_jobs SET status='REVIEW',last_error=?,updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL WHERE entity_type=? AND entity_key=? AND (status IN ('PENDING','FAILED','PROCESSING') OR (status='COMPLETED' AND entity_version=?)) AND EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES' AND substr(f.job_key,1,length(sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':'))=sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':')`).bind(SHEET_SYNC_TERMINAL_REVIEW_REASON,now,job.entityType,job.entityKey,job.entityVersion);
}
interface ScheduledSheetJob{body:SheetsSyncJob;delaySeconds:number;nextAttemptAt:string}
interface RecoverableSheetJobRow{entity_type:unknown;entity_key:unknown;entity_version:unknown;trace_id:unknown;status:unknown;updated_at:unknown;next_attempt_at:unknown;lease_until:unknown;terminal_dlq_open?:unknown}
const SHEETS_SAFE_WRITES_PER_MINUTE=40;
export function sheetJobDelaySeconds(index:number,rateLimited:boolean):number{return rateLimited?Math.floor(index/SHEETS_SAFE_WRITES_PER_MINUTE)*60:0;}
function scheduleSheetJobs(jobs:SheetsSyncJob[],rateLimited:boolean,nowMs=Date.now()):ScheduledSheetJob[]{
  return jobs.map((body,index)=>{const delaySeconds=sheetJobDelaySeconds(index,rateLimited);return{body,delaySeconds,nextAttemptAt:new Date(nowMs+delaySeconds*1000).toISOString()};});
}
export function isRecoverableSheetJob(row:Pick<RecoverableSheetJobRow,"status"|"updated_at"|"next_attempt_at"|"lease_until">,nowIso:string,staleBeforeIso:string):boolean{
  const status=String(row.status||"");
  // Expired PROCESSING jobs are quarantined, not re-enqueued.
  if(status==="PROCESSING")return false;
  if(status!=="PENDING"&&status!=="FAILED")return false;
  return String(row.updated_at||"")<staleBeforeIso&&(!row.next_attempt_at||String(row.next_attempt_at)<=nowIso);
}
async function sendScheduledSheetJobs(env:Env,jobs:ScheduledSheetJob[]):Promise<void>{
  for(let offset=0;offset<jobs.length;offset+=100){
    const messages=jobs.slice(offset,offset+100).map(({body,delaySeconds})=>delaySeconds?{body,delaySeconds}:{body});
    await env.JOB_QUEUE.sendBatch(messages);
  }
}
export async function enqueueSheetSyncBatch(env:Env,jobs:SheetsSyncJob[],force=false):Promise<number>{return (await enqueueSheetSyncBatchDetailed(env,jobs,force)).enqueued;}
export async function enqueueSheetSyncBatchDetailed(env:Env,jobs:SheetsSyncJob[],force=false):Promise<{enqueued:number;held:number;disabled:number}>{
  const unique=[...new Map(jobs.map(job=>[`${job.entityType}|${job.entityKey}|${job.entityVersion}`,job])).values()];
  if(!unique.length)return{enqueued:0,held:0,disabled:0};
  const nowMs=Date.now(),now=new Date(nowMs).toISOString(),scheduled=scheduleSheetJobs(unique,force,nowMs),eligible:ScheduledSheetJob[]=[];let held=0;
  for(let offset=0;offset<scheduled.length;offset+=50){
    const batch=scheduled.slice(offset,offset+50),statements=batch.flatMap(({body:job,nextAttemptAt})=>{
      const upsert=env.DB.prepare(force
        ?`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,?,?,?,?,'PENDING',0,?,?,NULL,NULL) ON CONFLICT(entity_type,entity_key,entity_version) DO UPDATE SET trace_id=excluded.trace_id,status='PENDING',last_error=NULL,updated_at=excluded.updated_at,next_attempt_at=excluded.next_attempt_at,lease_until=NULL,lease_token=NULL WHERE sync_jobs.status NOT IN ('PROCESSING','REVIEW') AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES' AND substr(f.job_key,1,length(sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':'))=sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':')`
        :`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,?,?,?,?,'PENDING',0,?,?,NULL,NULL) ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING`)
        .bind(crypto.randomUUID(),job.entityType,job.entityKey,job.entityVersion,job.traceId,now,nextAttemptAt);
      const quarantine=quarantineTerminalSheetJobs(env,job,now);
      if(!force)return[upsert,quarantine];
      const check=env.DB.prepare(`SELECT (EXISTS(SELECT 1 FROM sync_jobs active WHERE active.entity_type=s.entity_type AND active.entity_key=s.entity_key AND active.status IN ('PROCESSING','REVIEW')) OR EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES' AND substr(f.job_key,1,length(s.entity_type || ':' || s.entity_key || ':'))=s.entity_type || ':' || s.entity_key || ':')) AS held FROM sync_jobs s WHERE s.entity_type=? AND s.entity_key=? AND s.entity_version=?`).bind(job.entityType,job.entityKey,job.entityVersion);
      return[upsert,quarantine,check];
    });
    const results=await env.DB.batch<{held:number}>(statements);
    for(let index=0;index<batch.length;index++){
      const item=batch[index]!;
      if(!force){eligible.push(item);continue;}
      const row=results[index*3+2]?.results?.[0];if(!row||![0,1].includes(Number(row.held)))throw new Error("SHEET_SYNC_ENQUEUE_HOLD_RESULT_MISSING");
      if(Number(row.held)===1)held++;else eligible.push(item);
    }
  }
  if(env.SHEETS_SYNC_ENABLED!=="true")return{enqueued:0,held,disabled:eligible.length};
  if(eligible.length)await sendScheduledSheetJobs(env,eligible);
  return{enqueued:eligible.length,held,disabled:0};
}
export async function recoverPendingSheetJobs(env:Env,staleAfterSeconds=300,_includeTerminalDlq=false):Promise<number>{
  if(env.SHEETS_SYNC_ENABLED!=="true")return 0;
  // A terminal DLQ record may describe a stale write after manual correction.
  // Even callers using the legacy override must wait for an independently
  // verified review/reconciliation workflow; that workflow is not implemented.
  const seconds=Math.min(3600,Math.max(0,Math.floor(staleAfterSeconds))),nowMs=Date.now(),now=new Date(nowMs).toISOString(),stale=new Date(nowMs-seconds*1000).toISOString(),terminalDlqAllowed=0;
  // Backfill holds for terminal failures created before this code was deployed.
  // A verified terminal resolver must also quarantine in its own transaction.
  await env.DB.prepare(`UPDATE sync_jobs SET status='REVIEW',last_error=?,updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL WHERE (status IN ('PENDING','FAILED','PROCESSING') OR (status='COMPLETED' AND EXISTS(SELECT 1 FROM failed_jobs z WHERE z.queue_name='malipang-jobs' AND z.status='OPEN' AND z.error='DEAD_LETTER_MAX_RETRIES' AND z.job_key=sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':' || sync_jobs.entity_version))) AND EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES' AND substr(f.job_key,1,length(sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':'))=sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':')`).bind(SHEET_SYNC_TERMINAL_REVIEW_REASON,now).run();
  // A crashed or paused sender may still reach Sheets. Quarantine expired
  // projections, and keep the alert recoverable if logging fails.
  await env.DB.prepare(`UPDATE sync_jobs SET status='REVIEW',updated_at=?,next_attempt_at=NULL,last_error='SHEET_SYNC_EXPIRED_OWNER_REVIEW' WHERE status='PROCESSING' AND (lease_until IS NULL OR lease_until<=?)`).bind(now,now).run();
  const held=await env.DB.prepare(`SELECT entity_type,entity_key,entity_version,trace_id FROM sync_jobs s WHERE s.status='REVIEW' AND s.last_error='SHEET_SYNC_EXPIRED_OWNER_REVIEW' AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.trace_id=s.trace_id AND f.job_key=s.entity_type || ':' || s.entity_key || ':' || s.entity_version AND f.status='OPEN') LIMIT 200`).all<RecoverableSheetJobRow>();
  for(const row of held.results||[]){const job:SheetsSyncJob={kind:'SHEETS_SYNC',entityType:String(row.entity_type) as SheetsSyncJob['entityType'],entityKey:String(row.entity_key),entityVersion:Number(row.entity_version),traceId:String(row.trace_id)};await createFailedJob(env,'malipang-jobs',job.traceId,job,'SHEETS_SYNC_REVIEW_REQUIRED');}
  const rows=await env.DB.prepare(`SELECT s.entity_type,s.entity_key,s.entity_version,s.trace_id,s.status,s.updated_at,s.next_attempt_at,s.lease_until,EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND substr(f.job_key,1,length(s.entity_type || ':' || s.entity_key || ':'))=s.entity_type || ':' || s.entity_key || ':' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') AS terminal_dlq_open FROM sync_jobs s WHERE s.status IN ('PENDING','FAILED') AND s.updated_at<? AND (s.next_attempt_at IS NULL OR s.next_attempt_at<=?) AND (?=1 OR NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND substr(f.job_key,1,length(s.entity_type || ':' || s.entity_key || ':'))=s.entity_type || ':' || s.entity_key || ':' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')) ORDER BY s.updated_at LIMIT 200`).bind(stale,now,terminalDlqAllowed).all<RecoverableSheetJobRow>();
  const jobs:SheetsSyncJob[]=(rows.results||[]).filter(row=>Number(row.terminal_dlq_open||0)!==1&&isRecoverableSheetJob(row,now,stale)).slice(0,50).map(r=>({kind:"SHEETS_SYNC",entityType:String(r.entity_type) as SheetsSyncJob["entityType"],entityKey:String(r.entity_key),entityVersion:Number(r.entity_version),traceId:String(r.trace_id)}));
  const scheduled=scheduleSheetJobs(jobs,true,nowMs),claimed:ScheduledSheetJob[]=[];
  for(const item of scheduled){
    const job=item.body,result=await env.DB.prepare(`UPDATE sync_jobs SET status='PENDING',trace_id=?,last_error=NULL,updated_at=?,next_attempt_at=?,lease_until=NULL,lease_token=NULL WHERE entity_type=? AND entity_key=? AND entity_version=? AND (?=1 OR NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND substr(f.job_key,1,length(sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':'))=sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')) AND (status='PENDING' OR status='FAILED') AND updated_at<? AND (next_attempt_at IS NULL OR next_attempt_at<=?)`).bind(job.traceId,now,item.nextAttemptAt,job.entityType,job.entityKey,job.entityVersion,terminalDlqAllowed,stale,now).run();
    if(Number(result.meta.changes||0)===1)claimed.push(item);
  }
  if(claimed.length)await sendScheduledSheetJobs(env,claimed);
  return claimed.length;
}
