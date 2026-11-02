import type {Env} from "../types";
import {numberEnv} from "../shared/env";
import {SheetsHttpError,isAmbiguousSheetsMutationStatus} from "./client";

const MIN_FENCE_MS=15*60_000;
function times(env:Env,nowMs:number):{now:string;until:string}|null{
  if(!Number.isFinite(nowMs))return null;const timeout=numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000);
  if(!Number.isFinite(timeout)||timeout<0)return null;const now=new Date(nowMs),until=new Date(nowMs+Math.max(MIN_FENCE_MS,timeout+240_000));
  if(!Number.isFinite(now.getTime())||!Number.isFinite(until.getTime()))return null;return {now:now.toISOString(),until:until.toISOString()};
}

/** Claim the whole daily sheet, never an individually assumed row. */
export async function claimCorrectionDailyWriteFence(env:Env,sheet:string,nowMs=Date.now()):Promise<string|null>{
  const t=times(env,nowMs);if(!t||!sheet.trim()||sheet.length>200)return null;const token=crypto.randomUUID();
  const result=await env.DB.prepare(`INSERT INTO owner_correction_daily_write_fences(sheet_name,lease_token,lease_until,state,dispatch_id,not_before,updated_at)
    VALUES(?,?,?,'OWNED',NULL,NULL,?) ON CONFLICT(sheet_name) DO UPDATE SET lease_token=excluded.lease_token,lease_until=excluded.lease_until,state='OWNED',dispatch_id=NULL,not_before=NULL,updated_at=excluded.updated_at
    WHERE owner_correction_daily_write_fences.lease_until<=? AND (owner_correction_daily_write_fences.state='OWNED' OR (owner_correction_daily_write_fences.state='IN_FLIGHT' AND owner_correction_daily_write_fences.not_before<=?))`)
    .bind(sheet,token,t.until,t.now,t.now,t.now).run();return Number(result.meta.changes||0)===1?token:null;
}

/** Call only after authentication and immediately before a Sheets dispatch. */
export async function armCorrectionDailyWriteFence(env:Env,sheet:string,token:string,nowMs=Date.now()):Promise<string|null>{
  const t=times(env,nowMs);if(!t||!sheet||!token)return null;const dispatch=crypto.randomUUID();
  const result=await env.DB.prepare(`UPDATE owner_correction_daily_write_fences SET state='IN_FLIGHT',dispatch_id=?,not_before=?,lease_until=?,updated_at=?
    WHERE sheet_name=? AND lease_token=? AND state='OWNED' AND lease_until>?`)
    .bind(dispatch,t.until,t.until,t.now,sheet,token,t.now).run();return Number(result.meta.changes||0)===1?dispatch:null;
}

/** A caller may finish only when the provider response proves an outcome. */
export async function finishCorrectionDailyWriteFence(env:Env,sheet:string,token:string,dispatch:string,nowMs=Date.now()):Promise<boolean>{
  const t=times(env,nowMs);if(!t||!sheet||!token||!dispatch)return false;
  const result=await env.DB.prepare(`UPDATE owner_correction_daily_write_fences SET state='OWNED',dispatch_id=NULL,not_before=NULL,lease_until=?,updated_at=?
    WHERE sheet_name=? AND lease_token=? AND state='IN_FLIGHT' AND dispatch_id=? AND lease_until>?`)
    .bind(t.until,t.now,sheet,token,dispatch,t.now).run();return Number(result.meta.changes||0)===1;
}

/** Unknown outcomes stay fenced until their original uncertainty deadline. */
export async function releaseCorrectionDailyWriteFence(env:Env,sheet:string,token:string):Promise<boolean>{
  if(!sheet||!token)return false;const result=await env.DB.prepare(`DELETE FROM owner_correction_daily_write_fences WHERE sheet_name=? AND lease_token=? AND state='OWNED'`).bind(sheet,token).run();
  return Number(result.meta.changes||0)===1;
}

export class CorrectionDailyFenceBusyError extends Error{constructor(){super("CORRECTION_DAILY_SHEET_BUSY");this.name="CorrectionDailyFenceBusyError";}}
export type GuardedDailyMutation=(dispatch:(beforeDispatch?:()=>Promise<void>)=>Promise<void>)=>Promise<void>;

/**
 * The wrapper is inert while the feature is off. Every external mutation in
 * the operation must use `write`, and the provider must invoke its callback
 * immediately before dispatch. A lost response leaves the fence in flight.
 */
export async function withCorrectionDailyWriteFence<T>(env:Env,sheet:string,action:(write:GuardedDailyMutation,fenceToken?:string)=>Promise<T>,now:()=>number=()=>Date.now()):Promise<T>{
  if(env.OWNER_EXPENSE_CORRECTION_ENABLED!=="true")return action(async dispatch=>dispatch());
  const token=await claimCorrectionDailyWriteFence(env,sheet,now());if(!token)throw new CorrectionDailyFenceBusyError();
  try{
    const write:GuardedDailyMutation=async dispatch=>{
      let id:string|null=null;
      try{
        await dispatch(async()=>{id=await armCorrectionDailyWriteFence(env,sheet,token,now());if(!id)throw new CorrectionDailyFenceBusyError();});
        if(!id)throw new Error("CORRECTION_DAILY_DISPATCH_NOT_ARMED");
        if(!await finishCorrectionDailyWriteFence(env,sheet,token,id,now()))throw new CorrectionDailyFenceBusyError();
      }catch(error){
        // SheetsHttpError is a definite non-ambiguous provider response; the
        // client wraps timeouts and uncertain 5xx/408 outcomes separately.
        if(id&&error instanceof SheetsHttpError&&!isAmbiguousSheetsMutationStatus(error.status))await finishCorrectionDailyWriteFence(env,sheet,token,id,now());
        throw error;
      }
    };
    return await action(write,token);
  }finally{await releaseCorrectionDailyWriteFence(env,sheet,token);}
}
