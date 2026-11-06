import { AttendanceCoordinator } from "./durable/attendance-coordinator";
import { handleAdmin } from "./admin/handler";
import { createFailedJob,InboundBusyError,resolveFailedJobs } from "./db/repositories";
import { runScheduledMaintenance } from "./operations/maintenance";
import { processInbound } from "./router/process-event";
import { missingRuntimeConfig } from "./shared/env";
import { ensureSheetSyncOutbox,SHEET_SYNC_BUSY_RETRY_SECONDS,syncJob } from "./sheets/sync";
import {dispatchStablePhase1,isStableWorkbookBusy,isStableWorkbookReview} from './sheets/stable-phase1-dispatch';
import {withStableWorkbookClaim,STABLE_NOTICE_READ_DEFERRED} from './sheets/stable-workbook-claim';
import {stableRecoveryGateBlocked,STABLE_RECOVERY_BLOCKED,recoveryGateConfigured,recoveryGateValid} from './sheets/stable-recovery-admission';
import {stablePacingConfigured,stablePacingValid,persistedStableBusyDelay,STABLE_SHEETS_PACING_BLOCKED,STABLE_SHEETS_PACING_UNAVAILABLE} from './sheets/stable-sheet-pacing';
import { processStaffConfigSyncJob,type StaffConfigSyncJob } from "./sheets/staff-config";
import { pushOwnerAlert } from "./line/api";
import { processLineNotificationMessage } from "./line/attendance-notification";
import { queueRetryDelaySeconds } from "./shared/retry";
import type { Env,QueueJob } from "./types";
import { handleLineWebhook } from "./webhook/handler";
export{AttendanceCoordinator};
function queueMessageAttempt(message:Message<QueueJob>):number{
  const attempts=Number((message as Message<QueueJob>&{attempts?:number}).attempts||1);
  return Number.isFinite(attempts)&&attempts>0?Math.floor(attempts):1;
}
type WorkbookQueueJob=QueueJob|StaffConfigSyncJob;
const isWorkbookQueueJob=(job:WorkbookQueueJob):boolean=>job.kind==='SHEETS_SYNC'||job.kind==='STAFF_CONFIG_SYNC';
async function operationalBusyDelay(env:Env,job:WorkbookQueueJob):Promise<number>{
 if(!stablePacingConfigured(env)||!isWorkbookQueueJob(job))return SHEET_SYNC_BUSY_RETRY_SECONDS;
 const identity=job.kind==='STAFF_CONFIG_SYNC'?{entityType:'STAFF_CONFIG_SYNC',entityKey:job.employeeId,entityVersion:job.version}:
  job.kind==='SHEETS_SYNC'?{entityType:job.entityType,entityKey:job.entityKey,entityVersion:job.entityVersion}:null;
 return identity?persistedStableBusyDelay(env,identity):SHEET_SYNC_BUSY_RETRY_SECONDS;
}
export default{
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const url=new URL(request.url),missing=missingRuntimeConfig(env);
    if(request.method==="GET"&&url.pathname==="/health")return Response.json({ok:missing.length===0,service:"malipang-backend-v5.2-solo",version:"5.2.0-rc.2",mode:env.RUNTIME_MODE,configured:missing.length===0,check:"configuration_only",readiness:"/admin/readiness",missing,now:new Date().toISOString()},{status:missing.length?503:200});
    if(missing.length)return Response.json({ok:false,error:"SERVICE_NOT_CONFIGURED",missing},{status:503});
    if(request.method==="POST"&&url.pathname==="/webhook/line")return handleLineWebhook(request,env,ctx);
    if(url.pathname.startsWith("/admin/"))return handleAdmin(request,env,ctx);
    return new Response("Not found",{status:404});
  },
  async queue(batch:MessageBatch<QueueJob>,env:Env,ctx:ExecutionContext):Promise<void>{
    if(batch.queue==="malipang-jobs-dlq"){
      for(const message of batch.messages){const job=message.body as QueueJob|StaffConfigSyncJob;try{await createFailedJob(env,"malipang-jobs",job.traceId,job,"DEAD_LETTER_MAX_RETRIES");}catch(error){console.error("dlq-log",error);message.retry();continue;}const description=job.kind==="LINE_EVENT"?"LINE_EVENT":job.kind==="LINE_NOTIFICATION"?`LINE_NOTIFICATION ${job.purpose}`:job.kind==="STAFF_CONFIG_SYNC"?`STAFF_CONFIG ${job.employeeId}`:`${job.entityType} ${job.entityKey}`;try{await pushOwnerAlert(env,`🚨 MaliPang DLQ\nงาน: ${description}\nTrace: ${job.traceId}\nตรวจ /admin/status และ failed_jobs`,job.traceId);}catch(error){console.error("dlq-alert",error);}message.ack();}
      return;
    }
    // When opted into recovery pacing, one batch may process at most ONE
    // workbook writer. LINE work is prioritized; never drop an unprocessed
    // LINE event to make room for Sheets. Park excess writes in their durable
    // outbox and let controlled cron re-deliver them.
    const paceBatch=stablePacingConfigured(env)||recoveryGateConfigured(env);
    if(recoveryGateConfigured(env)&&!recoveryGateValid(env))console.error('stable-recovery-gate-invalid-config');
    if(stablePacingConfigured(env)&&!stablePacingValid(env))console.error('stable-sheets-pacing-invalid-config');
    const includesLine=batch.messages.some(m=>{const j=m.body as WorkbookQueueJob;return j.kind==='LINE_EVENT'||j.kind==='LINE_NOTIFICATION';});
    const chosenSheet=paceBatch&&!includesLine?batch.messages.find(m=>isWorkbookQueueJob(m.body as WorkbookQueueJob)):null;
    await Promise.all(batch.messages.map(async message=>{const job=message.body as QueueJob|StaffConfigSyncJob,attempt=queueMessageAttempt(message);
      if(paceBatch&&isWorkbookQueueJob(job)&&message!==chosenSheet){
        try{
          if(job.kind==='SHEETS_SYNC')await ensureSheetSyncOutbox(env,job);
          else if(job.kind==='STAFF_CONFIG_SYNC'){
            const persisted=await env.DB.prepare("SELECT 1 present FROM staff_config_sync_outbox WHERE employee_id=? AND version=?").bind(job.employeeId,job.version).first<{present:number}>();
            if(!persisted)throw Error('STAFF_CONFIG_OUTBOX_UNVERIFIED');
          }
          message.ack();
        }catch{message.retry({delaySeconds:90});}
        return;
      }if(job.kind==="LINE_NOTIFICATION"){await processLineNotificationMessage(env,batch.queue,message,attempt);return;}try{if(job.kind==="LINE_EVENT")await processInbound(job,env,ctx);else if(job.kind==="STAFF_CONFIG_SYNC"){if(env.STABLE_PHASE1_ENABLED==='true'){
   if(await stableRecoveryGateBlocked(env,job)){message.ack();return;}
   await withStableWorkbookClaim(env,()=>processStaffConfigSyncJob(env,job),job);
  }else await processStaffConfigSyncJob(env,job);}else{const outcome=env.STABLE_PHASE1_ENABLED==='true'?await dispatchStablePhase1(env,job,attempt):await syncJob(env,job,attempt);if(outcome==="BUSY"||outcome==='CONTINUE'){
 const delay=outcome==='CONTINUE'?90:await operationalBusyDelay(env,job);
 await env.JOB_QUEUE.send(job,{delaySeconds:delay});message.ack();return;}if(outcome==='REVIEW'||outcome==='BLOCKED'){message.ack();return;}}await resolveFailedJobs(env,batch.queue,job.traceId,job);message.ack();}catch(error){if(error instanceof Error&&[STABLE_RECOVERY_BLOCKED,STABLE_SHEETS_PACING_UNAVAILABLE].includes(error.message)){
  if(job.kind==='SHEETS_SYNC'){try{await ensureSheetSyncOutbox(env,job);}catch{message.retry({delaySeconds:SHEET_SYNC_BUSY_RETRY_SECONDS});return;}}
  message.ack();return;
 }if(isStableWorkbookBusy(error)||(error instanceof Error&&[STABLE_SHEETS_PACING_BLOCKED,STABLE_NOTICE_READ_DEFERRED].includes(error.message))){
 const delay=await operationalBusyDelay(env,job);
 if(job.kind==='STAFF_CONFIG_SYNC')await (env.JOB_QUEUE as unknown as Queue<StaffConfigSyncJob>).send(job,{delaySeconds:delay});else await env.JOB_QUEUE.send(job,{delaySeconds:delay});message.ack();return;}if(isStableWorkbookReview(error)){/* Both outboxes keep the job; scheduled recovery re-sends it after review. */if(job.kind==='SHEETS_SYNC'){try{await ensureSheetSyncOutbox(env,job);}catch{message.retry({delaySeconds:SHEET_SYNC_BUSY_RETRY_SECONDS});return;}}message.ack();return;}if(error instanceof InboundBusyError){message.retry({delaySeconds:300});return;}console.error("queue",batch.queue,error);try{await createFailedJob(env,batch.queue,job.traceId,job,error);}catch(logError){console.error("failed-job-log",logError);}const delaySeconds=queueRetryDelaySeconds(error,attempt);message.retry(delaySeconds?{delaySeconds}:undefined);}}));
  },
  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext):Promise<void>{
    ctx.waitUntil(runScheduledMaintenance(env));
  }
} satisfies ExportedHandler<Env,QueueJob>;
