import type {Env} from "../types";
import type {OwnerCorrectionJob} from "./owner-correction-lease";
import {numberEnv} from "../shared/env";

export type CorrectionSyncPhase="PREPARED"|"VALUES_IN_FLIGHT"|"VALUES_VERIFIED"|"REBIND_IN_FLIGHT"|"IDENTITY_VERIFIED"|"RECONCILED"|"REVIEW";
const transitions:Record<string,string[]>={PREPARED:["REVIEW"],VALUES_IN_FLIGHT:["VALUES_VERIFIED","REVIEW"],VALUES_VERIFIED:["IDENTITY_VERIFIED","REVIEW"],REBIND_IN_FLIGHT:["IDENTITY_VERIFIED","REVIEW"],IDENTITY_VERIFIED:["REVIEW"]};

/**
 * Atomically record a pending external dispatch and rotate the lease token.
 * The caller must invoke this only after obtaining auth, immediately before
 * dispatch; no external mutation may be attempted if it returns null.
 */
export async function armOwnerCorrectionDispatch(env:Env,job:OwnerCorrectionJob,correctionId:string,token:string,kind:"VALUES"|"REBIND",nowMs=Date.now()):Promise<string|null>{
  if(!job.expenseId||!correctionId||!token||!Number.isSafeInteger(job.version)||job.version<1||!Number.isFinite(nowMs)||(kind!=="VALUES"&&kind!=="REBIND"))return null;
  const from=kind==="VALUES"?"PREPARED":"VALUES_VERIFIED",to=kind==="VALUES"?"VALUES_IN_FLIGHT":"REBIND_IN_FLIGHT",newToken=crypto.randomUUID(),dispatchId=crypto.randomUUID();
  const now=new Date(nowMs).toISOString(),timeout=Math.max(0,numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000)),until=new Date(nowMs+Math.max(15*60_000,timeout+240_000)).toISOString();
  const shape=kind==="REBIND"?`AND json_type(s.plan_json,'$.rebind')='object'`:"";
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE sync_jobs SET lease_token=?,lease_until=?,updated_at=? WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>?
      AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=sync_jobs.entity_key AND e.status='CONFIRMED' AND e.version=sync_jobs.entity_version)
      AND EXISTS(SELECT 1 FROM expense_owner_correction_sync s WHERE s.correction_id=? AND s.expense_id=sync_jobs.entity_key AND s.expense_version=sync_jobs.entity_version AND s.phase=? ${shape})
      AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=sync_jobs.entity_key AND other.status<>'COMPLETED')`)
      .bind(newToken,until,now,job.expenseId,job.version,token,now,correctionId,from),
    env.DB.prepare(`UPDATE expense_owner_correction_sync SET phase=?,dispatch_id=?,dispatch_token=?,not_before=?,updated_at=? WHERE correction_id=? AND expense_id=? AND expense_version=? AND phase=?
      AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE_CORRECTION' AND j.entity_key=? AND j.entity_version=? AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until=?)`)
      .bind(to,dispatchId,newToken,until,now,correctionId,job.expenseId,job.version,from,job.expenseId,job.version,newToken,until),
    env.DB.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?) OR EXISTS(
      SELECT 1 FROM expense_owner_correction_sync WHERE correction_id=? AND expense_id=? AND expense_version=? AND phase=? AND dispatch_id=? AND dispatch_token=? AND not_before=?
    ) THEN 1 ELSE json('invalid correction dispatch') END AS verified`)
      .bind(job.expenseId,job.version,newToken,correctionId,job.expenseId,job.version,to,dispatchId,newToken,until)
  ]);
  if(Number(result[0]?.meta.changes||0)!==1)return null;
  if(Number(result[1]?.meta.changes||0)!==1)throw new Error("CORRECTION_DISPATCH_PHASE_INCOMPLETE");
  return newToken;
}

/**
 * Lease- and version-fenced phase CAS. Callers must independently verify the
 * external evidence for any *_VERIFIED phase. Reconciliation is deliberately
 * not implemented by this primitive.
 */
export async function advanceOwnerCorrectionSyncPhase(env:Env,job:OwnerCorrectionJob,correctionId:string,token:string,from:CorrectionSyncPhase,to:CorrectionSyncPhase,nowMs=Date.now()):Promise<boolean>{
  if(!job.expenseId||!correctionId||!token||!Number.isSafeInteger(job.version)||job.version<1||!Number.isFinite(nowMs)||!transitions[from]?.includes(to))return false;
  const now=new Date(nowMs).toISOString();
  const shapeGuard=from==="VALUES_VERIFIED"&&to==="IDENTITY_VERIFIED"?`AND json_type(plan_json,'$.rebind')='null'`:"";
  const dispatchGuard=from==="VALUES_IN_FLIGHT"||from==="REBIND_IN_FLIGHT"?`AND dispatch_token=?`:"";
  const result=await env.DB.prepare(`UPDATE expense_owner_correction_sync SET phase=?,updated_at=? WHERE correction_id=? AND expense_id=? AND expense_version=? AND phase=? ${shapeGuard} ${dispatchGuard}
    AND EXISTS(SELECT 1 FROM sync_jobs j JOIN expense_events e ON e.expense_id=j.entity_key
      WHERE j.entity_type='EXPENSE_CORRECTION' AND j.entity_key=? AND j.entity_version=? AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>?
        AND e.status='CONFIRMED' AND e.version=j.entity_version)
    AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=? AND other.status<>'COMPLETED')`)
    .bind(to,now,correctionId,job.expenseId,job.version,from,...(dispatchGuard?[token]:[]),job.expenseId,job.version,token,now,job.expenseId).run();
  return Number(result.meta.changes||0)===1;
}

export interface CorrectionReconciliationEvidence{expenseId:string;version:number;dailyMatches:boolean;rawMatches:boolean;detailsMatch:boolean;reportsMatch:boolean;duplicateCount:number;lostCount:number}
/** Internal finalizer; caller must gather fresh independently verified evidence. */
export async function finalizeOwnerCorrectionSync(env:Env,job:OwnerCorrectionJob,correctionId:string,token:string,evidence:CorrectionReconciliationEvidence,nowMs=Date.now()):Promise<boolean>{
  if(!job.expenseId||!correctionId||!token||!Number.isSafeInteger(job.version)||job.version<1||!Number.isFinite(nowMs)||evidence.expenseId!==job.expenseId||evidence.version!==job.version||evidence.dailyMatches!==true||evidence.rawMatches!==true||evidence.detailsMatch!==true||evidence.reportsMatch!==true||evidence.duplicateCount!==0||evidence.lostCount!==0)return false;
  const now=new Date(nowMs).toISOString(),reconciliationId=crypto.randomUUID(),details=JSON.stringify(evidence);
  const result=await env.DB.batch([
    env.DB.prepare(`UPDATE expense_owner_correction_sync SET phase='RECONCILED',reconciliation_id=?,reconciliation_json=?,updated_at=? WHERE correction_id=? AND expense_id=? AND expense_version=? AND phase='IDENTITY_VERIFIED'
      AND EXISTS(SELECT 1 FROM sync_jobs j JOIN expense_events e ON e.expense_id=j.entity_key WHERE j.entity_type='EXPENSE_CORRECTION' AND j.entity_key=? AND j.entity_version=? AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>? AND e.status='CONFIRMED' AND e.version=j.entity_version)
      AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=? AND other.status<>'COMPLETED')`)
      .bind(reconciliationId,details,now,correctionId,job.expenseId,job.version,job.expenseId,job.version,token,now,job.expenseId),
    env.DB.prepare(`UPDATE expense_owner_corrections SET reconciled_at=? WHERE correction_id=? AND expense_id=? AND status='APPLIED' AND EXISTS(SELECT 1 FROM expense_owner_correction_sync WHERE correction_id=? AND phase='RECONCILED' AND reconciliation_id=?)`)
      .bind(now,correctionId,job.expenseId,correctionId,reconciliationId),
    env.DB.prepare(`UPDATE sync_jobs SET status='COMPLETED',updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=NULL WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>?
      AND EXISTS(SELECT 1 FROM expense_owner_correction_sync WHERE correction_id=? AND phase='RECONCILED' AND reconciliation_id=?)`)
      .bind(now,job.expenseId,job.version,token,now,correctionId,reconciliationId),
    env.DB.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM expense_owner_correction_sync WHERE correction_id=? AND reconciliation_id=?) OR (
      EXISTS(SELECT 1 FROM expense_owner_corrections WHERE correction_id=? AND expense_id=? AND status='APPLIED' AND reconciled_at=?) AND
      EXISTS(SELECT 1 FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=? AND status='COMPLETED')
    ) THEN 1 ELSE json('invalid correction reconciliation') END AS verified`)
      .bind(correctionId,reconciliationId,correctionId,job.expenseId,now,job.expenseId,job.version)
  ]);
  if(Number(result[0]?.meta.changes||0)!==1)return false;
  if(result.slice(0,3).some(item=>Number(item.meta.changes||0)!==1))throw new Error("CORRECTION_RECONCILIATION_INCOMPLETE");
  return true;
}
