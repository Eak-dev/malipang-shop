import type {Env} from "../types";
import {randomId} from "../shared/ids";
import {isoDateInBangkok} from "../shared/time";
import {activeOwnerSql,type OwnerReviewIdentity} from "./online-order-review-repository";
import {buildOwnerCorrectionDraft,parseOwnerCorrectionAmount,parseOwnerCorrectionDate,type OwnerCorrectionField,type OwnerCorrectionPayment,type OwnerCorrectionSnapshot} from "./owner-correction";
import {assessOwnerCorrection,type CorrectionGuardEvidence} from "./owner-correction-guard";
import {correctionRawPatchMatches,serializeCorrectionSyncPlan,type CorrectionSyncPlan} from "../sheets/owner-correction-sync-plan";
import {commitPendingOrderCorrection} from "./owner-correction-pending-order";
import {correctionAccountingPeriods,correctionPeriodHeaderDigest,correctionPostingDate} from "./owner-correction-period-math";

export type OwnerCorrectionInput={mode:"SEARCH"}|{mode:"VALUE";field:"description"|"amountSatang"|"transactionDate";snapshot:OwnerCorrectionSnapshot};

/** Replacing an input is scoped to this authenticated owner and creates no expense. */
export async function startOwnerCorrectionInput(env:Env,owner:OwnerReviewIdentity,input:OwnerCorrectionInput,nowMs=Date.now()):Promise<boolean>{
  if(!Number.isFinite(nowMs))return false;
  const now=new Date(nowMs).toISOString(),expires=new Date(nowMs+15*60_000).toISOString();
  const snapshot=input.mode==="VALUE"?input.snapshot:null;
  if(snapshot&&(!snapshot.expenseId||!["WAITING_CONFIRM","CONFIRMED"].includes(snapshot.status)))return false;
  const inputId=randomId("correction_input"),result=await env.DB.batch([
    env.DB.prepare(`INSERT INTO expense_owner_correction_inputs(owner_employee_id,input_id,mode,expense_id,field,snapshot_json,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,? WHERE ${activeOwnerSql}
    ON CONFLICT(owner_employee_id) DO UPDATE SET input_id=excluded.input_id,mode=excluded.mode,expense_id=excluded.expense_id,field=excluded.field,snapshot_json=excluded.snapshot_json,search_query=NULL,created_at=excluded.created_at,expires_at=excluded.expires_at`)
      .bind(owner.employeeId,inputId,input.mode,snapshot?.expenseId||null,input.mode==="VALUE"?input.field:null,snapshot?JSON.stringify(snapshot):null,now,expires,owner.employeeId,owner.lineUserId),
    env.DB.prepare(`DELETE FROM expense_document_review_inputs WHERE owner_employee_id=? AND EXISTS(SELECT 1 FROM expense_owner_correction_inputs WHERE owner_employee_id=? AND input_id=?)`).bind(owner.employeeId,owner.employeeId,inputId),
    env.DB.prepare(`DELETE FROM expense_pending_edits WHERE line_user_id=? AND EXISTS(SELECT 1 FROM expense_owner_correction_inputs WHERE owner_employee_id=? AND input_id=?)`).bind(owner.lineUserId,owner.employeeId,inputId)
  ]);
  return Number(result[0]?.meta.changes||0)===1;
}
export async function storeOwnerCorrectionQuery(env:Env,owner:OwnerReviewIdentity,inputId:string,query:string,nowMs=Date.now()):Promise<boolean>{
  const value=query.trim();if(value.length<2||value.length>100||!Number.isFinite(nowMs))return false;
  const result=await env.DB.prepare(`UPDATE expense_owner_correction_inputs SET search_query=? WHERE owner_employee_id=? AND input_id=? AND mode='SEARCH' AND expires_at>? AND ${activeOwnerSql}`)
    .bind(value,owner.employeeId,inputId,new Date(nowMs).toISOString(),owner.employeeId,owner.lineUserId).run();
  return Number(result.meta.changes||0)===1;
}
export async function loadOwnerCorrectionInput(env:Env,owner:OwnerReviewIdentity,nowMs=Date.now()):Promise<Record<string,unknown>|null>{
  if(!Number.isFinite(nowMs))return null;
  return env.DB.prepare(`SELECT i.* FROM expense_owner_correction_inputs i WHERE i.owner_employee_id=? AND i.expires_at>? AND ${activeOwnerSql}`)
    .bind(owner.employeeId,new Date(nowMs).toISOString(),owner.employeeId,owner.lineUserId).first<Record<string,unknown>>();
}
/** Only consume the input that was read; a newer prompt cannot be cleared. */
export async function clearOwnerCorrectionInput(env:Env,owner:OwnerReviewIdentity,inputId:string):Promise<boolean>{
  const result=await env.DB.prepare(`DELETE FROM expense_owner_correction_inputs WHERE owner_employee_id=? AND input_id=? AND ${activeOwnerSql}`)
    .bind(owner.employeeId,inputId,owner.employeeId,owner.lineUserId).run();
  return Number(result.meta.changes||0)===1;
}

