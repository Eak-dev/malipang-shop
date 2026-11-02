import type {Env} from "../types";

export type CorrectionQueueKind="manual"|"sync";
export interface CorrectionQueueItem{correctionId:string;reason:string;updatedAt:string;retryNotBefore?:string|null}

/** Minimal operator diagnostics: no employee, expense or receipt details. */
export async function listOwnerCorrectionReviewQueue(env:Env,kind:CorrectionQueueKind,cursor:string):Promise<{items:CorrectionQueueItem[];nextCursor:string|null}>{
  if((kind!=="manual"&&kind!=="sync")||(cursor&&!/^owner_correction_[A-Za-z0-9_-]{8,128}$/.test(cursor)))throw new Error("INVALID_CORRECTION_REVIEW_CURSOR");
  const sql=kind==="manual"?`SELECT r.correction_id,r.reason_code AS reason,r.updated_at,NULL AS not_before FROM expense_owner_correction_manual_reviews r
    JOIN expense_owner_corrections c ON c.correction_id=r.correction_id AND c.status='DRAFT'
    WHERE r.status='OPEN' AND r.correction_id>? ORDER BY r.correction_id LIMIT 21`:
    `SELECT s.correction_id,CASE WHEN j.status='REVIEW' THEN 'SYNC_REVIEW' ELSE 'SYNC_FAILED' END AS reason,s.updated_at,s.not_before FROM expense_owner_correction_sync s
    JOIN expense_owner_corrections c ON c.correction_id=s.correction_id AND c.status='APPLIED'
    JOIN sync_jobs j ON j.entity_type='EXPENSE_CORRECTION' AND j.entity_key=s.expense_id AND j.entity_version=s.expense_version
    WHERE j.status IN ('REVIEW','FAILED') AND s.correction_id>? ORDER BY s.correction_id LIMIT 21`;
  const result=await env.DB.prepare(sql).bind(cursor).all<{correction_id:string;reason:string;updated_at:string;not_before:string|null}>(),rows=result.results||[],items=rows.slice(0,20).map(row=>({correctionId:String(row.correction_id),reason:String(row.reason),updatedAt:String(row.updated_at),...(kind==="sync"?{retryNotBefore:row.not_before}: {})}));
  return {items,nextCursor:rows.length>20?items[items.length-1]!.correctionId:null};
}
