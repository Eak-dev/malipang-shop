import type {Env} from "../types";
import {activeOwnerSql,type OwnerReviewIdentity} from "../expense/online-order-review-repository";
import {loadOwnerCorrectionDraft,loadOwnerExpense} from "../expense/owner-correction-repository";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {correctionAccountingPeriods,correctionPeriodHeaderDigest} from "../expense/owner-correction-period-math";
import {findOwnerCorrectionMoveCandidates,type MoveFormulaTemplate} from "./owner-correction-move-candidates";
import type {SheetRowMetadata} from "./client";

/** Caller must prove coverage and freshness; this port does not make that proof. */
export interface MoveMarkerObservation {
  coverage:"VERIFIED_SHEET_ID_AND_ALL_SHEET_ROW_METADATA_AND_INDEX";
  sheetId:number;
  values:unknown[][];formulas:unknown[][];metadata:SheetRowMetadata[];
  mappings:Array<{entityKey:string;rowNumber:number}>;
  sourceById:SheetRowMetadata|null;markerById:SheetRowMetadata|null;
  template:MoveFormulaTemplate;
}
export type MoveMarkerInspection={kind:"REVIEW"}|{kind:"VERIFIED";sheetId:number;sourceMetadataId:number;destinationMetadataId:number;destinationRow:number};
interface StoredReservation{expense_id:string;owner_employee_id:string;sheet_name:string;row_number:number;mapping_key:string;metadata_id:number;header_digest:string;state:string;creation_nonce:string}

/**
 * Read-only integration prerequisite, not a lease or permission to mutate.
 * No attempt is made to create, remove, promote, or infer a missing marker:
 * migration 0028 does not persist a dispatch ID or uncertainty deadline.
 */
