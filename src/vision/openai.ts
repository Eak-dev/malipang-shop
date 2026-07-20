import { extractJsonObject } from "../shared/json";
import type { Env,VisionResult } from "../types";
import { fetchWithTimeout } from "../shared/async";
import { numberEnv } from "../shared/env";
function toBase64(data:ArrayBuffer):string{let s="";for(const b of new Uint8Array(data))s+=String.fromCharCode(b);return btoa(s);}
function outputText(data:unknown):string{const d=data as{output_text?:string;output?:Array<{content?:Array<{text?:string}>}>};return typeof d.output_text==="string"?d.output_text:d.output?.flatMap(o=>o.content||[]).map(c=>c.text||"").join("")||"";}
export async function readImageWithOpenAI(env:Env,image:ArrayBuffer):Promise<VisionResult>{
  if(!env.OPENAI_API_KEY)throw new Error("OPENAI_API_KEY missing");
  const schema={type:"object",properties:{kind:{type:"string",enum:["CLOCK","RECEIPT","BANK_SLIP","ONLINE_ORDER","UNKNOWN"]},hour:{type:["integer","null"]},minute:{type:["integer","null"]},month:{type:["integer","null"]},day:{type:["integer","null"]},weekday:{type:["string","null"]},confidence:{type:"number"},clockFullyVisible:{type:["boolean","null"]},needsNewPhoto:{type:"boolean"},note:{type:"string"}},required:["kind","hour","minute","month","day","weekday","confidence","clockFullyVisible","needsNewPhoto","note"],additionalProperties:false};
  const payload={model:env.OPENAI_MODEL,store:false,max_output_tokens:220,reasoning:{effort:"minimal"},text:{verbosity:"low",format:{type:"json_schema",name:"malipang_image_read",strict:true,schema}},input:[{role:"user",content:[{type:"input_text",text:"Classify the image. For a MaliPang clock use only visible pixels: large white center digits=time, green above M=month, green above D=day. Never infer missing fields."},{type:"input_image",image_url:`data:image/jpeg;base64,${toBase64(image)}`,detail:"high"}]}]};
  const res=await fetchWithTimeout("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${env.OPENAI_API_KEY}`,"content-type":"application/json"},body:JSON.stringify(payload)},numberEnv(env.VISION_TIMEOUT_MS,45000),"OpenAI vision");if(!res.ok)throw new Error(`OpenAI HTTP ${res.status}: ${await res.text()}`);
  const raw=await res.json(),obj=extractJsonObject(outputText(raw))||{},num=(v:unknown):number|null=>v==null?null:Number.isFinite(Number(v))?Number(v):null;
  const kinds=["CLOCK","RECEIPT","BANK_SLIP","ONLINE_ORDER","UNKNOWN"];const kind=kinds.includes(String(obj.kind))?String(obj.kind) as VisionResult["kind"]:"UNKNOWN";
  return{kind,hour:num(obj.hour),minute:num(obj.minute),month:num(obj.month),day:num(obj.day),weekday:obj.weekday?String(obj.weekday):null,confidence:Number(obj.confidence||0),clockFullyVisible:typeof obj.clockFullyVisible==="boolean"?obj.clockFullyVisible:null,needsNewPhoto:Boolean(obj.needsNewPhoto),note:String(obj.note||""),provider:"openai",raw};
}