/** A stale snapshot or revoked owner can never create a correction draft. */
export async function createOwnerCorrectionDraft(env:Env,owner:OwnerReviewIdentity,before:OwnerCorrectionSnapshot,field:OwnerCorrectionField,value:string|OwnerCorrectionPayment,nowMs=Date.now(),inputId?:string):Promise<string|null>{
  const draft=buildOwnerCorrectionDraft(before,field,value);if(!draft||!Number.isFinite(nowMs))return null;
  const id=randomId("owner_correction"),now=new Date(nowMs).toISOString(),expires=new Date(nowMs+15*60_000).toISOString();
  const result=await env.DB.prepare(`INSERT INTO expense_owner_corrections(correction_id,expense_id,owner_employee_id,input_id,field,before_json,after_json,status,created_at,expires_at)
    SELECT ?,e.expense_id,?,?,?,?,?, 'DRAFT',?,? FROM expense_events e
    WHERE e.expense_id=? AND e.status=? AND e.version=? AND e.updated_at IS ?
      AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}
      ${inputId?`AND EXISTS(SELECT 1 FROM expense_owner_correction_inputs i WHERE i.owner_employee_id=? AND i.input_id=? AND i.mode='VALUE' AND i.expense_id=e.expense_id AND i.field=? AND i.snapshot_json=? AND i.expires_at>?)`:""}
    ON CONFLICT(input_id) DO NOTHING`)
    .bind(id,owner.employeeId,inputId||null,field,JSON.stringify(draft.before),JSON.stringify(draft.after),now,expires,before.expenseId,before.status,before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId,...(inputId?[owner.employeeId,inputId,field,JSON.stringify(before),now]:[])).run();
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

export type OwnerCorrectionStatus="DRAFT"|"EXPIRED"|"CANCELLED"|"STALE"|"DRAFT_EDITED"|"SYNC_PENDING"|"SYNC_FAILED"|"SYNC_REVIEW"|"COMPLETED";
/** An approved D1 update is not reported complete until its sync job completes. */
export async function ownerCorrectionStatus(env:Env,owner:OwnerReviewIdentity,id:string,nowMs=Date.now()):Promise<OwnerCorrectionStatus|null>{
  if(!id||!Number.isFinite(nowMs))return null;
  const row=await env.DB.prepare(`SELECT c.status,c.expires_at,c.reconciled_at,json_extract(CASE WHEN json_valid(c.before_json) THEN c.before_json ELSE '{}' END,'$.status') AS before_status,(SELECT s.phase FROM expense_owner_correction_sync s WHERE s.correction_id=c.correction_id) AS sync_phase,
    (SELECT j.status FROM expense_audit_log a JOIN sync_jobs j ON j.entity_type='EXPENSE_CORRECTION' AND j.entity_key=c.expense_id
       AND j.entity_version=CAST(json_extract(CASE WHEN json_valid(a.after_json) THEN a.after_json ELSE '{}' END,'$.version') AS INTEGER)
     WHERE a.expense_id=c.expense_id AND a.action='EDIT' AND json_extract(CASE WHEN json_valid(a.after_json) THEN a.after_json ELSE '{}' END,'$.correctionId')=c.correction_id LIMIT 1) AS sync_status
    FROM expense_owner_corrections c WHERE c.correction_id=? AND c.owner_employee_id=? AND ${activeOwnerSql}`)
    .bind(id,owner.employeeId,owner.employeeId,owner.lineUserId).first<{status:string;before_status:string|null;expires_at:string;reconciled_at:string|null;sync_status:string|null;sync_phase:string|null}>();
  if(!row)return null;
  if(row.status==="DRAFT")return row.expires_at<=new Date(nowMs).toISOString()?"EXPIRED":"DRAFT";
  if(row.status==="CANCELLED"||row.status==="STALE")return row.status;
  if(row.status!=="APPLIED")return null;
  if(row.before_status==="WAITING_CONFIRM")return "DRAFT_EDITED";
  return row.sync_phase==="REVIEW"?"SYNC_REVIEW":row.sync_status==="COMPLETED"&&row.sync_phase==="RECONCILED"&&row.reconciled_at?"COMPLETED":row.sync_status==="FAILED"?"SYNC_FAILED":"SYNC_PENDING";
}

/** Edit a waiting expense without confirming it, touching evidence, or writing Sheets. */
export async function commitPendingOwnerCorrection(env:Env,owner:OwnerReviewIdentity,id:string,expectedVersion:number,nowMs=Date.now()):Promise<"APPLIED"|"STALE"|"REVIEW">{
  if(!Number.isSafeInteger(expectedVersion)||expectedVersion<1||!Number.isFinite(nowMs))return "STALE";
  const row=await loadOwnerCorrectionDraft(env,owner,id,nowMs);if(!row)return "STALE";
  let before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot;try{before=JSON.parse(String(row.before_json)) as OwnerCorrectionSnapshot;after=JSON.parse(String(row.after_json)) as OwnerCorrectionSnapshot;}catch{return "STALE";}
  if(!before||!after||before.status!=="WAITING_CONFIRM"||before.version!==expectedVersion||!Number.isSafeInteger(before.version+1))return "STALE";
  const field=String(row.field) as OwnerCorrectionField;
  const value=field==="payment"?{paymentKey:after.paymentKey,sourceWallet:after.sourceWallet}:field==="amountSatang"?`${Math.floor(after.amountSatang/100)}.${String(after.amountSatang%100).padStart(2,"0")}`:field==="transactionDate"?after.transactionDate:field==="category"?after.category:after.description;
  const rebuilt=buildOwnerCorrectionDraft(before,field,value);if(!rebuilt||JSON.stringify(rebuilt.after)!==JSON.stringify(after)||(field==="transactionDate"&&after.transactionDate>isoDateInBangkok(new Date(nowMs))))return "STALE";
  // Existing owner-reviewed online orders attest to exact paid facts; update
  // those facts only together with a new auditable owner attestation.
  if(field==="amountSatang"||field==="transactionDate"){
    const order=await env.DB.prepare(`SELECT 1 AS present FROM expense_documents d LEFT JOIN expense_document_links l ON l.document_id=d.document_id AND l.expense_id=? WHERE (d.expense_id=? OR l.expense_id=?) AND d.document_type='ONLINE_ORDER' AND (NOT json_valid(COALESCE(d.normalized_json,'')) OR json_extract(CASE WHEN json_valid(d.normalized_json) THEN d.normalized_json ELSE '{}' END,'$.ownerPaymentReview.source')='OWNER_LINE_REVIEW') LIMIT 1`).bind(before.expenseId,before.expenseId,before.expenseId).first<{present:number}>();
    if(order)return commitPendingOrderCorrection(env,owner,{id,field,before,after,beforeJson:String(row.before_json),afterJson:String(row.after_json),nowMs});
  }
  const auditId=randomId("exp_audit"),now=new Date(nowMs).toISOString(),next=before.version+1;
  const guard=field==="amountSatang"||field==="transactionDate"?`AND NOT EXISTS(SELECT 1 FROM expense_documents d LEFT JOIN expense_document_links l ON l.document_id=d.document_id AND l.expense_id=e.expense_id WHERE (d.expense_id=e.expense_id OR l.expense_id=e.expense_id) AND d.document_type='ONLINE_ORDER' AND (NOT json_valid(COALESCE(d.normalized_json,'')) OR json_extract(CASE WHEN json_valid(d.normalized_json) THEN d.normalized_json ELSE '{}' END,'$.ownerPaymentReview.source')='OWNER_LINE_REVIEW'))`:"";
  const results=await env.DB.batch([
    env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,branch_id,reason,before_json,after_json,created_at)
      SELECT ?,?,'EDIT',e.expense_id,e.branch_id,?,?,?,? FROM expense_events e JOIN expense_owner_corrections c ON c.expense_id=e.expense_id
      WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND c.before_json=? AND c.after_json=?
        AND e.expense_id=? AND e.status='WAITING_CONFIRM' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}
        AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED') ${guard}`)
      .bind(auditId,owner.employeeId,`OWNER_PENDING_CORRECTION:${field}`,JSON.stringify(before),JSON.stringify({...after,version:next,correctionId:id}),now,id,owner.employeeId,now,String(row.before_json),String(row.after_json),before.expenseId,before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId),
    env.DB.prepare(`UPDATE expense_events SET description=?,category=?,amount_satang=?,transaction_date=?,payment_key=?,source_wallet=?,version=?,updated_at=? WHERE expense_id=? AND status='WAITING_CONFIRM' AND version=? AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`)
      .bind(after.description,after.category,after.amountSatang,after.transactionDate,after.paymentKey,after.sourceWallet,next,now,before.expenseId,before.version,auditId),
    env.DB.prepare(`UPDATE expense_owner_corrections SET status='APPLIED',applied_at=? WHERE correction_id=? AND status='DRAFT' AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`).bind(now,id,auditId),
    env.DB.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?) OR (EXISTS(SELECT 1 FROM expense_events WHERE expense_id=? AND status='WAITING_CONFIRM' AND version=? AND updated_at=?) AND EXISTS(SELECT 1 FROM expense_owner_corrections WHERE correction_id=? AND status='APPLIED' AND applied_at=?)) THEN 1 ELSE json('invalid pending correction') END AS verified`)
      .bind(auditId,before.expenseId,next,now,id,now)
  ]);
  if(Number(results[0]?.meta.changes||0)!==1)return "STALE";
  if(Number(results[1]?.meta.changes||0)!==1||Number(results[2]?.meta.changes||0)!==1)throw new Error("OWNER_PENDING_CORRECTION_INCOMPLETE");
  return "APPLIED";
}

/** Small, deterministic pages only, using bound text and no fuzzy auto-selection. */
export async function searchOwnerExpenses(env:Env,owner:OwnerReviewIdentity,search:string,beforeCreatedAt="",beforeId=""):Promise<Record<string,unknown>[]> {
  const query=search.trim();if(query.length<2||query.length>100||Boolean(beforeCreatedAt)!==Boolean(beforeId))return [];
  const literal=query.replace(/[\\%_]/g,"\\$&"),results=await env.DB.prepare(`SELECT e.expense_id,e.description,e.amount_satang,e.transaction_date,e.category,e.payment_key,e.source_wallet,e.status,e.created_at
    FROM expense_events e WHERE e.status IN ('CONFIRMED','WAITING_CONFIRM') AND ${activeOwnerSql}
      AND (e.description LIKE ? ESCAPE '\\' OR e.transaction_date=? OR e.amount_satang=? OR EXISTS(
        SELECT 1 FROM expense_documents d LEFT JOIN expense_document_links l ON l.document_id=d.document_id AND l.expense_id=e.expense_id
        WHERE (d.expense_id=e.expense_id OR l.expense_id=e.expense_id)
          AND (d.vendor_name LIKE ? ESCAPE '\\' OR d.legal_vendor_name LIKE ? ESCAPE '\\')))
      AND (?='' OR (e.created_at,e.expense_id)<(?,?)) ORDER BY e.created_at DESC,e.expense_id DESC LIMIT 9`)
    .bind(owner.employeeId,owner.lineUserId,`%${literal}%`,parseOwnerCorrectionDate(query)||query,parseOwnerCorrectionAmount(query),`%${literal}%`,`%${literal}%`,beforeCreatedAt,beforeCreatedAt,beforeId).all<Record<string,unknown>>();
  return results.results||[];
}

/** Load another submitter's current snapshot only after verifying owner role. */
export async function loadOwnerExpense(env:Env,owner:OwnerReviewIdentity,expenseId:string):Promise<OwnerCorrectionSnapshot|null>{
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(expenseId))return null;
  const e=await env.DB.prepare(`SELECT e.expense_id,e.status,e.version,e.updated_at,e.description,e.category,e.amount_satang,e.transaction_date,e.payment_key,e.source_wallet FROM expense_events e
    WHERE e.expense_id=? AND e.status IN ('CONFIRMED','WAITING_CONFIRM') AND ${activeOwnerSql}`).bind(expenseId,owner.employeeId,owner.lineUserId).first<Record<string,unknown>>();
  return e?{expenseId:String(e.expense_id),status:String(e.status),version:Number(e.version),updatedAt:e.updated_at==null?null:String(e.updated_at),description:String(e.description),category:String(e.category),amountSatang:Number(e.amount_satang),transactionDate:String(e.transaction_date),paymentKey:String(e.payment_key),sourceWallet:String(e.source_wallet)}:null;
}

/**
 * Internal transaction primitive, not connected to LINE. The future caller
 * must independently verify period status and every projection identity and
 * provide fresh evidence; the actual Sheets worker is not implemented yet.
 */
export async function commitOwnerCorrection(env:Env,owner:OwnerReviewIdentity,id:string,evidence:CorrectionGuardEvidence,traceId:string,nowMs=Date.now(),plan?:CorrectionSyncPlan):Promise<number|null>{
  const row=await loadOwnerCorrectionDraft(env,owner,id,nowMs);if(!row)return null;
  let before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot;try{before=JSON.parse(String(row.before_json)) as OwnerCorrectionSnapshot;after=JSON.parse(String(row.after_json)) as OwnerCorrectionSnapshot;}catch{return null;}
  const field=String(row.field) as OwnerCorrectionField;
  const value=field==="payment"?{paymentKey:after.paymentKey,sourceWallet:after.sourceWallet}:field==="amountSatang"?`${Math.floor(after.amountSatang/100)}.${String(after.amountSatang%100).padStart(2,"0")}`:field==="transactionDate"?after.transactionDate:field==="category"?after.category:after.description;
  const rebuilt=buildOwnerCorrectionDraft(before,field,value);if(!rebuilt||JSON.stringify(rebuilt.after)!==JSON.stringify(after)||before.status!=="CONFIRMED"||assessOwnerCorrection(rebuilt,evidence).length)return null;
  const planJson=plan?serializeCorrectionSyncPlan(plan,before.expenseId,id):null;if(!planJson||!plan||!correctionRawPatchMatches(plan,before,after))return null;
  const guardedColumns=plan.patches.find(patch=>patch.metadataId===plan.dailyMetadataId)!.cells.map(cell=>cell.columnIndex).filter(col=>col!==21).sort((a,b)=>a-b);
  if(guardedColumns.length&&(!plan.cellGuards||plan.cellGuards.correctionId!==id||plan.cellGuards.guards.length!==guardedColumns.length||plan.cellGuards.guards.some((guard,index)=>guard.columnIndex!==guardedColumns[index])))return null;
  let periods:string[],headerDigest:string,postingDate:string;try{if(!evidence.periodHeaders)return null;periods=correctionAccountingPeriods(before,after,evidence.periodHeaders);headerDigest=await correctionPeriodHeaderDigest(evidence.periodHeaders);postingDate=correctionPostingDate(before,evidence.periodHeaders);}catch{return null;}
  if(!periods.length||plan.headerDigest!==headerDigest)return null;
  const report=plan.reportBaseline;if(!report||report.expenseId!==before.expenseId||report.date!==before.transactionDate||report.postingDate!==postingDate||report.description!==before.description||report.amountSatang!==before.amountSatang||report.wallet!==before.sourceWallet||report.category!==before.category)return null;
  const auditId=randomId("exp_audit"),jobId=randomId("sync"),now=new Date(nowMs).toISOString(),next=before.version+1;
  if(!Number.isSafeInteger(next))return null;
  const result=await env.DB.batch([
    env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,branch_id,reason,before_json,after_json,created_at)
      SELECT ?,?,'EDIT',e.expense_id,e.branch_id,?,?,?,? FROM expense_events e JOIN expense_owner_corrections c ON c.expense_id=e.expense_id
      WHERE c.correction_id=? AND c.owner_employee_id=? AND c.status='DRAFT' AND c.expires_at>? AND c.before_json=? AND c.after_json=?
      AND e.expense_id=? AND e.status='CONFIRMED' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=?
      AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=? AND ${activeOwnerSql}
      AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_key=e.expense_id AND j.entity_type IN ('EXPENSE','EXPENSE_CORRECTION') AND j.status<>'COMPLETED')
      AND NOT EXISTS(SELECT 1 FROM json_each(?) required WHERE NOT EXISTS(SELECT 1 FROM expense_owner_correction_period_decisions p WHERE p.correction_id=c.correction_id AND p.period=required.value AND p.header_digest=? AND p.decision='OPEN' AND p.actor_employee_id=c.owner_employee_id)
        OR EXISTS(SELECT 1 FROM expense_owner_correction_period_decisions held WHERE held.correction_id=c.correction_id AND held.period=required.value AND held.header_digest=? AND held.decision='HOLD'))
      AND (?=0 OR EXISTS(SELECT 1 FROM expense_owner_correction_cell_guards g WHERE g.correction_id=c.correction_id AND g.expense_id=e.expense_id AND g.expense_version=e.version AND g.daily_metadata_id=? AND g.state='ACTIVE' AND g.columns_json=? AND g.guards_json=?))
      AND (?=0 OR EXISTS(SELECT 1 FROM expense_owner_correction_report_views v WHERE v.correction_id=c.correction_id AND v.expense_id=e.expense_id AND v.expense_version=e.version AND v.state='ACTIVE' AND v.period=? AND v.sheet_id=? AND v.sheet_title=? AND v.metadata_id=?))`)
      .bind(auditId,owner.employeeId,`OWNER_CORRECTION:${field}`,JSON.stringify(before),JSON.stringify({...after,version:next,correctionId:id}),now,id,owner.employeeId,now,String(row.before_json),String(row.after_json),before.expenseId,before.version,before.updatedAt,before.description,before.category,before.amountSatang,before.transactionDate,before.paymentKey,before.sourceWallet,owner.employeeId,owner.lineUserId,JSON.stringify(periods),headerDigest,headerDigest,guardedColumns.length,plan.dailyMetadataId,JSON.stringify(guardedColumns),JSON.stringify(plan.cellGuards?.guards||[]),plan.reportView?1:0,plan.reportView?.period||"",plan.reportView?.sheetId||0,plan.reportView?.title||"",plan.reportView?.metadataId||0),
    env.DB.prepare(`UPDATE expense_events SET description=?,category=?,amount_satang=?,transaction_date=?,payment_key=?,source_wallet=?,version=?,updated_at=? WHERE expense_id=? AND version=? AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`)
      .bind(after.description,after.category,after.amountSatang,after.transactionDate,after.paymentKey,after.sourceWallet,next,now,before.expenseId,before.version,auditId),
    env.DB.prepare(`UPDATE expense_owner_corrections SET status='APPLIED',applied_at=? WHERE correction_id=? AND status='DRAFT' AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`)
      .bind(now,id,auditId),
    env.DB.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token)
      SELECT ?,'EXPENSE_CORRECTION',?,?,?,'PENDING',0,?,?,NULL,NULL WHERE EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`)
      .bind(jobId,before.expenseId,next,traceId,now,now,auditId),
    env.DB.prepare(`INSERT INTO expense_owner_correction_sync(correction_id,expense_id,expense_version,phase,plan_json,updated_at)
      SELECT ?,?,?,'PREPARED',?,? WHERE EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?)`)
      .bind(id,before.expenseId,next,planJson,now,auditId),
    // An unexpected zero-row update after audit insertion must abort the
    // whole batch. No-op when the first guarded audit did not run.
    env.DB.prepare(`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=?) OR (
      EXISTS(SELECT 1 FROM expense_events WHERE expense_id=? AND version=? AND updated_at=?) AND
      EXISTS(SELECT 1 FROM expense_owner_corrections WHERE correction_id=? AND status='APPLIED' AND applied_at=?) AND
      EXISTS(SELECT 1 FROM sync_jobs WHERE job_id=? AND entity_type='EXPENSE_CORRECTION' AND entity_key=? AND entity_version=? AND status='PENDING') AND
      EXISTS(SELECT 1 FROM expense_owner_correction_sync WHERE correction_id=? AND expense_id=? AND expense_version=? AND phase='PREPARED' AND plan_json=?)
    ) THEN 1 ELSE json('invalid owner correction transaction') END AS verified`)
      .bind(auditId,before.expenseId,next,now,id,now,jobId,before.expenseId,next,id,before.expenseId,next,planJson)
  ]);
  if(Number(result[0]?.meta.changes||0)!==1)return null;
  if(result.slice(0,5).some(part=>Number(part.meta.changes||0)!==1))throw new Error("OWNER_CORRECTION_INCOMPLETE_TRANSACTION");
  return next;
}
