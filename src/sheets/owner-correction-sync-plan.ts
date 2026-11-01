import {buildMetadataRowPatchRequest,type MetadataRowPatch} from "./client";

export interface CorrectionSyncOriginalRow{metadataId:number;values:unknown[]}
export interface CorrectionSyncRebind{sourceMetadataId:number;reservationMetadataId:number;sheetId:number;correctionId:string}
export interface CorrectionSyncPlan{expenseId:string;dailyMetadataId:number;rawMetadataId:number;patches:MetadataRowPatch[];originalRows:CorrectionSyncOriginalRow[];rebind:CorrectionSyncRebind|null}
const allowed=[1,2,3,4,5,6,7,10,11,12,13,14,15,16,21,22];
const dailyColumns=new Set([1,2,3,5,6,7,10,11,12,13,14,15,16,21,22]),rawColumns=new Set([1,2,3,4,5,6]),itemColumns=new Set([3,12,13,14]);

/** Internal structural checks only; the caller still verifies actual row identity. */
export function serializeCorrectionSyncPlan(plan:CorrectionSyncPlan,expenseId:string,correctionId:string):string|null{
  if(!plan||plan.expenseId!==expenseId||!correctionId||!Array.isArray(plan.patches)||!plan.patches.length||plan.patches.length>300||!Array.isArray(plan.originalRows)||plan.originalRows.length!==plan.patches.length)return null;
  try{buildMetadataRowPatchRequest(plan.patches,allowed);}catch{return null;}
  const patchIds=new Set(plan.patches.map(row=>row.metadataId)),originalIds=new Set<number>();
  if(!Number.isSafeInteger(plan.dailyMetadataId)||plan.dailyMetadataId<1||!Number.isSafeInteger(plan.rawMetadataId)||plan.rawMetadataId<1||plan.dailyMetadataId===plan.rawMetadataId||!patchIds.has(plan.dailyMetadataId)||!patchIds.has(plan.rawMetadataId))return null;
  for(const patch of plan.patches){const columns=patch.metadataId===plan.dailyMetadataId||patch.metadataId===plan.rebind?.reservationMetadataId?dailyColumns:patch.metadataId===plan.rawMetadataId?rawColumns:itemColumns;if(patch.cells.some(cell=>!columns.has(cell.columnIndex)))return null;}
  for(const row of plan.originalRows){
    if(!Number.isSafeInteger(row.metadataId)||row.metadataId<1||!patchIds.has(row.metadataId)||originalIds.has(row.metadataId)||!Array.isArray(row.values)||row.values.length>26)return null;
    originalIds.add(row.metadataId);
    if(row.values.some(value=>value!==null&&value!==undefined&&typeof value!=="string"&&typeof value!=="boolean"&&!(typeof value==="number"&&Number.isFinite(value))))return null;
  }
  if(plan.rebind){const r=plan.rebind;if(r.correctionId!==correctionId||!Number.isSafeInteger(r.sheetId)||r.sheetId<0||r.sourceMetadataId!==plan.dailyMetadataId||!patchIds.has(r.reservationMetadataId)||r.sourceMetadataId===r.reservationMetadataId||r.reservationMetadataId===plan.rawMetadataId)return null;}
  try{const serialized=JSON.stringify(plan);return serialized.length<=1_000_000?serialized:null;}catch{return null;}
}
