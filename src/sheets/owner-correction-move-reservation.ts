import type {Env} from "../types";
import type {OwnerReviewIdentity} from "../expense/online-order-review-repository";
import {activeOwnerSql} from "../expense/online-order-review-repository";
import {loadOwnerCorrectionDraft} from "../expense/owner-correction-repository";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {correctionAccountingPeriods,correctionPeriodHeaderDigest,correctionPostingDate} from "../expense/owner-correction-period-math";
import {calculateOwnerCorrectionMoveImpact} from "./owner-correction-move-impact";

export interface MoveReservation{correctionId:string;expenseId:string;sheetName:string;rowNumber:number;mappingKey:string;metadataId:number;headerDigest:string}

/**
 * D1-only reservation primitive; caller must independently read fresh Sheets
 * headers, verify the proposed row is empty and inside the destination month,
 * and hold the sheet-wide fence. It never creates metadata or writes Sheets.
 */
export async function reserveOwnerCorrectionMoveRow(env:Env,owner:OwnerReviewIdentity,id:string,input:{rowNumber:number;metadataId:number;headers:unknown[][];fenceToken:string},nowMs=Date.now()):Promise<MoveReservation|null>{
  if(env.OWNER_EXPENSE_CORRECTION_ENABLED!=="true"||!env.SHEET_EXPENSE_DAILY||!/^owner_correction_[A-Za-z0-9_-]{8,128}$/.test(id)||!Number.isSafeInteger(input.rowNumber)||input.rowNumber<1||!Number.isSafeInteger(input.metadataId)||input.metadataId<1||input.metadataId>2147483647||!input.fenceToken||!Number.isFinite(nowMs))return null;
  const row=await loadOwnerCorrectionDraft(env,owner,id,nowMs);if(!row)return null;
  let before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot;try{before=JSON.parse(String(row.before_json)) as OwnerCorrectionSnapshot;after=JSON.parse(String(row.after_json)) as OwnerCorrectionSnapshot;}catch{return null;}
  if(!calculateOwnerCorrectionMoveImpact(before,after,input.headers))return null;
  let periods:string[],digest:string;try{periods=correctionAccountingPeriods(before,after,input.headers);digest=await correctionPeriodHeaderDigest(input.headers);if(correctionPostingDate(before,input.headers).slice(0,7)===correctionPostingDate(after,input.headers).slice(0,7))return null;}catch{return null;}
  const sheet=env.SHEET_EXPENSE_DAILY,key=`__owner_move__:${id}`,now=new Date(nowMs).toISOString(),nonce=crypto.randomUUID();
  const guard=`EXISTS(SELECT 1 FROM expense_owner_corrections c JOIN expense_events e ON e.expense_id=c.expense_id
    WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND c.before_json=? AND c.after_json=?
    AND e.expense_id=? AND e.status='CONFIRMED' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}
    AND EXISTS(SELECT 1 FROM owner_correction_daily_write_fences f WHERE f.sheet_name=? AND f.lease_token=? AND f.state='OWNED' AND f.lease_until>?)
    AND NOT EXISTS(SELECT 1 FROM expense_owner_correction_manual_reviews r WHERE r.correction_id=c.correction_id AND r.status='OPEN')
    AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED')
    AND NOT EXISTS(SELECT 1 FROM json_each(?) wanted WHERE NOT EXISTS(SELECT 1 FROM expense_owner_correction_period_decisions p WHERE p.correction_id=c.correction_id AND p.period=wanted.value AND p.header_digest=? AND p.decision='OPEN' AND p.actor_employee_id=c.owner_employee_id) OR EXISTS(SELECT 1 FROM expense_owner_correction_period_decisions p WHERE p.correction_id=c.correction_id AND p.period=wanted.value AND p.header_digest=? AND p.decision='HOLD'))) `;
  const guardArgs=[id,owner.employeeId,now,String(row.before_json),String(row.after_json),before.expenseId,before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId,sheet,input.fenceToken,now,JSON.stringify(periods),digest,digest];
  const same=`correction_id=? AND expense_id=? AND owner_employee_id=? AND sheet_name=? AND row_number=? AND mapping_key=? AND metadata_id=? AND header_digest=? AND state='PREPARED'`;
  const args=[id,before.expenseId,owner.employeeId,sheet,input.rowNumber,key,input.metadataId,digest];
  const result=await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO expense_owner_correction_move_reservations(correction_id,expense_id,owner_employee_id,sheet_name,row_number,mapping_key,metadata_id,header_digest,creation_nonce,state,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,'PREPARED',? WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM sheet_row_index WHERE sheet_name=? AND row_number=? AND entity_key<>?)`).bind(...args,nonce,now,...guardArgs,sheet,input.rowNumber,key),
    env.DB.prepare(`INSERT OR IGNORE INTO sheet_row_index(sheet_name,entity_key,row_number) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM expense_owner_correction_move_reservations WHERE ${same} AND creation_nonce=?) AND ${guard}`).bind(sheet,key,input.rowNumber,...args,nonce,...guardArgs),
    env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM expense_owner_correction_move_reservations WHERE ${same}) AND ${guard} AND NOT EXISTS(SELECT 1 FROM sheet_row_index WHERE sheet_name=? AND entity_key=? AND row_number=?) THEN json('invalid move row reservation') ELSE 1 END verified`).bind(...args,...guardArgs,sheet,key,input.rowNumber)
  ]);
  void result;
  const saved=await env.DB.prepare(`SELECT correction_id FROM expense_owner_correction_move_reservations WHERE ${same} AND EXISTS(SELECT 1 FROM sheet_row_index WHERE sheet_name=? AND entity_key=? AND row_number=?) AND ${guard}`).bind(...args,sheet,key,input.rowNumber,...guardArgs).first<{correction_id:string}>();
  return saved?{correctionId:id,expenseId:before.expenseId,sheetName:sheet,rowNumber:input.rowNumber,mappingKey:key,metadataId:input.metadataId,headerDigest:digest}:null;
}
