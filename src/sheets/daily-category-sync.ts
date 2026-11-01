import type {Env,SheetsSyncJob} from "../types";
import {SheetsMutationOutcomeUnknownError} from "./client";
import {runDailyCategoryProjection} from "./daily-category-projection-runner";
import {queueRetryDelaySeconds} from "../shared/retry";

export type CategorySyncOutcome="PROCESSED"|"IGNORED"|"BUSY";
export type CategoryProjectionRunner=(env:Env,job:{expenseId:string;version:number;leaseToken:string})=>Promise<void>;
const ambiguityPrefix="SHEETS_MUTATION_OUTCOME_UNKNOWN:";

/** Claim one version while excluding any concurrent normal Expense projection. */
export async function syncDailyCategoryJob(env:Env,job:SheetsSyncJob,retryAttempt=1,runner:CategoryProjectionRunner=runDailyCategoryProjection):Promise<CategorySyncOutcome>{
  if(env.SHEETS_SYNC_ENABLED!=="true")return "IGNORED";
  const nowMs=Date.now(),now=new Date(nowMs).toISOString(),leaseUntil=new Date(nowMs+15*60_000).toISOString(),token=crypto.randomUUID();
  const claim=await env.DB.prepare(`UPDATE sync_jobs SET status='PROCESSING',attempt_count=attempt_count+1,last_error=NULL,updated_at=?,next_attempt_at=NULL,lease_until=?,lease_token=?
    WHERE entity_type='EXPENSE_CATEGORY' AND entity_key=? AND entity_version=?
      AND (((status='PENDING' OR status='FAILED') AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='PROCESSING' AND lease_until IS NOT NULL AND lease_until<=?))
      AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=sync_jobs.entity_key AND e.status='CONFIRMED' AND e.version=sync_jobs.entity_version)
      AND NOT EXISTS(SELECT 1 FROM sync_jobs active WHERE active.entity_key=sync_jobs.entity_key AND active.entity_type IN ('EXPENSE','EXPENSE_CATEGORY') AND active.status='PROCESSING' AND active.lease_until>? AND active.job_id<>sync_jobs.job_id)`)
    .bind(now,leaseUntil,token,job.entityKey,job.entityVersion,now,now,now).run();
  if(Number(claim.meta.changes||0)!==1){
    // Do not leave an old category outbox pending after a newer approved version.
    await env.DB.prepare(`UPDATE sync_jobs SET status='COMPLETED',updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=NULL
      WHERE entity_type='EXPENSE_CATEGORY' AND entity_key=? AND entity_version=? AND status IN ('PENDING','FAILED')
        AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=sync_jobs.entity_key AND e.version>sync_jobs.entity_version)`).bind(now,job.entityKey,job.entityVersion).run();
    const state=await env.DB.prepare(`SELECT status FROM sync_jobs WHERE entity_type='EXPENSE_CATEGORY' AND entity_key=? AND entity_version=?`).bind(job.entityKey,job.entityVersion).first<{status:string}>();
    return state?.status==="COMPLETED"||!state?"IGNORED":"BUSY";
  }
  try{
    await runner(env,{expenseId:job.entityKey,version:job.entityVersion,leaseToken:token});
    const done=await env.DB.prepare(`UPDATE sync_jobs SET status='COMPLETED',updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=NULL
      WHERE entity_type='EXPENSE_CATEGORY' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?`)
      .bind(new Date().toISOString(),job.entityKey,job.entityVersion,token).run();
    return Number(done.meta.changes||0)===1?"PROCESSED":"BUSY";
  }catch(error){
    if(error instanceof SheetsMutationOutcomeUnknownError){
      // The row metadata write may still be in flight at Google. Retain its
      // fence until its long lease expires before any competing version runs.
      const held=await env.DB.prepare(`UPDATE sync_jobs SET last_error=?,updated_at=?,next_attempt_at=lease_until
        WHERE entity_type='EXPENSE_CATEGORY' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?`)
        .bind(`${ambiguityPrefix}${String(error)}`,new Date().toISOString(),job.entityKey,job.entityVersion,token).run();
      if(Number(held.meta.changes||0)!==1)throw new Error("CATEGORY_PROJECTION_AMBIGUITY_FENCE_LOST");
      return "BUSY";
    }
    const failure=error instanceof Error?error:new Error(String(error)),attemptRow=await env.DB.prepare(`SELECT attempt_count FROM sync_jobs WHERE entity_type='EXPENSE_CATEGORY' AND entity_key=? AND entity_version=? AND lease_token=?`).bind(job.entityKey,job.entityVersion,token).first<{attempt_count:number}>();
    const attempt=Math.max(retryAttempt,Number(attemptRow?.attempt_count||1)),delay=queueRetryDelaySeconds(failure,attempt,()=>0)||0;
    Object.defineProperty(failure,"retryAttempt",{value:attempt,configurable:true});
    await env.DB.prepare(`UPDATE sync_jobs SET status='FAILED',updated_at=?,next_attempt_at=?,lease_until=NULL,lease_token=NULL,last_error=?
      WHERE entity_type='EXPENSE_CATEGORY' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?`)
      .bind(new Date().toISOString(),new Date(Date.now()+delay*1000).toISOString(),String(failure),job.entityKey,job.entityVersion,token).run();
    throw failure;
  }
}
