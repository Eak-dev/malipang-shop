import type {Env} from "../types";
import type {SheetRowMetadata} from "./client";
import {claimOwnerCorrectionLease,type OwnerCorrectionJob} from "./owner-correction-lease";
import {advanceOwnerCorrectionSyncPhase,armOwnerCorrectionDispatch,finalizeOwnerCorrectionSync,type CorrectionReconciliationEvidence,type CorrectionSyncPhase} from "./owner-correction-sync-state";
import {recoverOwnerCorrectionRebind,recoverOwnerCorrectionValues} from "./owner-correction-recover-state";
import {classifyCorrectionPatchOutcome} from "./owner-correction-recovery";
import {classifyOwnerCorrectionRebind} from "./owner-correction-rebind";
import {serializeCorrectionSyncPlan,type CorrectionSyncPlan} from "./owner-correction-sync-plan";

export interface CorrectionInspection {identitiesVerified:boolean;rows:Map<number,unknown[]>}
export interface CorrectionRebindInspection {source:SheetRowMetadata|null;reservation:SheetRowMetadata|null;sourceRowIndex:number;destinationRowIndex:number;valuesVerified:boolean}
/** Ports must use live metadata and rows, not numeric row indexes as identity. */
export interface OwnerCorrectionWorkerPorts{
  now:()=>number;
  inspect:(plan:CorrectionSyncPlan)=>Promise<CorrectionInspection>;
  patch:(plan:CorrectionSyncPlan,beforeDispatch:()=>Promise<void>)=>Promise<void>;
  inspectRebind:(plan:CorrectionSyncPlan)=>Promise<CorrectionRebindInspection>;
  rebind:(plan:CorrectionSyncPlan,input:CorrectionRebindInspection,beforeDispatch:()=>Promise<void>)=>Promise<void>;
  reconcile:(plan:CorrectionSyncPlan,job:OwnerCorrectionJob)=>Promise<CorrectionReconciliationEvidence|null>;
}
export type OwnerCorrectionWorkerOutcome="COMPLETED"|"BUSY"|"REVIEW"|"IGNORED";

