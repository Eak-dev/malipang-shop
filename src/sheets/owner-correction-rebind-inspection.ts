import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {getSheetRowMetadataById,type SheetRowMetadata} from "./client";
import {inspectOwnerCorrectionTargets} from "./owner-correction-inspection";
import {inspectOwnerCorrectionPlacement} from "./owner-correction-placement-service";
import {classifyCorrectionPatchOutcome} from "./owner-correction-recovery";
import {classifyOwnerCorrectionRebind} from "./owner-correction-rebind";
import type {CorrectionSyncPlan} from "./owner-correction-sync-plan";
import type {CorrectionInspection,CorrectionRebindInspection} from "./owner-correction-worker";

interface SavedCorrection {before:OwnerCorrectionSnapshot;after:OwnerCorrectionSnapshot;version:number}
export interface RebindInspectionPorts {
  metadataById:(env:Env,id:number)=>Promise<SheetRowMetadata|null>;
  targets:(env:Env,plan:CorrectionSyncPlan)=>Promise<CorrectionInspection>;
  placement:typeof inspectOwnerCorrectionPlacement;
  saved:(env:Env,plan:CorrectionSyncPlan)=>Promise<SavedCorrection|null>;
}
async function saved(env:Env,plan:CorrectionSyncPlan):Promise<SavedCorrection|null>{
  const row=await env.DB.prepare(`SELECT c.before_json,c.after_json,s.expense_version FROM expense_owner_corrections c JOIN expense_owner_correction_sync s ON s.correction_id=c.correction_id WHERE c.correction_id=? AND c.expense_id=? AND s.expense_id=? AND c.status='APPLIED'`).bind(plan.rebind?.correctionId,plan.expenseId,plan.expenseId).first<{before_json:string;after_json:string;expense_version:number}>();
  if(!row)return null;
  try{const before=JSON.parse(row.before_json) as OwnerCorrectionSnapshot,after=JSON.parse(row.after_json) as OwnerCorrectionSnapshot,version=Number(row.expense_version);return before?.expenseId===plan.expenseId&&after?.expenseId===plan.expenseId&&Number.isSafeInteger(version)&&version>0?{before,after,version}:null;}catch{return null;}
}
const defaults:RebindInspectionPorts={metadataById:getSheetRowMetadataById,targets:inspectOwnerCorrectionTargets,placement:inspectOwnerCorrectionPlacement,saved};

/** Verify both metadata identities and actual values before or after a move. */
export async function inspectOwnerCorrectionRebind(env:Env,plan:CorrectionSyncPlan,ports:RebindInspectionPorts=defaults):Promise<CorrectionRebindInspection>{
  const binding=plan.rebind;if(!binding)throw new Error("CORRECTION_REBIND_MISSING");
  const [source,reservation]=await Promise.all([ports.metadataById(env,binding.sourceMetadataId),ports.metadataById(env,binding.reservationMetadataId)]);
  const result:CorrectionRebindInspection={source,reservation,sourceRowIndex:source?.rowIndex??-1,destinationRowIndex:reservation?.rowIndex??-1,valuesVerified:false};
  const state=classifyOwnerCorrectionRebind({expenseId:plan.expenseId,correctionId:binding.correctionId,sheetId:binding.sheetId,...result});
  if(state==="CONFLICT"||source&&source.metadataId!==binding.sourceMetadataId||reservation?.metadataId!==binding.reservationMetadataId)return result;
  let checkedPlan=plan;
  if(state==="AFTER"){
    const record=await ports.saved(env,plan);if(!record)return result;
    if(!await ports.placement(env,{before:record.before,after:record.after,sourceMetadataId:binding.sourceMetadataId,destinationMetadataId:binding.reservationMetadataId,committedVersion:record.version}))return result;
    checkedPlan={...plan,dailyMetadataId:binding.reservationMetadataId,rebind:null,patches:plan.patches.filter(row=>row.metadataId!==binding.sourceMetadataId),originalRows:plan.originalRows.filter(row=>row.metadataId!==binding.sourceMetadataId)};
  }
  const inspection=await ports.targets(env,checkedPlan);
  result.valuesVerified=inspection.identitiesVerified&&classifyCorrectionPatchOutcome(checkedPlan.patches,new Map(checkedPlan.originalRows.map(row=>[row.metadataId,row.values])),inspection.rows)==="AFTER";
  return result;
}
