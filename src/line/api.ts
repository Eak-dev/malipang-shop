import type { Env } from "../types";
import { safeRecordMetric } from "../db/repositories";
import { fetchWithTimeout } from "../shared/async";
import { numberEnv } from "../shared/env";

export class LineApiError extends Error{
  constructor(
    public readonly status:number,
    message:string,
    public readonly retryAfterSeconds?:number,
    public readonly code?:string
  ){
    super(message);this.name="LineApiError";
  }
}
export function lineOutputEnabled(env: Env): boolean { return env.RUNTIME_MODE !== "shadow" || env.SHADOW_LINE_OUTPUT === "true"; }
function retryAfterSeconds(value:string|null):number|undefined{
  if(!value)return undefined;
  const seconds=Number(value);
  if(Number.isFinite(seconds)&&seconds>=0)return Math.ceil(seconds);
  const date=Date.parse(value);
  return Number.isFinite(date)?Math.max(0,Math.ceil((date-Date.now())/1000)):undefined;
}
async function lineFetch(env: Env, path: string, init: RequestInit, traceId="", metricName="line_api_ms",acceptResponse?:(response:Response)=>boolean): Promise<Response> {
  const started=Date.now();let status="ERROR";
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`);
  try{
    const res = await fetchWithTimeout(`https://api.line.me${path}`, { ...init, headers },numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),`LINE ${path}`);
    status=String(res.status);
    if(!res.ok&&!acceptResponse?.(res)){
      const body=await res.text(),monthlyQuota=path==="/v2/bot/message/push"&&res.status===429&&/(monthly|month).*(limit|quota)|(limit|quota).*(monthly|month)/i.test(body);
      throw new LineApiError(
        res.status,
        monthlyQuota?"LINE_PUSH_QUOTA_EXHAUSTED":`LINE ${path} HTTP ${res.status}`,
        retryAfterSeconds(res.headers.get("Retry-After")),
        monthlyQuota?"LINE_PUSH_QUOTA_EXHAUSTED":undefined
      );
    }
    return res;
  }finally{await safeRecordMetric(env,traceId,metricName,Date.now()-started,{path,status});}
}
export async function startLoading(env: Env, chatId: string, traceId=""): Promise<void> {
  if (!lineOutputEnabled(env) || env.LINE_LOADING_ENABLED !== "true" || !chatId) return;
  await lineFetch(env, "/v2/bot/chat/loading/start", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ chatId, loadingSeconds:Number(env.LINE_LOADING_SECONDS||20) }) },traceId,"line_loading_ms");
}
export async function pushText(env: Env, to: string, text: string, traceId=""): Promise<void> {
  if (!lineOutputEnabled(env)) return;
  await pushLineMessages(env,to,[{type:"text",text}],traceId);
}
export async function pushFlex(env:Env,to:string,message:unknown,traceId=""):Promise<void>{
  if(!lineOutputEnabled(env))return;
  await pushLineMessages(env,to,[message],traceId);
}
export async function pushActionableFlex(env:Env,to:string,message:unknown,traceId=""):Promise<void>{
  if(!lineOutputEnabled(env))return;
  await pushLineMessagesStrict(env,to,[message],traceId);
}
function notificationHttpStatus(error:unknown):string{
  const match=error instanceof Error?error.message.match(/\bHTTP (\d{3})\b/):null;
  return match?.[1]||"ERROR";
}
async function pushLineMessagesStrict(env:Env,to:string,messages:unknown[],traceId:string):Promise<void>{
  await lineFetch(env,"/v2/bot/message/push",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({to,messages})},traceId,"line_push_ms");
}
export async function pushRetryableLineMessages(env:Env,to:string,messages:unknown[],retryKey:string,traceId=""):Promise<void>{
  if(!lineOutputEnabled(env))return;
  await lineFetch(
    env,
    "/v2/bot/message/push",
    {method:"POST",headers:{"content-type":"application/json","X-Line-Retry-Key":retryKey},body:JSON.stringify({to,messages})},
    traceId,
    "line_notification_delivery_ms",
    response=>response.status===409&&Boolean(response.headers.get("x-line-accepted-request-id"))
  );
}
export function isPushQuotaExhaustedError(error:unknown):boolean{
  return error instanceof LineApiError&&error.code==="LINE_PUSH_QUOTA_EXHAUSTED";
}
export function isPermanentLineNotificationError(error:unknown):boolean{
  const status=error instanceof LineApiError?error.status:Number(String(error instanceof Error?error.message:error).match(/\bHTTP (\d{3})\b/)?.[1]||0);
  return status>=400&&status<500&&![408,409,425,429].includes(status);
}
async function pushLineMessages(env:Env,to:string,messages:unknown[],traceId:string):Promise<void>{
  try{
    await pushLineMessagesStrict(env,to,messages,traceId);
  }catch(error){
    const status=notificationHttpStatus(error);
    console.error("line-notification-failed",{channel:"push",status});
    await safeRecordMetric(env,traceId,"line_notification_failure",0,{channel:"push",status});
  }
}
export async function replyLineMessages(env:Env,replyToken:string,messages:unknown[],traceId=""):Promise<void>{
  if (!lineOutputEnabled(env)) return;
  if(!replyToken.trim())throw new Error("LINE reply token missing");
  if(messages.length<1||messages.length>5)throw new Error("LINE Reply API requires 1-5 messages");
  await lineFetch(env, "/v2/bot/message/reply", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ replyToken, messages }) },traceId,"line_reply_ms");
}
export async function replyText(env: Env, replyToken: string, text: string, traceId=""): Promise<void> {
  await replyLineMessages(env,replyToken,[{type:"text",text}],traceId);
}
export async function pushConfirmation(env: Env, to: string, title: string, body: string, confirmData: string, cancelData: string, traceId=""): Promise<void> {
  if (!lineOutputEnabled(env)) return;
  const message = { type:"template", altText:title, template:{ type:"confirm", text:body.slice(0,240), actions:[{type:"postback", label:"ยืนยัน", data:confirmData, displayText:"ยืนยันบันทึก"},{type:"postback", label:"ยกเลิก", data:cancelData, displayText:"ยกเลิก"}] } };
  await pushLineMessagesStrict(env,to,[message],traceId);
}
export async function downloadLineContent(env: Env, messageId: string, preview=false, traceId=""): Promise<ArrayBuffer> {
  const started=Date.now();let status="ERROR";
  const suffix = preview ? "/preview" : "";
  try{
    const res = await fetchWithTimeout(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content${suffix}`, { headers:{Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`} },numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),`LINE content ${preview?"preview":"original"}`);
    status=String(res.status);if (!res.ok) throw new Error(`LINE content HTTP ${res.status}: ${await res.text()}`);return res.arrayBuffer();
  }finally{await safeRecordMetric(env,traceId,preview?"line_preview_download_ms":"line_original_download_ms",Date.now()-started,{status});}
}
export async function getLineBotInfo(env:Env):Promise<{userId:string;displayName:string;basicId?:string}>{
  return lineFetch(env,"/v2/bot/info",{method:"GET"},"readiness","line_readiness_ms").then(res=>res.json()) as Promise<{userId:string;displayName:string;basicId?:string}>;
}
export interface LineMessageQuota{
  targetType:"none"|"limited";
  targetLimit:number|null;
  totalUsage:number;
  remaining:number|null;
  pushCapacity:"UNLIMITED"|"AVAILABLE"|"EXHAUSTED";
}
export async function getLineMessageQuota(env:Env):Promise<LineMessageQuota>{
  const [target,consumption]=await Promise.all([
    lineFetch(env,"/v2/bot/message/quota",{method:"GET"},"readiness","line_quota_target_ms").then(res=>res.json()) as Promise<{type:"none"|"limited";value?:number}>,
    lineFetch(env,"/v2/bot/message/quota/consumption",{method:"GET"},"readiness","line_quota_consumption_ms").then(res=>res.json()) as Promise<{totalUsage:number}>
  ]);
  const totalUsage=Math.max(0,Number(consumption.totalUsage||0));
  if(target.type==="none")return{targetType:"none",targetLimit:null,totalUsage,remaining:null,pushCapacity:"UNLIMITED"};
  const targetLimit=Math.max(0,Number(target.value||0)),remaining=Math.max(0,targetLimit-totalUsage);
  return{targetType:"limited",targetLimit,totalUsage,remaining,pushCapacity:remaining===0?"EXHAUSTED":"AVAILABLE"};
}
export async function pushOwnerAlert(env:Env,text:string,traceId=""):Promise<void>{
  if(!lineOutputEnabled(env))return;
  if(!env.LINE_OWNER_USER_ID)throw new Error("LINE_OWNER_USER_ID missing");
  await lineFetch(env,"/v2/bot/message/push",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({to:env.LINE_OWNER_USER_ID,messages:[{type:"text",text}]})},traceId,"line_dlq_alert_ms");
}
