import { startLoading } from "../line/api";
import { verifyLineSignature } from "../line/signature";
import { randomId } from "../shared/ids";
import type { Env,InboundJob,LineWebhookBody } from "../types";
export async function handleLineWebhook(request:Request,env:Env,ctx:ExecutionContext):Promise<Response>{
  const declared=Number(request.headers.get("content-length")||0);if(declared>1024*1024)return new Response("Payload too large",{status:413});
  const raw=await request.text();if(new TextEncoder().encode(raw).byteLength>1024*1024)return new Response("Payload too large",{status:413});
  if(!await verifyLineSignature(raw,request.headers.get("x-line-signature"),env.LINE_CHANNEL_SECRET))return new Response("Invalid signature",{status:401});
  let body:LineWebhookBody;try{body=JSON.parse(raw) as LineWebhookBody;}catch{return new Response("Invalid JSON",{status:400});}
  const events=body.events||[];if(events.length>100)return new Response("Too many events",{status:400});
  const receivedAtIso=new Date().toISOString();const jobs:InboundJob[]=events.map(event=>({kind:"LINE_EVENT",event,receivedAtIso,traceId:randomId("tr")}));
  for(const job of jobs){const userId=job.event.source.type==="user"?job.event.source.userId||"":"";if(userId)ctx.waitUntil(startLoading(env,userId,job.traceId).catch(e=>console.error("loading",e)));}
  if(jobs.length)await env.JOB_QUEUE.sendBatch(jobs.map(body=>({body})));
  return new Response("OK",{status:200});
}
