import { incrementDailyUsage } from "../db/repositories";
import { isTrue, numberEnv } from "../shared/env";
import type { Env, VisionResult } from "../types";
import { readImageWithOpenAI } from "./openai";
import { readImageWithWorkersAI } from "./workers-ai";

export async function classifyAndRead(env: Env, preview: ArrayBuffer, original: ArrayBuffer): Promise<VisionResult> {
  let primary: VisionResult | null = null;
  if (isTrue(env.WORKERS_AI_ENABLED)) {
    try { primary = await readImageWithWorkersAI(env, preview); } catch (error) { console.error("workers-ai",error); }
  }
  const threshold = numberEnv(env.CLOCK_PRIMARY_MIN_CONFIDENCE,0.97);
  const needsFallback = !primary || primary.kind === "UNKNOWN" || primary.needsNewPhoto || (primary.kind === "CLOCK" && primary.confidence < threshold);
  if (!needsFallback && primary) return primary;
  if (!isTrue(env.OPENAI_FALLBACK_ENABLED) || !env.OPENAI_API_KEY) return primary || {kind:"UNKNOWN",hour:null,minute:null,month:null,day:null,weekday:null,confidence:0,clockFullyVisible:null,needsNewPhoto:true,note:"No vision provider succeeded",provider:"none",raw:null};
  const count = await incrementDailyUsage(env,"openai_fallback_calls");
  if (count > numberEnv(env.OPENAI_DAILY_FALLBACK_LIMIT,100)) return primary || {kind:"UNKNOWN",hour:null,minute:null,month:null,day:null,weekday:null,confidence:0,clockFullyVisible:null,needsNewPhoto:true,note:"OpenAI daily limit reached",provider:"budget-guard",raw:null};
  return readImageWithOpenAI(env, original);
}
