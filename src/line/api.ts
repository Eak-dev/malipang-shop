import type { Env } from "../types";
import { safeRecordMetric } from "../db/repositories";
import { fetchWithTimeout } from "../shared/async";
import { numberEnv } from "../shared/env";

function lineOutputEnabled(env: Env): boolean { return env.RUNTIME_MODE !== "shadow" || env.SHADOW_LINE_OUTPUT === "true"; }
async function lineFetch(env: Env, path: string, init: RequestInit, traceId="", metricName="line_api_ms"): Promise<Response> {
  const started=Date.now();let status="ERROR";
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`);
  try{
    const res = await fetchWithTimeout(`https://api.line.me${path}`, { ...init, headers },numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000),`LINE ${path}`);
    status=String(res.status);if (!res.ok) throw new Error(`LINE ${path} HTTP ${res.status}: ${await res.text()}`);return res;
  }finally{await safeRecordMetric(env,traceId,metricName,Date.now()-started,{path,status});}
}
export async function startLoading(env: Env, chatId: string, traceId=""): Promise<void> {
  if (!lineOutputEnabled(env) || env.LINE_LOADING_ENABLED !== "true" || !chatId) return;
  await lineFetch(env, "/v2/bot/chat/loading/start", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ chatId, loadingSeconds:Number(env.LINE_LOADING_SECONDS||20) }) },traceId,"line_loading_ms");
}
export async function pushText(env: Env, to: string, text: string, traceId=""): Promise<void> {
  if (!lineOutputEnabled(env)) return;
  await lineFetch(env, "/v2/bot/message/push", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ to, messages:[{type:"text", text}] }) },traceId,"line_push_ms");
}
export async function replyText(env: Env, replyToken: string, text: string, traceId=""): Promise<void> {
  if (!lineOutputEnabled(env)) return;
  await lineFetch(env, "/v2/bot/message/reply", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ replyToken, messages:[{type:"text", text}] }) },traceId,"line_reply_ms");
}
export async function pushConfirmation(env: Env, to: string, title: string, body: string, confirmData: string, cancelData: string, traceId=""): Promise<void> {
  if (!lineOutputEnabled(env)) return;
  const message = { type:"template", altText:title, template:{ type:"confirm", text:body.slice(0,240), actions:[{type:"postback", label:"ยืนยัน", data:confirmData, displayText:"ยืนยันบันทึก"},{type:"postback", label:"ยกเลิก", data:cancelData, displayText:"ยกเลิก"}] } };
  await lineFetch(env, "/v2/bot/message/push", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({to,messages:[message]}) },traceId,"line_push_ms");
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
export async function pushOwnerAlert(env:Env,text:string,traceId=""):Promise<void>{
  if(!env.LINE_OWNER_USER_ID)throw new Error("LINE_OWNER_USER_ID missing");
  await lineFetch(env,"/v2/bot/message/push",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({to:env.LINE_OWNER_USER_ID,messages:[{type:"text",text}]})},traceId,"line_dlq_alert_ms");
}
