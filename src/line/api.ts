import type { Env } from "../types";

function lineOutputEnabled(env: Env): boolean { return env.RUNTIME_MODE !== "shadow" || env.SHADOW_LINE_OUTPUT === "true"; }
async function lineFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`);
  const res = await fetch(`https://api.line.me${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`LINE ${path} HTTP ${res.status}: ${await res.text()}`);
  return res;
}
export async function startLoading(env: Env, chatId: string): Promise<void> {
  if (!lineOutputEnabled(env) || env.LINE_LOADING_ENABLED !== "true" || !chatId) return;
  await lineFetch(env, "/v2/bot/chat/loading/start", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ chatId, loadingSeconds:Number(env.LINE_LOADING_SECONDS||20) }) });
}
export async function pushText(env: Env, to: string, text: string): Promise<void> {
  if (!lineOutputEnabled(env)) return;
  await lineFetch(env, "/v2/bot/message/push", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ to, messages:[{type:"text", text}] }) });
}
export async function replyText(env: Env, replyToken: string, text: string): Promise<void> {
  if (!lineOutputEnabled(env)) return;
  await lineFetch(env, "/v2/bot/message/reply", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ replyToken, messages:[{type:"text", text}] }) });
}
export async function pushConfirmation(env: Env, to: string, title: string, body: string, confirmData: string, cancelData: string): Promise<void> {
  if (!lineOutputEnabled(env)) return;
  const message = { type:"template", altText:title, template:{ type:"confirm", text:body.slice(0,240), actions:[{type:"postback", label:"ยืนยัน", data:confirmData, displayText:"ยืนยันบันทึก"},{type:"postback", label:"ยกเลิก", data:cancelData, displayText:"ยกเลิก"}] } };
  await lineFetch(env, "/v2/bot/message/push", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({to,messages:[message]}) });
}
export async function downloadLineContent(env: Env, messageId: string, preview=false): Promise<ArrayBuffer> {
  const suffix = preview ? "/preview" : "";
  const res = await fetch(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content${suffix}`, { headers:{Authorization:`Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`} });
  if (!res.ok) throw new Error(`LINE content HTTP ${res.status}: ${await res.text()}`);
  return res.arrayBuffer();
}
