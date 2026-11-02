import type {Env} from "../types";
import {activeOwnerSql,type OwnerReviewIdentity} from "./online-order-review-repository";
import {buildOwnerCorrectionDraft,type OwnerCorrectionField,type OwnerCorrectionSnapshot} from "./owner-correction";

export type ManualCorrectionReason="CROSS_MONTH"|"LEGACY_BANK"|"RECEIPT_ALLOCATION"|"REPORT_DUPLICATE"|"SHEET_CHECK"|"PERIOD_UNCONFIRMED";
const reasons=new Set<ManualCorrectionReason>(["CROSS_MONTH","LEGACY_BANK","RECEIPT_ALLOCATION","REPORT_DUPLICATE","SHEET_CHECK","PERIOD_UNCONFIRMED"]);

/** Persist an owner's held request without mutating the expense or evidence. */
export async function holdOwnerCorrectionForReview(env:Env,owner:OwnerReviewIdentity,id:string,reason:ManualCorrectionReason,nowMs=Date.now()):Promise<"HELD"|"STALE">{
  if(!id||!reasons.has(reason)||!Number.isFinite(nowMs))return "STALE";const now=new Date(nowMs).toISOString();
  const row=await env.DB.prepare(`SELECT c.* FROM expense_owner_corrections c WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND ${activeOwnerSql}`)
    .bind(id,owner.employeeId,now,owner.employeeId,owner.lineUserId).first<Record<string,unknown>>();
  if(!row){const prior=await env.DB.prepare(`SELECT 1 present FROM expense_owner_correction_manual_reviews r JOIN expense_owner_corrections c ON c.correction_id=r.correction_id WHERE r.correction_id=? AND r.owner_employee_id=? AND r.status='OPEN' AND c.status='DRAFT' AND ${activeOwnerSql}`).bind(id,owner.employeeId,owner.employeeId,owner.lineUserId).first<{present:number}>();return prior?"HELD":"STALE";}
  let before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot;try{before=JSON.parse(String(row.before_json)) as OwnerCorrectionSnapshot;after=JSON.parse(String(row.after_json)) as OwnerCorrectionSnapshot;}catch{return "STALE";}
  const field=String(row.field) as OwnerCorrectionField;if(before.status!=="CONFIRMED")return "STALE";
  const value=field==="payment"?{paymentKey:after.paymentKey,sourceWallet:after.sourceWallet}:field==="amountSatang"?`${Math.floor(after.amountSatang/100)}.${String(after.amountSatang%100).padStart(2,"0")}`:field==="transactionDate"?after.transactionDate:field==="category"?after.category:after.description;
  const rebuilt=buildOwnerCorrectionDraft(before,field,value);if(!rebuilt||JSON.stringify(rebuilt.after)!==JSON.stringify(after))return "STALE";
  const inserted=await env.DB.prepare(`INSERT INTO expense_owner_correction_manual_reviews(correction_id,expense_id,owner_employee_id,reason_code,status,created_at,updated_at)
    SELECT c.correction_id,e.expense_id,?,?,'OPEN',?,? FROM expense_owner_corrections c JOIN expense_events e ON e.expense_id=c.expense_id
    WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND c.before_json=? AND c.after_json=? AND e.status='CONFIRMED' AND e.version=? AND e.updated_at IS ?
      AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}
      AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED') ON CONFLICT(correction_id) DO NOTHING`)
    .bind(owner.employeeId,reason,now,now,id,owner.employeeId,now,String(row.before_json),String(row.after_json),before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId).run();
  if(Number(inserted.meta.changes||0)===1)return "HELD";
  const existing=await env.DB.prepare(`SELECT 1 present FROM expense_owner_correction_manual_reviews r JOIN expense_owner_corrections c ON c.correction_id=r.correction_id WHERE r.correction_id=? AND r.owner_employee_id=? AND r.status='OPEN' AND c.status='DRAFT' AND ${activeOwnerSql}`).bind(id,owner.employeeId,owner.employeeId,owner.lineUserId).first<{present:number}>();
  return existing?"HELD":"STALE";
}

