import type {Env} from "../types";
import {batchPatchMetadataRows,batchUpdateSpreadsheet,type MetadataRowPatch} from "./client";
import {buildOwnerCorrectionRebind} from "./owner-correction-rebind";
import type {CorrectionSyncPlan} from "./owner-correction-sync-plan";
import type {CorrectionRebindInspection} from "./owner-correction-worker";

export interface CorrectionGooglePorts{
  patch:(env:Env,patches:MetadataRowPatch[],allowedColumns:number[],beforeDispatch:()=>Promise<void>)=>Promise<void>;
  batch:(env:Env,requests:unknown[],beforeDispatch:()=>Promise<void>)=>Promise<void>;
}
const defaults:CorrectionGooglePorts={patch:batchPatchMetadataRows,batch:batchUpdateSpreadsheet};
const allowed=[1,2,3,4,5,6,7,10,11,12,13,14,15,16,21,22];

/** The caller must independently inspect all identities before this call. */
export async function patchOwnerCorrectionGoogle(env:Env,plan:CorrectionSyncPlan,beforeDispatch:()=>Promise<void>,ports:CorrectionGooglePorts=defaults):Promise<void>{
  if(!plan.patches.length||typeof beforeDispatch!=="function")throw new Error("CORRECTION_GOOGLE_PATCH_INVALID");
  await ports.patch(env,plan.patches,allowed,beforeDispatch);
}

/** Rebind only the exact reserved metadata IDs, after verified value placement. */
export async function rebindOwnerCorrectionGoogle(env:Env,plan:CorrectionSyncPlan,inspection:CorrectionRebindInspection,beforeDispatch:()=>Promise<void>,ports:CorrectionGooglePorts=defaults):Promise<void>{
  const binding=plan.rebind,{source,reservation}=inspection;
  if(!binding||!inspection.valuesVerified||!source||!reservation||source.metadataId!==binding.sourceMetadataId||reservation.metadataId!==binding.reservationMetadataId||source.sheetId!==binding.sheetId||reservation.sheetId!==binding.sheetId||typeof beforeDispatch!=="function")throw new Error("CORRECTION_GOOGLE_REBIND_INVALID");
  const requests=buildOwnerCorrectionRebind({expenseId:plan.expenseId,correctionId:binding.correctionId,source,reservation});
  await ports.batch(env,requests,beforeDispatch);
}
