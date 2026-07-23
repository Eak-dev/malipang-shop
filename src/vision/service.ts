import { incrementDailyUsage, safeRecordMetric } from "../db/repositories";
import { withTimeout } from "../shared/async";
import { isTrue, numberEnv } from "../shared/env";
import type { Env, VisionResult } from "../types";
import { readImageWithOpenAI } from "./openai";
import { readImageWithWorkersAI } from "./workers-ai";

export interface VisionReadOptions {
  usageMetric?: string;
  enforceDailyLimit?: boolean;
}

function completeAttendanceCandidate(result:VisionResult):boolean{
  return result.kind==="CLOCK"&&result.clockPresent===true&&result.overlayPresent&&result.overlayTextWhite&&
    Boolean(result.photoDate&&result.photoTime&&result.locationText.trim())&&
    result.latitude!=null&&result.longitude!=null;
}

export function shouldRetryOpenAIAttendance(result:VisionResult,overlayThreshold:number,clockThreshold:number):boolean{
  return completeAttendanceCandidate(result)&&
    (result.overlayConfidence<overlayThreshold||result.clockConfidence<clockThreshold);
}

export function chooseBetterAttendanceReading(first:VisionResult,retry:VisionResult,overlayThreshold=0.9,clockThreshold=0.7):VisionResult{
  if(!completeAttendanceCandidate(retry))return first;
  if(!completeAttendanceCandidate(first))return retry;
  const firstPass=first.overlayConfidence>=overlayThreshold&&first.clockConfidence>=clockThreshold;
  const retryPass=retry.overlayConfidence>=overlayThreshold&&retry.clockConfidence>=clockThreshold;
  if(firstPass!==retryPass)return retryPass?retry:first;
  const firstScore=first.overlayConfidence+first.clockConfidence;
  const retryScore=retry.overlayConfidence+retry.clockConfidence;
  return retryScore>firstScore?retry:first;
}

function failedVision(provider: string, note: string): VisionResult {
  return {kind:"UNKNOWN",hour:null,minute:null,month:null,day:null,weekday:null,confidence:0,clockFullyVisible:null,clockPresent:null,clockConfidence:0,overlayPresent:false,overlayTextWhite:false,photoDate:null,photoTime:null,latitude:null,longitude:null,locationText:"",overlayRawText:"",overlayConfidence:0,needsNewPhoto:true,note,provider,raw:null};
}

export async function classifyAndRead(env: Env, preview: ArrayBuffer, original: ArrayBuffer, traceId="", options:VisionReadOptions={}): Promise<VisionResult> {
  let primary: VisionResult | null = null;
  if (isTrue(env.WORKERS_AI_ENABLED)) {
    const started=Date.now();let primaryError="";try { primary = await withTimeout(readImageWithWorkersAI(env, preview),numberEnv(env.VISION_TIMEOUT_MS,45000),"Workers AI"); } catch (error) { primaryError=String(error instanceof Error?error.message:error).slice(0,240);console.error("workers-ai",error); }finally{await safeRecordMetric(env,traceId,"vision_primary_ms",Date.now()-started,{provider:"workers-ai",success:String(Boolean(primary)),error:primaryError});}
  }
  const threshold = numberEnv(env.ATTENDANCE_OVERLAY_MIN_CONFIDENCE,0.9);
  const clockIncomplete=primary?.kind==="CLOCK"&&(primary.clockPresent!==true||!primary.overlayPresent||!primary.overlayTextWhite||!primary.photoDate||!primary.photoTime||primary.latitude==null||primary.longitude==null||primary.overlayConfidence<threshold);
  const needsFallback = !primary || primary.kind === "UNKNOWN" || primary.needsNewPhoto || clockIncomplete || (primary.kind === "BANK_SLIP" && !primary.document);
  if (!needsFallback && primary) return primary;
  if (!isTrue(env.OPENAI_FALLBACK_ENABLED) || !env.OPENAI_API_KEY) return primary || failedVision("none","No vision provider succeeded");
  const usageMetric=options.usageMetric||"openai_fallback_calls",dailyLimit=numberEnv(env.OPENAI_DAILY_FALLBACK_LIMIT,100);
  const count = await incrementDailyUsage(env,usageMetric);
  if (options.enforceDailyLimit!==false&&count > dailyLimit) return primary || failedVision("budget-guard","OpenAI daily limit reached");
  const started=Date.now();let fallbackError="";
  try{
    const first=await readImageWithOpenAI(env, original);
    const clockThreshold=numberEnv(env.ATTENDANCE_CLOCK_MIN_CONFIDENCE,0.7);
    if(!shouldRetryOpenAIAttendance(first,threshold,clockThreshold))return first;
    const retryCount=await incrementDailyUsage(env,usageMetric);
    if(options.enforceDailyLimit!==false&&retryCount>dailyLimit)return first;
    const retryStarted=Date.now();let retryError="";
    try{
      const retry=await readImageWithOpenAI(env,original);
      return chooseBetterAttendanceReading(first,retry,threshold,clockThreshold);
    }catch(error){
      retryError=String(error instanceof Error?error.message:error).slice(0,240);
      console.error("openai-vision-retry",error);
      return first;
    }finally{
      await safeRecordMetric(env,traceId,"vision_openai_retry_ms",Date.now()-retryStarted,{provider:"openai",success:String(!retryError),error:retryError});
    }
  }
  catch(error){fallbackError=String(error instanceof Error?error.message:error).slice(0,240);console.error("openai-vision",error);return primary||failedVision("openai-error","OpenAI vision request failed");}
  finally{await safeRecordMetric(env,traceId,"vision_fallback_ms",Date.now()-started,{provider:"openai",success:String(!fallbackError),error:fallbackError});}
}
