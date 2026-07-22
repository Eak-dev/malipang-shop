import { extractJsonObject } from "../shared/json";
import type { Env,VisionResult } from "../types";
import { fetchWithTimeout } from "../shared/async";
import { arrayBufferToBase64 } from "../shared/base64";
import { numberEnv } from "../shared/env";
function outputText(data:unknown):string{const d=data as{output_text?:string;output?:Array<{content?:Array<{text?:string}>}>};return typeof d.output_text==="string"?d.output_text:d.output?.flatMap(o=>o.content||[]).map(c=>c.text||"").join("")||"";}
export function buildOpenAIVisionPayload(model:string,image:ArrayBuffer):unknown{
  const schema={type:"object",properties:{kind:{type:"string",enum:["CLOCK","RECEIPT","BANK_SLIP","ONLINE_ORDER","UNKNOWN"]},hour:{type:["integer","null"]},minute:{type:["integer","null"]},month:{type:["integer","null"]},day:{type:["integer","null"]},weekday:{type:["string","null"]},confidence:{type:"number"},clockFullyVisible:{type:["boolean","null"]},needsNewPhoto:{type:"boolean"},note:{type:"string"}},required:["kind","hour","minute","month","day","weekday","confidence","clockFullyVisible","needsNewPhoto","note"],additionalProperties:false};
  const prompt=[
    "Inspect this attendance photo and return only the requested structured result.",
    "Classify it as CLOCK, RECEIPT, BANK_SLIP, ONLINE_ORDER, or UNKNOWN.",
    "The physical MaliPang shop wall clock is wide and black, has large white LED time digits, a Mon-Sun list on the left, and green temperature/month/day digits on the right.",
    "For CLOCK, read only visible pixels: large white center digits are hour/minute, green above M is month, and green above D is day.",
    "Locate the four large white seven-segment digits and read them from left to right before producing the answer.",
    "Treat curved, diagonal, or uneven glare and reflections as noise. A real LED segment is a straight bar aligned with the other segments in that digit.",
    "Double-check 5 versus 9: digit 5 has the upper-left vertical segment on and upper-right vertical segment off; digit 9 has both upper vertical segments on.",
    "Silently inspect the clock digits a second time. If the two readings disagree, return null for the unclear field and needsNewPhoto=true instead of guessing.",
    "Always return weekday=null. Weekday OCR is not trusted and is not used for attendance.",
    "A timestamp watermark or phone overlay is not evidence that the physical clock is present.",
    "Never infer missing fields from current time, LINE time, metadata, or context. Use null and needsNewPhoto=true when any required clock field is unclear.",
    "Set note to an empty string when the image is clear. Use note only for visible uncertainty or a specific problem that requires review."
  ].join("\n");
  return{model,store:false,max_output_tokens:220,text:{format:{type:"json_schema",name:"malipang_image_read",strict:true,schema}},input:[{role:"user",content:[{type:"input_text",text:prompt},{type:"input_image",image_url:`data:image/jpeg;base64,${arrayBufferToBase64(image)}`,detail:"high"}]}]};
}
export function normalizeOpenAIVisionResult(obj:Record<string,unknown>,raw:unknown):VisionResult{
  const num=(v:unknown):number|null=>v==null?null:Number.isFinite(Number(v))?Number(v):null;
  const nullableText=(v:unknown):string|null=>{
    if(v==null)return null;
    const value=String(v).trim();
    return !value||["null","unknown","n/a"].includes(value.toLowerCase())?null:value;
  };
  const kinds=["CLOCK","RECEIPT","BANK_SLIP","ONLINE_ORDER","UNKNOWN"];
  const kind=kinds.includes(String(obj.kind))?String(obj.kind) as VisionResult["kind"]:"UNKNOWN";
  return{kind,hour:num(obj.hour),minute:num(obj.minute),month:num(obj.month),day:num(obj.day),weekday:nullableText(obj.weekday),confidence:Number(obj.confidence||0),clockFullyVisible:typeof obj.clockFullyVisible==="boolean"?obj.clockFullyVisible:null,needsNewPhoto:Boolean(obj.needsNewPhoto),note:String(obj.note||"").trim(),provider:"openai",raw};
}
export async function readImageWithOpenAI(env:Env,image:ArrayBuffer):Promise<VisionResult>{
  if(!env.OPENAI_API_KEY)throw new Error("OPENAI_API_KEY missing");
  const payload=buildOpenAIVisionPayload(env.OPENAI_MODEL,image);
  const res=await fetchWithTimeout("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,"content-type":"application/json"},body:JSON.stringify(payload)},numberEnv(env.VISION_TIMEOUT_MS,45000),"OpenAI vision");if(!res.ok)throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
  const raw=await res.json(),obj=extractJsonObject(outputText(raw))||{};
  return normalizeOpenAIVisionResult(obj,raw);
}
