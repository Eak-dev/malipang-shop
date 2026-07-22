import { extractJsonObject } from "../shared/json";
import { arrayBufferToBase64 } from "../shared/base64";
import type { Env,VisionResult } from "../types";
function normalize(raw:unknown,provider:string):VisionResult{
  const envelope=raw as{result?:unknown},output=(envelope?.result&&typeof envelope.result==="object"?envelope.result:raw) as{answer?:unknown;caption?:unknown;response?:unknown};
  const text=typeof raw==="string"?raw:typeof output.answer==="string"?output.answer:typeof output.caption==="string"?output.caption:typeof output.response==="string"?output.response:JSON.stringify(raw),obj=extractJsonObject(text)||{};
  const kind=["CLOCK","RECEIPT","BANK_SLIP","ONLINE_ORDER","UNKNOWN"].includes(String(obj.kind))?String(obj.kind) as VisionResult["kind"]:"UNKNOWN";
  const num=(v:unknown):number|null=>v==null||v===""?null:Number.isFinite(Number(v))?Number(v):null;
  return{kind,hour:num(obj.hour),minute:num(obj.minute),month:num(obj.month),day:num(obj.day),weekday:obj.weekday?String(obj.weekday):null,confidence:Number(obj.confidence||0),clockFullyVisible:typeof obj.clockFullyVisible==="boolean"?obj.clockFullyVisible:null,needsNewPhoto:Boolean(obj.needsNewPhoto),note:String(obj.note||""),provider,raw};
}
export async function readImageWithWorkersAI(env:Env,image:ArrayBuffer):Promise<VisionResult>{
  const prompt=`Return JSON only. Classify as CLOCK, RECEIPT, BANK_SLIP, ONLINE_ORDER, or UNKNOWN. For CLOCK read only visible pixels: large white center digits are hour/minute, green above M is month, and green above D is day. Read the four large white seven-segment digits left to right. Treat curved, diagonal, or uneven glare as noise; a real LED segment is a straight bar aligned with the digit grid. Double-check 5 versus 9: 5 has upper-left on and upper-right off, while 9 has both upper vertical segments on. If two visual passes disagree, use null and needsNewPhoto=true instead of guessing. Always return weekday=null because weekday OCR is not used for attendance. Never infer from current time or metadata. Schema: {"kind":"CLOCK|RECEIPT|BANK_SLIP|ONLINE_ORDER|UNKNOWN","hour":number|null,"minute":number|null,"month":number|null,"day":number|null,"weekday":string|null,"confidence":0..1,"clockFullyVisible":boolean|null,"needsNewPhoto":boolean,"note":""}. Use null and needsNewPhoto=true when required clock fields are unclear.`;
  const input={task:"query",image:`data:image/jpeg;base64,${arrayBufferToBase64(image)}`,question:prompt,reasoning:false,temperature:0,max_tokens:350,stream:false};
  return normalize(await env.AI.run(env.WORKERS_AI_MODEL,input),"workers-ai");
}
