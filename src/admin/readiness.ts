import { getLineBotInfo } from "../line/api";
import { withTimeout } from "../shared/async";
import { isTrue, numberEnv } from "../shared/env";
import { getSpreadsheetMetadata } from "../sheets/client";
import { checkDailyExpenseSheet } from "../sheets/daily-expense";
import type { Env } from "../types";

interface ProbeResult { ok:boolean; detail?:unknown; error?:string }
export interface ReadinessResult { ok:boolean; checkedAt:string; checks:Record<string,ProbeResult> }

async function probe(run:()=>Promise<unknown>):Promise<ProbeResult>{
  try{return{ok:true,detail:await run()};}catch(error){return{ok:false,error:String(error instanceof Error?error.message:error)};}
}
export async function checkReadiness(env:Env):Promise<ReadinessResult>{
  const timeout=numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000);
  const [d1,line,sheets,r2]=await Promise.all([
    probe(()=>withTimeout(env.DB.prepare("SELECT 1 AS ok").first(),timeout,"D1 readiness")),
    probe(()=>getLineBotInfo(env)),
    probe(async()=>({metadata:await getSpreadsheetMetadata(env),expenseDaily:await checkDailyExpenseSheet(env)})),
    isTrue(env.R2_EVIDENCE_ENABLED)?probe(()=>withTimeout(env.EVIDENCE.get("__malipang_readiness__"),timeout,"R2 readiness").then(()=>({binding:"reachable"}))):Promise.resolve({ok:true,detail:{enabled:false}})
  ]);
  const checks={d1,line,sheets,r2};return{ok:Object.values(checks).every(check=>check.ok),checkedAt:new Date().toISOString(),checks};
}
