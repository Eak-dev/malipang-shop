import { extractJsonObject } from "../shared/json";
import type { Env,VisionResult } from "../types";
function bytes(data:ArrayBuffer):number[]{return Array.from(new Uint8Array(data));}
function normalize(raw:unknown,provider:string):VisionResult{
  const text=typeof raw==="string"?raw:typeof(raw as{response?:unknown})?.response==="string"?String((raw as{response:string}).response):JSON.stringify(raw),obj=extractJsonObject(text)||{};
  const kind=["CLOCK","RECEIPT","BANK_SLIP","ONLINE_ORDER","UNKNOWN"].includes(String(obj.kind))?String(obj.kind) as VisionResult["kind"]:"UNKNOWN";
  const num=(v:unknown):number|null=>v==null||v===""?null:Number.isFinite(Number(v))?Number(v):null;
  return{kind,hour:num(obj.hour),minute:num(obj.minute),month:num(obj.month),day:num(obj.day),weekday:obj.weekday?String(obj.weekday):null,confidence:Number(obj.confidence||0),clockFullyVisible:typeof obj.clockFullyVisible==="boolean"?obj.clockFullyVisible:null,needsNewPhoto:Boolean(obj.needsNewPhoto),note:String(obj.note||""),provider,raw};
}
export async function readImageWithWorkersAI(env:Env,image:ArrayBuffer):Promise<VisionResult>{
  const prompt=`Return JSON only. Classify as CLOCK, RECEIPT, BANK_SLIP, ONLINE_ORDER, or UNKNOWN. For CLOCK read only visible pixels: large white center digits are hour/minute, green above M is month, green above D is day, and visible weekday if clear. Never infer from current time or metadata. Schema: {"kind":"CLOCK|RECEIPT|BANK_SLIP|ONLINE_ORDER|UNKNOWN","hour":number|null,"minute":number|null,"month":number|null,"day":number|null,"weekday":string|null,"confidence":0..1,"clockFullyVisible":boolean|null,"needsNewPhoto":boolean,"note":""}. Use null and needsNewPhoto=true when required clock fields are unclear.`;
  return normalize(await env.AI.run(env.WORKERS_AI_MODEL,{image:bytes(image),prompt}),"workers-ai");
}
