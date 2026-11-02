import type {Env} from "../types";
import type {OwnerReviewIdentity} from "../expense/online-order-review-repository";
import {activeOwnerSql} from "../expense/online-order-review-repository";
import {loadOwnerCorrectionDraft} from "../expense/owner-correction-repository";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {correctionAccountingPeriods,correctionPeriodHeaderDigest} from "../expense/owner-correction-period-math";
import {numberEnv} from "../shared/env";
import {createSheetRowMetadata,type NewSheetRowMetadata,type SheetRowMetadata} from "./client";
import {inspectReservedMoveMarker,type MoveMarkerObservation} from "./owner-correction-move-marker-recovery";

export interface MarkerDispatchTarget{sheetId:number;rowNumber:number;metadataId:number;headers:unknown[][];fenceToken:string}
/**
 * Trusted port must prove complete fresh source/destination identity, blank
 * inputs and formulas, no existing marker, and exclusive structural/cell
 * protection through dispatch. No production implementation exists yet.
 */
export interface MarkerDispatchPorts{
  verify:()=>Promise<boolean>;
  create:(env:Env,rows:NewSheetRowMetadata[],beforeDispatch:()=>Promise<void>)=>Promise<SheetRowMetadata[]>;
  now:()=>number;
}

/**
 * Unregistered integration primitive. It arms D1 and the shared fence in one
 * transaction after OAuth and immediately before the provider request. Both
 * success and lost responses remain pending until independently reconciled.
 */