/** Only the owner who created a request can list it, with no employee identity. */
export async function listOwnerCorrectionManualReviews(env:Env,owner:OwnerReviewIdentity,cursorCreated="",cursorId=""):Promise<Record<string,unknown>[]> {
  if((cursorCreated&&!cursorId)||(!cursorCreated&&cursorId)||cursorCreated.length>40||cursorId.length>160)return [];
  const rows=await env.DB.prepare(`SELECT c.correction_id,c.field,c.before_json,c.after_json,r.reason_code,r.created_at,e.version AS current_version,
    CASE WHEN json_valid(c.before_json) AND e.status=json_extract(CASE WHEN json_valid(c.before_json) THEN c.before_json ELSE '{}' END,'$.status') AND e.version=json_extract(CASE WHEN json_valid(c.before_json) THEN c.before_json ELSE '{}' END,'$.version') AND e.updated_at IS json_extract(CASE WHEN json_valid(c.before_json) THEN c.before_json ELSE '{}' END,'$.updatedAt') AND e.description=json_extract(CASE WHEN json_valid(c.before_json) THEN c.before_json ELSE '{}' END,'$.description') AND e.category=json_extract(CASE WHEN json_valid(c.before_json) THEN c.before_json ELSE '{}' END,'$.category') AND e.amount_satang=json_extract(CASE WHEN json_valid(c.before_json) THEN c.before_json ELSE '{}' END,'$.amountSatang') AND e.transaction_date=json_extract(CASE WHEN json_valid(c.before_json) THEN c.before_json ELSE '{}' END,'$.transactionDate') AND e.payment_key=json_extract(CASE WHEN json_valid(c.before_json) THEN c.before_json ELSE '{}' END,'$.paymentKey') AND e.source_wallet=json_extract(CASE WHEN json_valid(c.before_json) THEN c.before_json ELSE '{}' END,'$.sourceWallet') THEN 1 ELSE 0 END AS snapshot_current
    FROM expense_owner_correction_manual_reviews r JOIN expense_owner_corrections c ON c.correction_id=r.correction_id JOIN expense_events e ON e.expense_id=r.expense_id
    WHERE r.owner_employee_id=? AND r.status='OPEN' AND c.status='DRAFT' AND ${activeOwnerSql}
      AND (?='' OR r.created_at<? OR (r.created_at=? AND c.correction_id<?)) ORDER BY r.created_at DESC,c.correction_id DESC LIMIT 9`)
    .bind(owner.employeeId,owner.employeeId,owner.lineUserId,cursorCreated,cursorCreated,cursorCreated,cursorId).all<Record<string,unknown>>();return rows.results||[];
}

export async function getOwnerCorrectionManualReview(env:Env,owner:OwnerReviewIdentity,id:string):Promise<{reason_code:string}|null>{
  return env.DB.prepare(`SELECT r.reason_code FROM expense_owner_correction_manual_reviews r JOIN expense_owner_corrections c ON c.correction_id=r.correction_id
    WHERE r.correction_id=? AND r.owner_employee_id=? AND r.status='OPEN' AND c.status='DRAFT' AND ${activeOwnerSql}`)
    .bind(id,owner.employeeId,owner.employeeId,owner.lineUserId).first<{reason_code:string}>();
}

export async function ownerCorrectionManualReviewSummary(env:Env):Promise<Array<{reason:string;count:number}>>{
  const rows=await env.DB.prepare(`SELECT reason_code AS reason,COUNT(*) AS count FROM expense_owner_correction_manual_reviews WHERE status='OPEN' GROUP BY reason_code ORDER BY reason_code`).all<{reason:string;count:number}>();
  return (rows.results||[]).map(row=>({reason:String(row.reason),count:Number(row.count)}));
}
