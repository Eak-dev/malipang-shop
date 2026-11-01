import type {Env} from "../types";
import {numberEnv} from "../shared/env";

const LEASE_MS=15*60_000;
export interface OwnerCorrectionJob{expenseId:string;version:number}

/** Claim only the durable job for the current confirmed version. */
export async function claimOwnerCorrectionLease(env:Env,job:OwnerCorrectionJob,nowMs=Date.now()):Promise<string|null>{
  if(!job.expenseId||!Number.isSafeInteger(job.version)||job.version<1||!Number.isFinite(nowMs))return null;
  const now=new Date(nowMs).toISOString(),until=new Date(nowMs+LEASE_MS).toISOString(),token=crypto.randomUUID();
  const result=await env.DB.prepare(`UPDATE sync_jobs SET status='PROCESSING',attempt_count=attempt_count+1,last_error=NULL,updated_at=?,next_attempt_at=NULL,lease_until=?,lease_token=?
    WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=?
      AND (((status='PENDING' OR status='FAILED') AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='PROCESSING' AND lease_until IS NOT NULL AND lease_until<=?))
      AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=sync_jobs.entity_key AND e.status='CONFIRMED' AND e.version=sync_jobs.entity_version)
      AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_key=sync_jobs.entity_key AND other.entity_type='EXPENSE' AND other.status<>'COMPLETED')
      AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_key=sync_jobs.entity_key AND other.entity_type='EXPENSE_CORRECTION' AND other.entity_version<>sync_jobs.entity_version AND other.status<>'COMPLETED')`)
    .bind(now,until,token,job.expenseId,job.version,now,now).run();
  return Number(result.meta.changes||0)===1?token:null;
}

/** Invoke after OAuth and immediately before crossing the Sheets boundary. */
export async function renewOwnerCorrectionLease(env:Env,job:OwnerCorrectionJob,token:string,nowMs=Date.now()):Promise<boolean>{
  if(!job.expenseId||!token||!Number.isSafeInteger(job.version)||job.version<1||!Number.isFinite(nowMs))return false;
  const timeout=Math.max(0,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000)),now=new Date(nowMs).toISOString(),until=new Date(nowMs+Math.max(LEASE_MS,timeout+240_000)).toISOString();
  const result=await env.DB.prepare(`UPDATE sync_jobs SET lease_until=?,updated_at=? WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>?
    AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=sync_jobs.entity_key AND e.status='CONFIRMED' AND e.version=sync_jobs.entity_version)
    AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_key=sync_jobs.entity_key AND other.entity_type='EXPENSE' AND other.status<>'COMPLETED')`)
    .bind(until,now,job.expenseId,job.version,token,now).run();
  return Number(result.meta.changes||0)===1;
}
