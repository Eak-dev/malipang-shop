import { AttendanceCoordinator } from "./durable/attendance-coordinator";
import { handleAdmin } from "./admin/handler";
import { createFailedJob,InboundBusyError,recoverPendingSheetJobs,resolveFailedJobs } from "./db/repositories";
import { processInbound } from "./router/process-event";
import { missingRuntimeConfig } from "./shared/env";
import { syncJob } from "./sheets/sync";
import type { Env,QueueJob } from "./types";
import { handleLineWebhook } from "./webhook/handler";
export{AttendanceCoordinator};
export default{
  async fetch(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
    const url=new URL(request.url),missing=missingRuntimeConfig(env);
    if(request.method==="GET"&&url.pathname==="/health")return Response.json({ok:missing.length===0,service:"malipang-backend-v5.2-solo",version:"5.2.0-rc.1",mode:env.RUNTIME_MODE,configured:missing.length===0,missing,now:new Date().toISOString()},{status:missing.length?503:200});
    if(missing.length)return Response.json({ok:false,error:"SERVICE_NOT_CONFIGURED",missing},{status:503});
    if(request.method==="POST"&&url.pathname==="/webhook/line")return handleLineWebhook(request,env,ctx);
    if(url.pathname.startsWith("/admin/"))return handleAdmin(request,env,ctx);
    return new Response("Not found",{status:404});
  },
  async queue(batch:MessageBatch<QueueJob>,env:Env,ctx:ExecutionContext):Promise<void>{
    for(const message of batch.messages){const job=message.body;try{if(job.kind==="LINE_EVENT")await processInbound(job,env,ctx);else await syncJob(env,job);await resolveFailedJobs(env,batch.queue,job.traceId);message.ack();}catch(error){if(error instanceof InboundBusyError){message.retry({delaySeconds:300});continue;}console.error("queue",batch.queue,error);try{await createFailedJob(env,batch.queue,job.traceId,job,error);}catch(logError){console.error("failed-job-log",logError);}message.retry();}}
  },
  async scheduled(_controller:ScheduledController,env:Env,ctx:ExecutionContext):Promise<void>{
    const stale=new Date(Date.now()-15*60*1000).toISOString();ctx.waitUntil((async()=>{await env.DB.prepare(`UPDATE inbound_events SET status='STALE',error='PROCESSING_LEASE_EXPIRED' WHERE status='PROCESSING' AND last_attempt_at<?`).bind(stale).run();await recoverPendingSheetJobs(env);})());
  }
} satisfies ExportedHandler<Env,QueueJob>;
