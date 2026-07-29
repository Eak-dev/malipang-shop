import { createFailedJob,findOpenFailedJobPayload,resolveFailedJobs,safeRecordMetric } from "../db/repositories";
import { sha256Hex } from "../shared/ids";
import { queueRetryDelaySeconds } from "../shared/retry";
import type { Env,LineNotificationJob,LineNotificationPurpose,QueueJob } from "../types";
import { isPermanentLineNotificationError,isPushQuotaExhaustedError,lineOutputEnabled,pushRetryableLineMessages } from "./api";

async function deterministicRetryKey(identity:string):Promise<string>{
  const bytes=new TextEncoder().encode(identity);
  const hex=await sha256Hex(bytes.buffer);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export async function buildLineNotificationJob(input:{
  to:string;
  messages:unknown[];
  identity:string;
  purpose:LineNotificationPurpose;
  traceId:string;
}):Promise<LineNotificationJob>{
  return{
    kind:"LINE_NOTIFICATION",
    to:input.to,
    messages:input.messages,
    purpose:input.purpose,
    retryKey:await deterministicRetryKey(input.identity),
    traceId:input.traceId
  };
}

export async function buildAttendanceNotificationJob(input:{
  to:string;
  text:string;
  identity:string;
  purpose:LineNotificationPurpose;
  traceId:string;
}):Promise<LineNotificationJob>{
  return buildLineNotificationJob({...input,messages:[{type:"text",text:input.text}]});
}

export async function enqueueLineNotification(env:Env,input:{
  to:string;
  messages:unknown[];
  identity:string;
  purpose:LineNotificationPurpose;
  traceId:string;
}):Promise<LineNotificationJob|null>{
  if(!lineOutputEnabled(env))return null;
  const candidate=await buildLineNotificationJob(input);
  const persisted=await findOpenFailedJobPayload<LineNotificationJob>(env,"malipang-jobs",input.traceId,candidate);
  const job=persisted?.kind==="LINE_NOTIFICATION"&&persisted.retryKey===candidate.retryKey?persisted:candidate;
  if(!persisted)await createFailedJob(env,"malipang-jobs",input.traceId,job,"PENDING_LINE_NOTIFICATION_DELIVERY");
  try{
    await env.JOB_QUEUE.send(job);
  }catch(error){
    await createFailedJob(env,"malipang-jobs",input.traceId,job,"LINE_NOTIFICATION_ENQUEUE_FAILED");
    throw error;
  }
  await safeRecordMetric(env,input.traceId,"line_notification_enqueued",0,{purpose:input.purpose});
  return job;
}

interface RecoverableLineNotificationRow{
  id:string;
  trace_id:string;
  payload_json:string;
  updated_at:string;
}
export async function recoverPendingLineNotifications(env:Env,staleAfterSeconds=60,limit=20):Promise<number>{
  if(!lineOutputEnabled(env))return 0;
  const nowMs=Date.now(),now=new Date(nowMs).toISOString(),stale=new Date(nowMs-Math.max(30,Math.floor(staleAfterSeconds))*1000).toISOString(),safeLimit=Math.min(50,Math.max(1,Math.floor(limit)));
  const rows=await env.DB.prepare(`SELECT id,trace_id,payload_json,updated_at FROM failed_jobs
    WHERE queue_name='malipang-jobs' AND status='OPEN' AND job_key LIKE 'LINE_NOTIFICATION:%'
      AND error IN ('PENDING_LINE_NOTIFICATION_DELIVERY','LINE_NOTIFICATION_ENQUEUE_FAILED','LINE_NOTIFICATION_RECOVERY_ENQUEUED')
      AND updated_at<?
    ORDER BY updated_at LIMIT ?`).bind(stale,safeLimit).all<RecoverableLineNotificationRow>();
  let enqueued=0;
  for(const row of rows.results||[]){
    let job:LineNotificationJob;
    try{job=JSON.parse(String(row.payload_json)) as LineNotificationJob;}catch{continue;}
    if(job.kind!=="LINE_NOTIFICATION"||!job.retryKey||!Array.isArray(job.messages))continue;
    const claimed=await env.DB.prepare(`UPDATE failed_jobs SET error='LINE_NOTIFICATION_RECOVERY_ENQUEUED',updated_at=?
      WHERE id=? AND status='OPEN' AND updated_at=?
        AND error IN ('PENDING_LINE_NOTIFICATION_DELIVERY','LINE_NOTIFICATION_ENQUEUE_FAILED','LINE_NOTIFICATION_RECOVERY_ENQUEUED')`).bind(now,row.id,row.updated_at).run();
    if(Number(claimed.meta.changes||0)!==1)continue;
    try{
      await env.JOB_QUEUE.send(job);
      enqueued++;
    }catch(error){
      await createFailedJob(env,"malipang-jobs",String(row.trace_id),job,"LINE_NOTIFICATION_ENQUEUE_FAILED");
    }
  }
  if(enqueued)await safeRecordMetric(env,"scheduled","line_notification_recovered",0,{count:String(enqueued)});
  return enqueued;
}

export async function enqueueAttendanceNotification(env:Env,input:{
  to:string;
  text:string;
  identity:string;
  purpose:"ATTENDANCE_RESULT"|"ATTENDANCE_REJECTION"|"ATTENDANCE_SMOKE";
  traceId:string;
}):Promise<LineNotificationJob|null>{
  return enqueueLineNotification(env,{...input,messages:[{type:"text",text:input.text}]});
}

export async function deliverLineNotification(env:Env,job:LineNotificationJob):Promise<void>{
  await pushRetryableLineMessages(env,job.to,job.messages,job.retryKey,job.traceId);
  await safeRecordMetric(env,job.traceId,"line_notification_delivered",0,{purpose:job.purpose});
}

export async function processLineNotificationMessage(
  env:Env,
  queueName:string,
  message:Message<QueueJob>,
  attempt:number
):Promise<void>{
  const job=message.body;
  if(job.kind!=="LINE_NOTIFICATION")throw new Error("LINE_NOTIFICATION job required");
  try{
    await deliverLineNotification(env,job);
    await resolveFailedJobs(env,queueName,job.traceId,job);
    message.ack();
  }catch(error){
    await createFailedJob(env,queueName,job.traceId,job,isPushQuotaExhaustedError(error)?"LINE_PUSH_QUOTA_EXHAUSTED":error);
    if(isPushQuotaExhaustedError(error)){
      await safeRecordMetric(env,job.traceId,"line_push_quota_exhausted",0,{purpose:job.purpose});
      message.ack();
      return;
    }
    if(isPermanentLineNotificationError(error)){
      await safeRecordMetric(env,job.traceId,"line_notification_permanent_failure",0,{purpose:job.purpose});
      message.ack();
      return;
    }
    const delaySeconds=queueRetryDelaySeconds(error,attempt);
    message.retry(delaySeconds?{delaySeconds}:undefined);
  }
}
