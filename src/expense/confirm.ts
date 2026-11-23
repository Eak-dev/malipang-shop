import { randomId } from "../shared/ids";
import type { Env } from "../types";
import { activeOwnerSql } from "./online-order-review-repository";

export interface ExpenseConfirmationSnapshot {
  description:string;
  amountSatang:number;
  transactionDate:string;
  paymentKey:string;
  sourceWallet:string;
  category:string;
  version:number;
}

export interface ExpenseConfirmationDocumentSnapshot {
  documentId:string;
  normalizedJson:string|null;
  updatedAt:string|null;
}

export interface ConfirmExpenseInput {
  expenseId:string;
  lineUserId:string;
  traceId:string;
  actorEmployeeId:string|null;
  branchId:string|null;
  snapshot:ExpenseConfirmationSnapshot;
  // Omitted means the reviewed draft had no directly attached document.
  documentSnapshot?:ExpenseConfirmationDocumentSnapshot;
}

/**
 * Commits only the exact draft already validated by the caller. D1 batch is a
 * transaction: the private audit ID gates every dependent write and the outbox
 * survives a crash before the caller sends its optional queue notification.
 * Supporting documents linked through expense_document_links are not promoted.
 */
export async function confirmExpenseAtomically(env:Env,input:ConfirmExpenseInput):Promise<number|null>{
  const {snapshot,documentSnapshot}=input;
  const scopeDb=env.DB,scopeFlag=env.SERIAL_JOB_PROVENANCE_ENABLED,scopeBook=env.GOOGLE_SPREADSHEET_ID,scopeSync=env.SHEETS_SYNC_ENABLED;
  const stable=()=>env.DB===scopeDb&&env.SERIAL_JOB_PROVENANCE_ENABLED===scopeFlag&&env.GOOGLE_SPREADSHEET_ID===scopeBook&&env.SHEETS_SYNC_ENABLED===scopeSync;
  if(!Number.isSafeInteger(snapshot.version)||snapshot.version<1)return null;
  const now=new Date().toISOString(),auditId=randomId("exp_audit");
  // Owner review keeps the submitting LINE identity on the evidence. The
  // exception to same-submitter confirmation must be proven relationally;
  // a normalized JSON marker alone never grants access to another document.
  const reviewedOwnerGuard=`d.document_type='ONLINE_ORDER' AND d.message_id=e.message_id
    AND d.submitted_by_employee_id IS e.submitted_by_employee_id AND d.branch_id IS e.branch_id
    AND json_extract(d.normalized_json,'$.ownerPaymentReview.source')='OWNER_LINE_REVIEW'
    AND EXISTS(SELECT 1 FROM expense_document_reviews r
      JOIN expense_audit_log a ON a.audit_id=json_extract(d.normalized_json,'$.ownerPaymentReview.auditId')
        AND a.document_id=d.document_id AND a.action='REVIEW_APPROVE' AND a.actor_employee_id=r.updated_by_employee_id
      JOIN expense_document_links l ON l.document_id=d.document_id AND l.expense_id=e.expense_id
        AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' AND l.match_method='MANUAL' AND l.linked_by_employee_id=a.actor_employee_id
      JOIN expense_online_order_claims c ON c.document_id=d.document_id AND c.order_id=d.order_id AND c.expense_id=e.expense_id AND c.state='EXPENSE_OWNED'
      WHERE r.document_id=d.document_id AND r.expense_id=e.expense_id AND r.phase='DRAFTED'
        AND a.actor_employee_id=? AND json_extract(a.after_json,'$.expenseId')=e.expense_id
        AND json_extract(a.after_json,'$.amountSatang')=e.amount_satang AND json_extract(a.after_json,'$.paymentDate')=e.transaction_date)
    AND ${activeOwnerSql}`;
  const documentGuard=documentSnapshot
    ? `AND EXISTS(SELECT 1 FROM expense_documents d WHERE d.document_id=? AND d.expense_id=e.expense_id
        AND (d.line_user_id=e.line_user_id OR (${reviewedOwnerGuard}))
        AND d.status='WAITING_CONFIRM' AND d.normalized_json IS ? AND d.updated_at IS ?)
       AND NOT EXISTS(SELECT 1 FROM expense_documents d WHERE d.expense_id=e.expense_id AND d.document_id<>?)`
    : `AND NOT EXISTS(SELECT 1 FROM expense_documents d WHERE d.expense_id=e.expense_id)`;
  const documentBindings=documentSnapshot
    ? [documentSnapshot.documentId,input.actorEmployeeId,input.actorEmployeeId,input.lineUserId,documentSnapshot.normalizedJson,documentSnapshot.updatedAt,documentSnapshot.documentId]
    : [];
  const statements=[
    scopeDb.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,document_id,branch_id,reason,before_json,after_json,created_at)
      SELECT ?,?,'CONFIRM',e.expense_id,?,?,'',json_object('status',e.status,'version',e.version),
        json_object('status','CONFIRMED','version',MAX(e.version,COALESCE((SELECT MAX(entity_version)+1 FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=e.expense_id),e.version))),?
      FROM expense_events e WHERE e.expense_id=? AND e.line_user_id=? AND e.status='WAITING_CONFIRM'
        AND e.description=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=?
        AND e.source_wallet=? AND e.category=? AND e.version=?
        AND e.version BETWEEN 1 AND 9007199254740991
        AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=e.expense_id AND entity_version>=9007199254740991)
        ${documentGuard}`)
      .bind(auditId,input.actorEmployeeId,documentSnapshot?.documentId??null,input.branchId,now,input.expenseId,input.lineUserId,
        snapshot.description,snapshot.amountSatang,snapshot.transactionDate,snapshot.paymentKey,snapshot.sourceWallet,snapshot.category,snapshot.version,...documentBindings),
    scopeDb.prepare(`UPDATE expense_events SET status='CONFIRMED',reviewed_by_employee_id=?,approved_at=?,updated_at=?,
        version=(SELECT json_extract(after_json,'$.version') FROM expense_audit_log WHERE audit_id=?)
      WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'
        AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=? AND expense_id=expense_events.expense_id AND action='CONFIRM'
          AND json_extract(before_json,'$.version')=expense_events.version) RETURNING expense_id,version`)
      .bind(input.actorEmployeeId,now,now,auditId,input.expenseId,input.lineUserId,auditId),
    scopeDb.prepare(`UPDATE expense_documents SET status='CONFIRMED',updated_at=?
      WHERE expense_id=? AND status='WAITING_CONFIRM'
        AND EXISTS(SELECT 1 FROM expense_audit_log a JOIN expense_events e ON e.expense_id=a.expense_id
          WHERE a.audit_id=? AND a.action='CONFIRM' AND e.status='CONFIRMED' AND e.version=json_extract(a.after_json,'$.version'))`)
      .bind(now,input.expenseId,auditId)
  ];
  const provenance=env.SERIAL_JOB_PROVENANCE_ENABLED==='true';
  if(env.SHEETS_SYNC_ENABLED==="true")statements.push(
    scopeDb.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token${provenance?',serial_provenance_version,serial_lease_generation':''})
      SELECT ?,'EXPENSE',e.expense_id,e.version,?,'PENDING',0,?,?,NULL,NULL${provenance?`,CASE WHEN EXISTS(SELECT 1 FROM serial_job_provenance_activation WHERE singleton=1 AND spreadsheet_id=?) AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_job_provenance_not_ready') AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_job_provenance_insert_guard','serial_job_provenance_update_guard','serial_job_provenance_delete_guard','serial_job_provenance_activation_no_update','serial_job_provenance_activation_no_delete','serial_job_provenance_activation_no_replace','continuous_daily_post_no_delete','continuous_daily_post_no_update','continuous_daily_post_no_replace','continuous_daily_record_post_cutover'))=10 THEN CASE WHEN e.version=1 AND EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses p JOIN continuous_daily_cutovers c ON c.spreadsheet_id=p.spreadsheet_id AND c.state='ACTIVE' WHERE p.spreadsheet_id=? AND p.expense_id=e.expense_id AND EXISTS(SELECT 1 FROM serial_source_provenance_activation sp WHERE sp.singleton=1 AND sp.spreadsheet_id=p.spreadsheet_id AND sp.namespace=e.serial_source_namespace) AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_source_provenance_not_ready') AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_source_provenance_no_update','serial_source_provenance_no_delete','serial_source_provenance_no_replace','serial_source_provenance_namespace_guard','serial_source_provenance_insert_guard','serial_source_provenance_update_guard','serial_source_provenance_delete_guard','serial_source_job_birth_guard'))=8) THEN 1 ELSE 0 END ELSE json_extract('invalid','$') END,0`:''}
      FROM expense_events e JOIN expense_audit_log a ON a.expense_id=e.expense_id
      WHERE a.audit_id=? AND a.action='CONFIRM' AND e.status='CONFIRMED' AND e.version=json_extract(a.after_json,'$.version')`)
      .bind(randomId("sync"),input.traceId,now,now,...(provenance?[env.GOOGLE_SPREADSHEET_ID||'',env.GOOGLE_SPREADSHEET_ID||'']:[]),auditId)
  );
  statements.push(scopeDb.prepare(`SELECT e.version FROM expense_events e JOIN expense_audit_log a ON a.expense_id=e.expense_id
    WHERE a.audit_id=? AND a.action='CONFIRM' AND e.status='CONFIRMED' AND e.version=json_extract(a.after_json,'$.version')`).bind(auditId));
  if(!stable())throw new Error('EXPENSE_CONFIRM_OUTCOME_UNCERTAIN');
  const results=await scopeDb.batch<{version:number}>(statements);
  if(!stable()||results.length!==statements.length||results.some(result=>result.success!==true))throw new Error('EXPENSE_CONFIRM_OUTCOME_UNCERTAIN');
  // D1 meta.changes includes trigger side effects. Count the directly updated
  // source row so a committed confirmation is not mistaken for a CAS loss.
  const updated=results[1];
  if(updated?.success!==true||!Array.isArray(updated.results)||updated.results.length>1)throw new Error('EXPENSE_CONFIRM_OUTCOME_UNCERTAIN');
  if(updated.results.length===0)return null;
  const row=updated.results[0] as {expense_id?:unknown;version?:unknown};
  if(row.expense_id!==input.expenseId||!Number.isSafeInteger(row.version)||Number(row.version)<1)throw new Error('EXPENSE_CONFIRM_OUTCOME_UNCERTAIN');
  const version=Number(results[results.length-1]?.results?.[0]?.version);
  if(!Number.isSafeInteger(version)||version<1||version!==row.version)throw new Error("Expense confirmation committed without a valid sync version");
  return version;
}
