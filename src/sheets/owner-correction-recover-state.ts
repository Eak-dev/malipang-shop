import type {Env} from "../types";
import type {OwnerCorrectionJob} from "./owner-correction-lease";
import {classifyCorrectionPatchOutcome} from "./owner-correction-recovery";
import {serializeCorrectionSyncPlan,type CorrectionSyncPlan} from "./owner-correction-sync-plan";
import {classifyOwnerCorrectionRebind} from "./owner-correction-rebind";
import type {SheetRowMetadata} from "./client";

/**
 * Call only after re-reading every row by unique metadata and verifying its
 * role and identity. The old uncertain dispatch's deadline is durable; the
 * newly claimed lease cannot shorten it.
 */
export async function recoverOwnerCorrectionValues(env:Env,job:OwnerCorrectionJob,correctionId:string,token:string,observed:Map<number,unknown[]>,identitiesVerified:boolean,nowMs=Date.now()):Promise<"RETRY"|"ADVANCE"|"REVIEW"|"WAIT">{
  if(!Number.isFinite(nowMs)||!token||!correctionId||!job.expenseId||!Number.isSafeInteger(job.version)||job.version<1)return "REVIEW";
  const now=new Date(nowMs).toISOString();
  const row=await env.DB.prepare(`SELECT s.plan_json,s.not_before,s.dispatch_id FROM expense_owner_correction_sync s JOIN sync_jobs j ON j.entity_type='EXPENSE_CORRECTION' AND j.entity_key=s.expense_id AND j.entity_version=s.expense_version
    JOIN expense_events e ON e.expense_id=s.expense_id WHERE s.correction_id=? AND s.expense_id=? AND s.expense_version=? AND s.phase='VALUES_IN_FLIGHT'
      AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>? AND e.status='CONFIRMED' AND e.version=j.entity_version`)
    .bind(correctionId,job.expenseId,job.version,token,now).first<{plan_json:string;not_before:string|null;dispatch_id:string|null}>();
  if(!row||!row.not_before||!row.dispatch_id||!Number.isFinite(Date.parse(row.not_before)))return "REVIEW";
  if(now<row.not_before)return "WAIT";
  let plan:CorrectionSyncPlan;try{plan=JSON.parse(row.plan_json) as CorrectionSyncPlan;}catch{return "REVIEW";}
  if(serializeCorrectionSyncPlan(plan,job.expenseId,correctionId)!==row.plan_json)return "REVIEW";
  const original=new Map(plan.originalRows.map(item=>[item.metadataId,item.values])),outcome=identitiesVerified?classifyCorrectionPatchOutcome(plan.patches,original,observed):"CONFLICT";
  const phase=outcome==="BEFORE"?"PREPARED":outcome==="AFTER"?"VALUES_VERIFIED":"REVIEW",result=await env.DB.prepare(`UPDATE expense_owner_correction_sync SET phase=?,updated_at=?,last_error=? WHERE correction_id=? AND expense_id=? AND expense_version=? AND phase='VALUES_IN_FLIGHT' AND dispatch_id=? AND not_before=? AND plan_json=?
    AND EXISTS(SELECT 1 FROM sync_jobs j JOIN expense_events e ON e.expense_id=j.entity_key WHERE j.entity_type='EXPENSE_CORRECTION' AND j.entity_key=? AND j.entity_version=? AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>? AND e.status='CONFIRMED' AND e.version=j.entity_version)
    AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=? AND other.status<>'COMPLETED')`)
    .bind(phase,now,outcome==="CONFLICT"?"CORRECTION_VALUES_CONFLICT":null,correctionId,job.expenseId,job.version,row.dispatch_id,row.not_before,row.plan_json,job.expenseId,job.version,token,now,job.expenseId).run();
  if(Number(result.meta.changes||0)!==1)return "REVIEW";
  return outcome==="BEFORE"?"RETRY":outcome==="AFTER"?"ADVANCE":"REVIEW";
}

/** Recovery requires a fresh metadata lookup and an independently checked value placement. */
export async function recoverOwnerCorrectionRebind(env:Env,job:OwnerCorrectionJob,correctionId:string,token:string,input:{source:SheetRowMetadata|null;reservation:SheetRowMetadata|null;sourceRowIndex:number;destinationRowIndex:number;valuesVerified:boolean},nowMs=Date.now()):Promise<"RETRY"|"ADVANCE"|"REVIEW"|"WAIT">{
  if(!Number.isFinite(nowMs)||!token||!correctionId||!job.expenseId||!Number.isSafeInteger(job.version)||job.version<1)return "REVIEW";
  const now=new Date(nowMs).toISOString(),row=await env.DB.prepare(`SELECT s.plan_json,s.not_before,s.dispatch_id FROM expense_owner_correction_sync s JOIN sync_jobs j ON j.entity_type='EXPENSE_CORRECTION' AND j.entity_key=s.expense_id AND j.entity_version=s.expense_version
    JOIN expense_events e ON e.expense_id=s.expense_id WHERE s.correction_id=? AND s.expense_id=? AND s.expense_version=? AND s.phase='REBIND_IN_FLIGHT'
      AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>? AND e.status='CONFIRMED' AND e.version=j.entity_version`)
    .bind(correctionId,job.expenseId,job.version,token,now).first<{plan_json:string;not_before:string|null;dispatch_id:string|null}>();
  if(!row||!row.not_before||!row.dispatch_id||!Number.isFinite(Date.parse(row.not_before)))return "REVIEW";
  if(now<row.not_before)return "WAIT";
  let plan:CorrectionSyncPlan;try{plan=JSON.parse(row.plan_json) as CorrectionSyncPlan;}catch{return "REVIEW";}
  if(serializeCorrectionSyncPlan(plan,job.expenseId,correctionId)!==row.plan_json||!plan.rebind)return "REVIEW";
  const binding=plan.rebind,idsMatch=(!input.source||input.source.metadataId===binding.sourceMetadataId)&&(!input.reservation||input.reservation.metadataId===binding.reservationMetadataId);
  const outcome=input.valuesVerified&&idsMatch?classifyOwnerCorrectionRebind({expenseId:job.expenseId,correctionId,source:input.source,reservation:input.reservation,sourceRowIndex:input.sourceRowIndex,destinationRowIndex:input.destinationRowIndex,sheetId:binding.sheetId}):"CONFLICT";
  const phase=outcome==="BEFORE"?"VALUES_VERIFIED":outcome==="AFTER"?"IDENTITY_VERIFIED":"REVIEW";
  const result=await env.DB.prepare(`UPDATE expense_owner_correction_sync SET phase=?,updated_at=?,last_error=? WHERE correction_id=? AND expense_id=? AND expense_version=? AND phase='REBIND_IN_FLIGHT' AND dispatch_id=? AND not_before=? AND plan_json=?
    AND EXISTS(SELECT 1 FROM sync_jobs j JOIN expense_events e ON e.expense_id=j.entity_key WHERE j.entity_type='EXPENSE_CORRECTION' AND j.entity_key=? AND j.entity_version=? AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>? AND e.status='CONFIRMED' AND e.version=j.entity_version)
    AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=? AND other.status<>'COMPLETED')`)
    .bind(phase,now,outcome==="CONFLICT"?"CORRECTION_REBIND_CONFLICT":null,correctionId,job.expenseId,job.version,row.dispatch_id,row.not_before,row.plan_json,job.expenseId,job.version,token,now,job.expenseId).run();
  if(Number(result.meta.changes||0)!==1)return "REVIEW";
  return outcome==="BEFORE"?"RETRY":outcome==="AFTER"?"ADVANCE":"REVIEW";
}