export async function inspectReservedMoveMarker(env:Env,owner:OwnerReviewIdentity,correctionId:string,sourceMetadataId:number,fenceToken:string,observe:()=>Promise<MoveMarkerObservation|null>,clock:()=>number=()=>Date.now(),allowExpiredForInspection=false):Promise<MoveMarkerInspection>{
  const nowMs=clock();
  if(env.OWNER_EXPENSE_CORRECTION_ENABLED!=="true"||!env.SHEET_EXPENSE_DAILY||!owner.employeeId||!owner.lineUserId||!correctionId||!Number.isSafeInteger(sourceMetadataId)||sourceMetadataId<1||!fenceToken||!Number.isFinite(nowMs))return {kind:"REVIEW"};
  try{
    const read=async()=>{
      const currentTime=clock();if(!Number.isFinite(currentTime))return null;
      const [draft,reservation,observation]=await Promise.all([
        allowExpiredForInspection?env.DB.prepare(`SELECT c.* FROM expense_owner_corrections c WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND NOT EXISTS(SELECT 1 FROM expense_owner_correction_manual_reviews r WHERE r.correction_id=c.correction_id AND r.status='OPEN') AND ${activeOwnerSql}`).bind(correctionId,owner.employeeId,owner.employeeId,owner.lineUserId).first<Record<string,unknown>>():loadOwnerCorrectionDraft(env,owner,correctionId,currentTime),
        env.DB.prepare(`SELECT r.* FROM expense_owner_correction_move_reservations r WHERE r.correction_id=? AND r.owner_employee_id=? AND r.sheet_name=? AND r.state IN ('PREPARED','ACTIVE')
          AND EXISTS(SELECT 1 FROM owner_correction_daily_write_fences f WHERE f.sheet_name=r.sheet_name AND f.lease_token=? AND f.state='OWNED' AND f.lease_until>?)
          AND EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.sheet_name=r.sheet_name AND i.entity_key=r.mapping_key AND i.row_number=r.row_number)`)
          .bind(correctionId,owner.employeeId,env.SHEET_EXPENSE_DAILY,fenceToken,new Date(currentTime).toISOString()).first<StoredReservation>(),observe()
      ]);
      if(!draft||!reservation||!observation)return null;
      const [count,mappingResult]=await Promise.all([
        env.DB.prepare(`SELECT COUNT(*) AS n FROM sheet_row_index WHERE sheet_name=?`).bind(env.SHEET_EXPENSE_DAILY).first<{n:number}>(),
        env.DB.prepare(`SELECT entity_key,row_number FROM sheet_row_index WHERE sheet_name=? ORDER BY entity_key`).bind(env.SHEET_EXPENSE_DAILY).all<{entity_key:string;row_number:number}>()
      ]);
      if(!count||!Number.isSafeInteger(count.n)||mappingResult.success===false||!Array.isArray(mappingResult.results)||count.n!==mappingResult.results.length||!Array.isArray(observation.mappings))return null;
      const mappings=mappingResult.results.map(row=>({entityKey:row.entity_key,rowNumber:row.row_number})).sort((a,b)=>a.entityKey.localeCompare(b.entityKey)),observedMappings=[...observation.mappings].sort((a,b)=>a.entityKey.localeCompare(b.entityKey));
      if(JSON.stringify(mappings)!==JSON.stringify(observedMappings))return null;
      const before=JSON.parse(String(draft.before_json)) as OwnerCorrectionSnapshot,after=JSON.parse(String(draft.after_json)) as OwnerCorrectionSnapshot;
      const current=await loadOwnerExpense(env,owner,reservation.expense_id);
      if(!before||!after||JSON.stringify(current)!==JSON.stringify(before)||before.expenseId!==reservation.expense_id||draft.owner_employee_id!==owner.employeeId)return null;
      const headers=observation.values?.slice(0,3);if(!headers||await correctionPeriodHeaderDigest(headers)!==reservation.header_digest)return null;
      const periods=correctionAccountingPeriods(before,after,headers);
      for(const period of periods){const ok=await env.DB.prepare(`SELECT 1 AS valid WHERE EXISTS(SELECT 1 FROM expense_owner_correction_period_decisions WHERE correction_id=? AND period=? AND decision='OPEN' AND header_digest=? AND actor_employee_id=?) AND NOT EXISTS(SELECT 1 FROM expense_owner_correction_period_decisions WHERE correction_id=? AND period=? AND decision='HOLD' AND header_digest=?)`).bind(correctionId,period,reservation.header_digest,owner.employeeId,correctionId,period,reservation.header_digest).first<{valid:number}>();if(!ok)return null;}
      return {reservation,before,after,observation};
    };
    const first=await read(),second=await read();if(!first||!second||JSON.stringify(first)!==JSON.stringify(second))return {kind:"REVIEW"};
    const {reservation:r,before,after,observation:o}=first;
    if(o.coverage!=="VERIFIED_SHEET_ID_AND_ALL_SHEET_ROW_METADATA_AND_INDEX"||!Array.isArray(o.metadata)||!Array.isArray(o.mappings)||!o.sourceById||!o.markerById||r.mapping_key!==`__owner_move__:${correctionId}`||r.metadata_id===sourceMetadataId||r.row_number<1)return {kind:"REVIEW"};
    const sources=o.metadata.filter(m=>m.metadataId===sourceMetadataId),markers=o.metadata.filter(m=>m.metadataId===r.metadata_id);
    if(sources.length!==1||markers.length!==1||JSON.stringify(sources[0])!==JSON.stringify(o.sourceById)||JSON.stringify(markers[0])!==JSON.stringify(o.markerById))return {kind:"REVIEW"};
    const source=sources[0]!,marker=markers[0]!;
    if(source.metadataKey!=="malipang_expense_daily"||source.metadataValue!==before.expenseId||source.sheetId!==o.sheetId||marker.metadataKey!=="malipang_correction_reservation"||marker.metadataValue!==correctionId||marker.sheetId!==o.sheetId||marker.rowIndex+1!==r.row_number||o.metadata.filter(m=>m.metadataKey==="malipang_correction_reservation"&&m.metadataValue===correctionId).length!==1)return {kind:"REVIEW"};
    const own=o.mappings.filter(m=>m.entityKey===r.mapping_key),sourceMappings=o.mappings.filter(m=>m.entityKey===before.expenseId);
    if(own.length!==1||own[0]!.rowNumber!==r.row_number||sourceMappings.length!==1||sourceMappings[0]!.rowNumber!==source.rowIndex+1)return {kind:"REVIEW"};
    const candidates=findOwnerCorrectionMoveCandidates({before,after,sheetId:o.sheetId,sourceMetadataId,values:o.values,formulas:o.formulas,metadata:o.metadata.filter(m=>m.metadataId!==r.metadata_id),mappedRows:o.mappings.filter(m=>m.entityKey!==r.mapping_key).map(m=>m.rowNumber),template:o.template});
    if(!candidates.some(candidate=>candidate.destinationRow===r.row_number))return {kind:"REVIEW"};
    const finalTime=clock();if(!Number.isFinite(finalTime))return {kind:"REVIEW"};
    const finalFence=await env.DB.prepare(`SELECT 1 AS valid FROM owner_correction_daily_write_fences WHERE sheet_name=? AND lease_token=? AND state='OWNED' AND lease_until>?`).bind(env.SHEET_EXPENSE_DAILY,fenceToken,new Date(finalTime).toISOString()).first<{valid:number}>();
    return finalFence?{kind:"VERIFIED",sheetId:o.sheetId,sourceMetadataId,destinationMetadataId:r.metadata_id,destinationRow:r.row_number}:{kind:"REVIEW"};
  }catch{return {kind:"REVIEW"};}
}