/** Internal orchestration; no production adapter is registered yet. */
export async function processOwnerCorrectionJob(env:Env,job:OwnerCorrectionJob,ports:OwnerCorrectionWorkerPorts):Promise<OwnerCorrectionWorkerOutcome>{
  let token=await claimOwnerCorrectionLease(env,job,ports.now());
  if(!token){const row=await env.DB.prepare(`SELECT status FROM sync_jobs WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=?`).bind(job.expenseId,job.version).first<{status:string}>();return row?.status==="COMPLETED"?"IGNORED":row?.status==="REVIEW"?"REVIEW":"BUSY";}
  let dispatched=false;
  try{
    for(let step=0;step<8;step++){
      const state=await env.DB.prepare(`SELECT s.correction_id,s.phase,s.plan_json FROM expense_owner_correction_sync s JOIN expense_owner_corrections c ON c.correction_id=s.correction_id
        WHERE s.expense_id=? AND s.expense_version=? AND c.status='APPLIED'`).bind(job.expenseId,job.version).first<{correction_id:string;phase:CorrectionSyncPhase;plan_json:string}>();
      if(!state)throw new Error("CORRECTION_SYNC_STATE_MISSING");
      let plan:CorrectionSyncPlan;try{plan=JSON.parse(state.plan_json) as CorrectionSyncPlan;}catch{throw new Error("CORRECTION_SYNC_PLAN_INVALID");}
      if(serializeCorrectionSyncPlan(plan,job.expenseId,state.correction_id)!==state.plan_json)throw new Error("CORRECTION_SYNC_PLAN_INVALID");
      const original=new Map(plan.originalRows.map(row=>[row.metadataId,row.values]));
      const inspect=async()=>{const result=await ports.inspect(plan);return result.identitiesVerified?classifyCorrectionPatchOutcome(plan.patches,original,result.rows):"CONFLICT";};
      const hold=async()=>{const result=await env.DB.prepare(`UPDATE sync_jobs SET status='REVIEW',updated_at=?,lease_token=NULL,lease_until=NULL,last_error='CORRECTION_REVIEW_REQUIRED' WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND EXISTS(SELECT 1 FROM expense_owner_correction_sync WHERE correction_id=? AND phase='REVIEW')`).bind(new Date(ports.now()).toISOString(),job.expenseId,job.version,token,state.correction_id).run();return Number(result.meta.changes||0)===1?"REVIEW" as const:"BUSY" as const;};
      const review=async(from:CorrectionSyncPhase)=>{if(!await advanceOwnerCorrectionSyncPhase(env,job,state.correction_id,token!,from,"REVIEW",ports.now()))return "BUSY" as const;return hold();};
      if(state.phase==="PREPARED"){
        if(await inspect()!=="BEFORE")return review("PREPARED");
        await ports.patch(plan,async()=>{const next=await armOwnerCorrectionDispatch(env,job,state.correction_id,token!,"VALUES",ports.now());if(!next)throw new Error("CORRECTION_LEASE_LOST");token=next;dispatched=true;});
        if(!dispatched)throw new Error("CORRECTION_DISPATCH_NOT_ARMED");
        if(await inspect()!=="AFTER")return review("VALUES_IN_FLIGHT");
        if(!await advanceOwnerCorrectionSyncPhase(env,job,state.correction_id,token!,"VALUES_IN_FLIGHT","VALUES_VERIFIED",ports.now()))return "BUSY";
        dispatched=false;continue;
      }
      if(state.phase==="VALUES_IN_FLIGHT"){
        const inspection=await ports.inspect(plan),result=await recoverOwnerCorrectionValues(env,job,state.correction_id,token,inspection.rows,inspection.identitiesVerified,ports.now());
        if(result==="WAIT")return "BUSY";if(result==="REVIEW")return hold();continue;
      }
      if(state.phase==="VALUES_VERIFIED"){
        if(!plan.rebind){if(!await advanceOwnerCorrectionSyncPhase(env,job,state.correction_id,token,"VALUES_VERIFIED","IDENTITY_VERIFIED",ports.now()))return "BUSY";continue;}
        const before=await ports.inspectRebind(plan),binding=plan.rebind;
        if(!before.valuesVerified||before.source?.metadataId!==binding.sourceMetadataId||before.reservation?.metadataId!==binding.reservationMetadataId||classifyOwnerCorrectionRebind({expenseId:job.expenseId,correctionId:state.correction_id,...before,sheetId:binding.sheetId})!=="BEFORE")return review("VALUES_VERIFIED");
        await ports.rebind(plan,before,async()=>{const next=await armOwnerCorrectionDispatch(env,job,state.correction_id,token!,"REBIND",ports.now());if(!next)throw new Error("CORRECTION_LEASE_LOST");token=next;dispatched=true;});
        if(!dispatched)throw new Error("CORRECTION_DISPATCH_NOT_ARMED");
        const after=await ports.inspectRebind(plan);
        if(!after.valuesVerified||after.source!==null||after.reservation?.metadataId!==binding.reservationMetadataId||classifyOwnerCorrectionRebind({expenseId:job.expenseId,correctionId:state.correction_id,...after,sheetId:binding.sheetId})!=="AFTER")return review("REBIND_IN_FLIGHT");
        if(!await advanceOwnerCorrectionSyncPhase(env,job,state.correction_id,token!,"REBIND_IN_FLIGHT","IDENTITY_VERIFIED",ports.now()))return "BUSY";
        dispatched=false;continue;
      }
      if(state.phase==="REBIND_IN_FLIGHT"){
        const observed=await ports.inspectRebind(plan),result=await recoverOwnerCorrectionRebind(env,job,state.correction_id,token,observed,ports.now());
        if(result==="WAIT")return "BUSY";if(result==="REVIEW")return hold();continue;
      }
      if(state.phase==="IDENTITY_VERIFIED"){
        const evidence=await ports.reconcile(plan,job);if(!evidence||evidence.expenseId!==job.expenseId||evidence.version!==job.version||!evidence.dailyMatches||!evidence.rawMatches||!evidence.detailsMatch||!evidence.reportsMatch||evidence.duplicateCount!==0||evidence.lostCount!==0)return review("IDENTITY_VERIFIED");
        return await finalizeOwnerCorrectionSync(env,job,state.correction_id,token,evidence,ports.now())?"COMPLETED":"BUSY";
      }
      if(state.phase==="REVIEW")return hold();
      if(state.phase==="RECONCILED")return "IGNORED";
      throw new Error("CORRECTION_SYNC_PHASE_INVALID");
    }
    return "BUSY";
  }catch(error){
    // Once the pre-dispatch callback armed a request, retain its lease and
    // persisted phase even when the response is missing or malformed.
    if(dispatched)return "BUSY";
    await env.DB.prepare(`UPDATE sync_jobs SET status='FAILED',updated_at=?,last_error=?,lease_until=NULL,lease_token=NULL WHERE entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?`)
      .bind(new Date(ports.now()).toISOString(),"CORRECTION_SYNC_NOT_DISPATCHED",job.expenseId,job.version,token).run();
    throw error;
  }
}
