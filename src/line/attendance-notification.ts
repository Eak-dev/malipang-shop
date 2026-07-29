import { createFailedJob,findOpenFailedJobPayload,resolveFailedJobs,safeRecordMetric } from "../db/repositories";
import { sha256Hex } from "../shared/ids";
import { queueRetryDelaySeconds } from "../shared/retry";
import type { Env,LineNotificationJob,LineNotificationPurpose,QueueJob } from "../types";
import { isPermanentLineNotificationError,lineOutputEnabled,pushRetryableLineMessages } from "./api";

async function deterministicRetryKey(identity:string):Promise<string>{
  const bytes=new TextEncoder().encode(identity);
  const hex=await sha256Hex(bytes.buffer);
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
}

export async function buildAttendanceNotificationJob(input:{
  to:string;
  text:string;
  identity:string;
  purpose:LineNotificationPurpose;
  traceId:string;
}):Promise<LineNotificationJob>{
  return{
    kind:"LINE_NOTIFICATION",
    to:input.to,
    messages:[{type:"text",text:input.text}],
    purpose:input.purpose,
    retryKey:await deterministicRetryKey(input.identity),
    traceId:input.traceId
  };
}

export async function enqueueAttendanceNotification(env:Env,input:{
  to:string;
  text:string;
  identity:string;
  purpose:"ATTENDANCE_RESULT"|"ATTENDANCE_REJECTION"|"ATTENDANCE_SMOKE";
  traceId:string;
}):Promise<LineNotificationJob|null>{
  if(!lineOutputEnabled(env))return null;
  const candidate=await buildAttendanceNotificationJob(input);
  const persisted=await findOpenFailedJobPayload<LineNotificationJob>(env,"malipang-jobs",input.traceId,candidate);
  const job=persisted?.kind==="LINE_NOTIFICATION"&&persisted.retryKey===candidate.retryKey?persisted:candidate;
  if(!persisted)await createFailedJob(env,"malipang-jobs",input.traceId,job,"PENDING_LINE_NOTIFICATION_DELIVERY");
  try{
    await env.JOB_QUEUE.send(job);
  }catch(error){
    await createFailedJob(env,"malipang-jobs",input.traceId,job,error);
    throw error;
  }
  await safeRecordMetric(env,input.traceId,"line_notification_enqueued",0,{purpose:input.purpose});
  return job;
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
    await createFailedJob(env,queueName,job.traceId,job,error);
    if(isPermanentLineNotificationError(error)){
      await safeRecordMetric(env,job.traceId,"line_notification_permanent_failure",0,{purpose:job.purpose});
      message.ack();
      return;
    }
    const delaySeconds=queueRetryDelaySeconds(error,attempt);
    message.retry(delaySeconds?{delaySeconds}:undefined);
  }
}