export async function dispatchReservedMoveMarker(env:Env,owner:OwnerReviewIdentity,correctionId:string,target:MarkerDispatchTarget,ports:MarkerDispatchPorts):Promise<"PENDING"|"REVIEW">{
  if(env.OWNER_EXPENSE_CORRECTION_ENABLED!=="true"||!env.SHEET_EXPENSE_DAILY||!owner.employeeId||!owner.lineUserId||!correctionId||!target||!Number.isSafeInteger(target.sheetId)||target.sheetId<0||!Number.isSafeInteger(target.rowNumber)||target.rowNumber<1||!Number.isSafeInteger(target.metadataId)||target.metadataId<1||target.metadataId>2147483647||!target.fenceToken||!ports||typeof ports.verify!=="function"||typeof ports.create!=="function"||typeof ports.now!=="function")return "REVIEW";
  let dispatched=false;
  try{
    if(!await ports.verify())return "REVIEW";
    await ports.create(env,[{metadataId:target.metadataId,metadataKey:"malipang_correction_reservation",metadataValue:correctionId,sheetId:target.sheetId,rowIndex:target.rowNumber-1}],async()=>{
      // verify runs after provider authentication; no request is sent if it fails.
      if(!await ports.verify())throw new Error("MARKER_PREFLIGHT_FAILED");
      const nowMs=ports.now(),timeout=numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000);if(!Number.isFinite(nowMs)||!Number.isFinite(timeout)||timeout<0)throw new Error("MARKER_TIME_INVALID");
      const now=new Date(nowMs).toISOString(),until=new Date(nowMs+Math.max(15*60_000,timeout+240_000)).toISOString(),draft=await loadOwnerCorrectionDraft(env,owner,correctionId,nowMs);
      if(!draft)throw new Error("MARKER_DRAFT_STALE");
      const before=JSON.parse(String(draft.before_json)) as OwnerCorrectionSnapshot,after=JSON.parse(String(draft.after_json)) as OwnerCorrectionSnapshot,periods=correctionAccountingPeriods(before,after,target.headers),digest=await correctionPeriodHeaderDigest(target.headers),dispatchId=crypto.randomUUID();
      const result=await env.DB.batch([
        env.DB.prepare(`INSERT OR IGNORE INTO expense_owner_correction_move_marker_dispatch(correction_id,dispatch_id,sheet_name,sheet_id,row_number,metadata_id,fence_token,not_before,state,created_at)
          SELECT r.correction_id,?,?,?,?,?,?,?,'IN_FLIGHT',? FROM expense_owner_correction_move_reservations r JOIN expense_owner_corrections c ON c.correction_id=r.correction_id JOIN expense_events e ON e.expense_id=r.expense_id
          WHERE r.correction_id=? AND r.state='PREPARED' AND r.owner_employee_id=? AND r.sheet_name=? AND r.row_number=? AND r.metadata_id=? AND r.header_digest=? AND r.mapping_key=? AND r.expense_id=?
            AND c.status='DRAFT' AND c.owner_employee_id=? AND c.expires_at>? AND c.before_json=? AND c.after_json=?
            AND e.status='CONFIRMED' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}
            AND EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.sheet_name=r.sheet_name AND i.entity_key=r.mapping_key AND i.row_number=r.row_number)
            AND EXISTS(SELECT 1 FROM owner_correction_daily_write_fences f WHERE f.sheet_name=r.sheet_name AND f.lease_token=? AND f.state='OWNED' AND f.lease_until>?)
            AND NOT EXISTS(SELECT 1 FROM expense_owner_correction_manual_reviews m WHERE m.correction_id=c.correction_id AND m.status='OPEN')
            AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED')
            AND NOT EXISTS(SELECT 1 FROM json_each(?) wanted WHERE NOT EXISTS(SELECT 1 FROM expense_owner_correction_period_decisions p WHERE p.correction_id=c.correction_id AND p.period=wanted.value AND p.header_digest=? AND p.decision='OPEN' AND p.actor_employee_id=c.owner_employee_id) OR EXISTS(SELECT 1 FROM expense_owner_correction_period_decisions p WHERE p.correction_id=c.correction_id AND p.period=wanted.value AND p.header_digest=? AND p.decision='HOLD'))`)
          .bind(dispatchId,env.SHEET_EXPENSE_DAILY,target.sheetId,target.rowNumber,target.metadataId,target.fenceToken,until,now,correctionId,owner.employeeId,env.SHEET_EXPENSE_DAILY,target.rowNumber,target.metadataId,digest,`__owner_move__:${correctionId}`,before.expenseId,owner.employeeId,now,String(draft.before_json),String(draft.after_json),before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId,target.fenceToken,now,JSON.stringify(periods),digest,digest),
        env.DB.prepare(`UPDATE owner_correction_daily_write_fences SET state='IN_FLIGHT',dispatch_id=?,not_before=?,lease_until=?,updated_at=? WHERE sheet_name=? AND lease_token=? AND state='OWNED' AND lease_until>? AND EXISTS(SELECT 1 FROM expense_owner_correction_move_marker_dispatch WHERE correction_id=? AND dispatch_id=? AND state='IN_FLIGHT')`)
          .bind(dispatchId,until,until,now,env.SHEET_EXPENSE_DAILY,target.fenceToken,now,correctionId,dispatchId),
        env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM expense_owner_correction_move_marker_dispatch WHERE correction_id=? AND dispatch_id=?) AND NOT EXISTS(SELECT 1 FROM owner_correction_daily_write_fences WHERE sheet_name=? AND lease_token=? AND state='IN_FLIGHT' AND dispatch_id=? AND not_before=?) THEN json('invalid marker dispatch') ELSE 1 END AS verified`)
          .bind(correctionId,dispatchId,env.SHEET_EXPENSE_DAILY,target.fenceToken,dispatchId,until)
      ]);
      if(Number(result[0]?.meta.changes||0)!==1||Number(result[1]?.meta.changes||0)!==1)throw new Error("MARKER_DISPATCH_NOT_ARMED");
      dispatched=true;
    });
  }catch{/* Durable dispatch, if present, stays in flight even on ambiguous errors. */}
  return dispatched?"PENDING":"REVIEW";
}

/** Explicit helper for tests/future wiring; no caller is registered. */
export const defaultMoveMarkerCreate=createSheetRowMetadata;

/** Only a positively verified marker can advance; absence never triggers retry. */
export async function recoverReservedMoveMarker(env:Env,owner:OwnerReviewIdentity,correctionId:string,sourceMetadataId:number,fenceToken:string,observe:()=>Promise<MoveMarkerObservation|null>,clock:()=>number=()=>Date.now()):Promise<"WAIT"|"VERIFIED"|"REVIEW">{
  try{
    const nowMs=clock();if(!Number.isFinite(nowMs)||!fenceToken)return "REVIEW";
    const saved=await env.DB.prepare(`SELECT dispatch_id,sheet_name,sheet_id,row_number,metadata_id,not_before,state FROM expense_owner_correction_move_marker_dispatch WHERE correction_id=?`).bind(correctionId).first<{dispatch_id:string;sheet_name:string;sheet_id:number;row_number:number;metadata_id:number;not_before:string;state:string}>();
    if(!saved||saved.state!=="IN_FLIGHT"||saved.sheet_name!==env.SHEET_EXPENSE_DAILY||!Number.isFinite(Date.parse(saved.not_before)))return "REVIEW";
    if(nowMs<Date.parse(saved.not_before))return "WAIT";
    // Drafts expire after 15 minutes; the dispatch uncertainty window is at
    // least that long. This only verifies a marker, never approves the edit.
    const inspection=await inspectReservedMoveMarker(env,owner,correctionId,sourceMetadataId,fenceToken,observe,clock,true);
    if(inspection.kind!=="VERIFIED"||inspection.sheetId!==saved.sheet_id||inspection.destinationMetadataId!==saved.metadata_id||inspection.destinationRow!==saved.row_number)return "REVIEW";
    const now=new Date(clock()).toISOString();
    const updated=await env.DB.prepare(`UPDATE expense_owner_correction_move_marker_dispatch SET state='VERIFIED' WHERE correction_id=? AND dispatch_id=? AND sheet_name=? AND sheet_id=? AND row_number=? AND metadata_id=? AND not_before=? AND not_before<=? AND state='IN_FLIGHT'
      AND EXISTS(SELECT 1 FROM owner_correction_daily_write_fences f WHERE f.sheet_name=? AND f.lease_token=? AND f.state='OWNED' AND f.lease_until>?)
      AND EXISTS(SELECT 1 FROM expense_owner_corrections c WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND ${activeOwnerSql})`)
      .bind(correctionId,saved.dispatch_id,saved.sheet_name,saved.sheet_id,saved.row_number,saved.metadata_id,saved.not_before,now,env.SHEET_EXPENSE_DAILY,fenceToken,now,correctionId,owner.employeeId,owner.employeeId,owner.lineUserId).run();
    return Number(updated.meta.changes||0)===1?"VERIFIED":"REVIEW";
  }catch{return "REVIEW";}
}
