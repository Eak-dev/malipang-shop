import type {Env} from '../types';
import {correctionPeriodHeaderDigest} from '../expense/owner-correction-period-math';
import {isIsoDate} from '../shared/time';

/** Values must be the exact D1 and posting snapshot independently inspected by the caller. */
export interface DailyPostingSnapshot{expenseId:string;version:number;updatedAt:string|null;description:string;category:string;amountSatang:number;transactionDate:string;paymentKey:string;sourceWallet:string}
export interface DailyPostingReservation{expenseId:string;version:number;sheetName:string;sheetId:number;rowNumber:number;metadataId:number;headerDigest:string}
/**
 * D1 reservation only: no Sheets operation and no permission to post.
 * Caller must hold the shared sheet fence, an active EXPENSE sync job lease,
 * and independently verify complete identity/index coverage, target blankness,
 * trusted formulas, month/year and exclusive structural/cell protection.
 * A numeric row is only a proposal until a durable marker is dispatched and
 * verified after its full uncertainty window. No production caller exists.
 */
export async function reserveDailyPosting(env:Env,snapshot:DailyPostingSnapshot,input:{sheetId:number;rowNumber:number;metadataId:number;headers:unknown[][];fenceToken:string;syncToken:string},nowMs=Date.now()):Promise<DailyPostingReservation|null>{
  if(!env.SHEET_EXPENSE_DAILY||!snapshot||!input||typeof snapshot.expenseId!=='string'||!snapshot.expenseId||!Number.isSafeInteger(snapshot.version)||snapshot.version<1||!Number.isSafeInteger(snapshot.amountSatang)||snapshot.amountSatang<=0||!isIsoDate(snapshot.transactionDate)||![snapshot.description,snapshot.category,snapshot.paymentKey,snapshot.sourceWallet].every(value=>typeof value==='string'&&value.trim())||!Number.isSafeInteger(input.sheetId)||input.sheetId<0||!Number.isSafeInteger(input.rowNumber)||input.rowNumber<1||!Number.isSafeInteger(input.metadataId)||input.metadataId<1||input.metadataId>2147483647||!input.fenceToken||!input.syncToken||!Array.isArray(input.headers)||input.headers.length!==3||input.headers.some(row=>!Array.isArray(row))||!Number.isFinite(nowMs))return null;
  const now=new Date(nowMs);if(!Number.isFinite(now.getTime()))return null;const time=now.toISOString(),sheet=env.SHEET_EXPENSE_DAILY,nonce=crypto.randomUUID();
  let digest:string;try{digest=await correctionPeriodHeaderDigest(input.headers);}catch{return null;}
  const json=JSON.stringify(snapshot),guard=`EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version
    JOIN owner_correction_daily_write_fences f ON f.sheet_name=? AND f.lease_token=? AND f.state='OWNED' AND f.lease_until>?
    JOIN owner_correction_daily_identity_latch l ON l.sheet_name=f.sheet_name
    WHERE e.expense_id=? AND e.status='CONFIRMED' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=?
    AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>? AND NOT EXISTS(SELECT 1 FROM sync_jobs c WHERE c.entity_type='EXPENSE_CORRECTION' AND c.entity_key=e.expense_id AND c.status<>'COMPLETED'))`;
  const guardArgs=[sheet,input.fenceToken,time,snapshot.expenseId,snapshot.version,snapshot.updatedAt,snapshot.description,snapshot.category,snapshot.amountSatang,snapshot.transactionDate,snapshot.paymentKey,snapshot.sourceWallet,input.syncToken,time];
  const same=`expense_id=? AND expense_version=? AND sheet_name=? AND sheet_id=? AND row_number=? AND metadata_id=? AND snapshot_json=? AND header_digest=? AND state='PREPARED'`;
  const args=[snapshot.expenseId,snapshot.version,sheet,input.sheetId,input.rowNumber,input.metadataId,json,digest];
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO daily_identity_posting_reservations(expense_id,expense_version,sheet_name,sheet_id,row_number,metadata_id,snapshot_json,header_digest,creation_nonce,state,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,'PREPARED',? WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM sheet_row_index WHERE sheet_name=? AND (row_number=? OR entity_key=?))`)
      .bind(...args,nonce,time,...guardArgs,sheet,input.rowNumber,snapshot.expenseId),
    env.DB.prepare(`INSERT OR IGNORE INTO sheet_row_index(sheet_name,entity_key,row_number) SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM daily_identity_posting_reservations WHERE ${same} AND creation_nonce=?) AND ${guard}`)
      .bind(sheet,snapshot.expenseId,input.rowNumber,...args,nonce,...guardArgs),
    env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM daily_identity_posting_reservations WHERE ${same} AND creation_nonce=?) AND NOT EXISTS(SELECT 1 FROM sheet_row_index WHERE sheet_name=? AND entity_key=? AND row_number=?) THEN json('daily posting reservation incomplete') ELSE 1 END AS verified`)
      .bind(...args,nonce,sheet,snapshot.expenseId,input.rowNumber)
  ]);
  const result=await env.DB.prepare(`SELECT 1 AS present FROM daily_identity_posting_reservations WHERE ${same} AND EXISTS(SELECT 1 FROM sheet_row_index WHERE sheet_name=? AND entity_key=? AND row_number=?) AND ${guard}`)
    .bind(...args,sheet,snapshot.expenseId,input.rowNumber,...guardArgs).first<{present:number}>();
  return result?{expenseId:snapshot.expenseId,version:snapshot.version,sheetName:sheet,sheetId:input.sheetId,rowNumber:input.rowNumber,metadataId:input.metadataId,headerDigest:digest}:null;
}
