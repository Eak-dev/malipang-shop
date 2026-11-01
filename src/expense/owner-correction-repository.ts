import type {Env} from "../types";
import {randomId} from "../shared/ids";
import {activeOwnerSql,type OwnerReviewIdentity} from "./online-order-review-repository";
import {buildOwnerCorrectionDraft,parseOwnerCorrectionAmount,type OwnerCorrectionField,type OwnerCorrectionPayment,type OwnerCorrectionSnapshot} from "./owner-correction";

/** A stale snapshot or revoked owner can never create a correction draft. */
export async function createOwnerCorrectionDraft(env:Env,owner:OwnerReviewIdentity,before:OwnerCorrectionSnapshot,field:OwnerCorrectionField,value:string|OwnerCorrectionPayment,nowMs=Date.now()):Promise<string|null>{
  const draft=buildOwnerCorrectionDraft(before,field,value);if(!draft||!Number.isFinite(nowMs))return null;
  const id=randomId("owner_correction"),now=new Date(nowMs).toISOString(),expires=new Date(nowMs+15*60_000).toISOString();
  const result=await env.DB.prepare(`INSERT INTO expense_owner_corrections(correction_id,expense_id,owner_employee_id,field,before_json,after_json,status,created_at,expires_at)
    SELECT ?,e.expense_id,?,?,?,?, 'DRAFT',?,? FROM expense_events e
    WHERE e.expense_id=? AND e.status=? AND e.version=? AND e.updated_at IS ?
      AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}`)
    .bind(id,owner.employeeId,field,JSON.stringify(draft.before),JSON.stringify(draft.after),now,expires,before.expenseId,before.status,before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId).run();
  return Number(result.meta.changes||0)===1?id:null;
}

/** Even draft contents are available only to the active verified owner. */
export async function loadOwnerCorrectionDraft(env:Env,owner:OwnerReviewIdentity,id:string,nowMs=Date.now()):Promise<Record<string,unknown>|null>{
  if(!id||!Number.isFinite(nowMs))return null;
  return env.DB.prepare(`SELECT c.* FROM expense_owner_corrections c WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND ${activeOwnerSql}`)
    .bind(id,owner.employeeId,new Date(nowMs).toISOString(),owner.employeeId,owner.lineUserId).first<Record<string,unknown>>();
}

/** Cancellation only changes the owner's uncommitted draft, never the expense. */
export async function cancelOwnerCorrectionDraft(env:Env,owner:OwnerReviewIdentity,id:string,nowMs=Date.now()):Promise<boolean>{
  if(!id||!Number.isFinite(nowMs))return false;
  const result=await env.DB.prepare(`UPDATE expense_owner_corrections SET status='CANCELLED' WHERE correction_id=? AND owner_employee_id=? AND status='DRAFT' AND expires_at>? AND ${activeOwnerSql}`)
    .bind(id,owner.employeeId,new Date(nowMs).toISOString(),owner.employeeId,owner.lineUserId).run();
  return Number(result.meta.changes||0)===1;
}

/** Small, deterministic pages only, using bound text and no fuzzy auto-selection. */
export async function searchOwnerExpenses(env:Env,owner:OwnerReviewIdentity,search:string,beforeCreatedAt="",beforeId=""):Promise<Record<string,unknown>[]> {
  const query=search.trim();if(query.length<2||query.length>100||Boolean(beforeCreatedAt)!==Boolean(beforeId))return [];
  const literal=query.replace(/[\\%_]/g,"\\$&"),results=await env.DB.prepare(`SELECT e.expense_id,e.description,e.amount_satang,e.transaction_date,e.category,e.payment_key,e.source_wallet,e.status,e.created_at
    FROM expense_events e WHERE e.status IN ('CONFIRMED','WAITING_CONFIRM') AND ${activeOwnerSql}
      AND (e.description LIKE ? ESCAPE '\\' OR e.transaction_date=? OR e.amount_satang=?)
      AND (?='' OR (e.created_at,e.expense_id)<(?,?)) ORDER BY e.created_at DESC,e.expense_id DESC LIMIT 9`)
    .bind(owner.employeeId,owner.lineUserId,`%${literal}%`,query,parseOwnerCorrectionAmount(query),beforeCreatedAt,beforeCreatedAt,beforeId).all<Record<string,unknown>>();
  return results.results||[];
}

/** Load another submitter's current snapshot only after verifying owner role. */
export async function loadOwnerExpense(env:Env,owner:OwnerReviewIdentity,expenseId:string):Promise<OwnerCorrectionSnapshot|null>{
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(expenseId))return null;
  const e=await env.DB.prepare(`SELECT e.expense_id,e.status,e.version,e.updated_at,e.description,e.category,e.amount_satang,e.transaction_date,e.payment_key,e.source_wallet FROM expense_events e
    WHERE e.expense_id=? AND e.status IN ('CONFIRMED','WAITING_CONFIRM') AND ${activeOwnerSql}`).bind(expenseId,owner.employeeId,owner.lineUserId).first<Record<string,unknown>>();
  return e?{expenseId:String(e.expense_id),status:String(e.status),version:Number(e.version),updatedAt:e.updated_at==null?null:String(e.updated_at),description:String(e.description),category:String(e.category),amountSatang:Number(e.amount_satang),transactionDate:String(e.transaction_date),paymentKey:String(e.payment_key),sourceWallet:String(e.source_wallet)}:null;
}
