import { downloadLineContent } from "../line/api";
import { randomId } from "../shared/ids";
import type { Env } from "../types";
import { classifyAndRead } from "../vision/service";

export async function inspectLineImage(env:Env,input:{messageId?:string}):Promise<{traceId:string;messageId:string;reading:unknown}>{
  const messageId=String(input.messageId||"").trim();
  if(!/^\d{6,30}$/.test(messageId))throw new Error("A valid numeric LINE messageId is required");
  const traceId=randomId("inspect"),originalPromise=downloadLineContent(env,messageId,false,traceId);
  const preview=await downloadLineContent(env,messageId,true,traceId).catch(()=>originalPromise),original=await originalPromise;
  const reading=await classifyAndRead(env,preview,original,traceId,{usageMetric:"openai_admin_test_calls",enforceDailyLimit:false});
  return{traceId,messageId,reading};
}
