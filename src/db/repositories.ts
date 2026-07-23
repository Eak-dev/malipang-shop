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
  const row=await env.DB.prepare(`SELECT employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,daily_wage_satang,grace_min,late_deduction_satang,early_deduction_satang,can_submit_expense,status FROM employees WHERE line_user_id=? LIMIT 1`).bind(lineUserId).first<Record<string,unknown>>();
  if(!row)return null;
  return{employeeId:String(row.employee_id),staffName:String(row.staff_name),lineUserId:String(row.line_user_id),scheduledIn:String(row.scheduled_in),scheduledOut:String(row.scheduled_out),dailyWageSatang:Number(row.daily_wage_satang),graceMin:Number(row.grace_min),lateDeductionSatang:Number(row.late_deduction_satang),earlyDeductionSatang:Number(row.early_deduction_satang),canSubmitExpense:Number(row.can_submit_expense)===1,status:String(row.status)==="ACTIVE"?"ACTIVE":"INACTIVE"};
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
  const job=payload as{kind?:string;entityType?:string;entityKey?:string;entityVersion?:number;event?:{webhookEventId?:string;message?:{id?:string}}};
  if(job.kind==="SHEETS_SYNC")return`${job.entityType||"UNKNOWN"}:${job.entityKey||"UNKNOWN"}:${job.entityVersion||0}`;
  if(job.kind==="LINE_EVENT")return`LINE_EVENT:${job.event?.webhookEventId||job.event?.message?.id||"UNKNOWN"}`;
  return"UNKNOWN";
}
export async function createFailedJob(env:Env,queue:string,traceId:string,payload:unknown,error:unknown):Promise<void>{
  const now=new Date().toISOString(),jobKey=failedJobKey(payload);await env.DB.prepare(`INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES(?,?,?,?,?,?,'OPEN',1,?,?) ON CONFLICT(queue_name,trace_id,job_key) DO UPDATE SET payload_json=excluded.payload_json,error=excluded.error,status='OPEN',attempt_count=failed_jobs.attempt_count+1,updated_at=excluded.updated_at,resolved_at=NULL`).bind(crypto.randomUUID(),queue,traceId,jobKey,JSON.stringify(payload),String(error),now,now).run();
}
export async function resolveFailedJobs(env:Env,queue:string,traceId:string,payload:unknown):Promise<void>{
  await env.DB.prepare(`UPDATE failed_jobs SET status='RESOLVED',resolved_at=?,updated_at=? WHERE queue_name=? AND trace_id=? AND job_key=? AND status='OPEN'`).bind(new Date().toISOString(),new Date().toISOString(),queue,traceId,failedJobKey(payload)).run();
}
export async function enqueueSheetSync(env:Env,job:SheetsSyncJob):Promise<void>{
  await enqueueSheetSyncBatch(env,[job]);
}
async function sendSheetJobs(env:Env,jobs:SheetsSyncJob[],rateLimited=false):Promise<void>{
  for(let offset=0;offset<jobs.length;offset+=100){
    const messages=jobs.slice(offset,offset+100).map((body,index)=>{
      const delaySeconds=rateLimited?Math.floor((offset+index)/5)*60:0;
      return delaySeconds?{body,delaySeconds}:{body};
    });
    await env.JOB_QUEUE.sendBatch(messages);
  }
}
export async function enqueueSheetSyncBatch(env:Env,jobs:SheetsSyncJob[],force=false):Promise<number>{
  if(env.SHEETS_SYNC_ENABLED!=="true"||!jobs.length)return 0;
  const unique=[...new Map(jobs.map(job=>[`${job.entityType}|${job.entityKey}|${job.entityVersion}`,job])).values()],now=new Date().toISOString();
  for(let offset=0;offset<unique.length;offset+=50){
    const statements=unique.slice(offset,offset+50).map(job=>env.DB.prepare(force
      ?`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES(?,?,?,?,?,'PENDING',0,?) ON CONFLICT(entity_type,entity_key,entity_version) DO UPDATE SET trace_id=excluded.trace_id,status='PENDING',last_error=NULL,updated_at=excluded.updated_at`
      :`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES(?,?,?,?,?,'PENDING',0,?) ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING`)
      .bind(crypto.randomUUID(),job.entityType,job.entityKey,job.entityVersion,job.traceId,now));
    await env.DB.batch(statements);
  }
  await sendSheetJobs(env,unique,force);
  return unique.length;
}
export async function recoverPendingSheetJobs(env:Env,staleAfterSeconds=300):Promise<number>{
  if(env.SHEETS_SYNC_ENABLED!=="true")return 0;
  const seconds=Math.min(3600,Math.max(0,Math.floor(staleAfterSeconds))),stale=new Date(Date.now()-seconds*1000).toISOString();
  const rows=await env.DB.prepare(`SELECT entity_type,entity_key,entity_version,trace_id FROM sync_jobs WHERE status IN ('PENDING','FAILED','PROCESSING') AND updated_at<? ORDER BY updated_at LIMIT 50`).bind(stale).all<Record<string,unknown>>();
  const jobs:SheetsSyncJob[]=(rows.results||[]).map(r=>({kind:"SHEETS_SYNC",entityType:String(r.entity_type) as SheetsSyncJob["entityType"],entityKey:String(r.entity_key),entityVersion:Number(r.entity_version),traceId:String(r.trace_id)}));
  if(jobs.length)await sendSheetJobs(env,jobs,true);
  return jobs.length;
}
