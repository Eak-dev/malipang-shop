import { randomId } from "../shared/ids";
import type { Env } from "../types";

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
  if(!Number.isSafeInteger(snapshot.version)||snapshot.version<1)return null;
  const now=new Date().toISOString(),auditId=randomId("exp_audit");
  const documentGuard=documentSnapshot
    ? `AND EXISTS(SELECT 1 FROM expense_documents d WHERE d.document_id=? AND d.expense_id=e.expense_id
        AND d.line_user_id=e.line_user_id AND d.status='WAITING_CONFIRM' AND d.normalized_json IS ? AND d.updated_at IS ?)
       AND NOT EXISTS(SELECT 1 FROM expense_documents d WHERE d.expense_id=e.expense_id AND d.document_id<>?)`
    : `AND NOT EXISTS(SELECT 1 FROM expense_documents d WHERE d.expense_id=e.expense_id)`;
  const documentBindings=documentSnapshot
    ? [documentSnapshot.documentId,documentSnapshot.normalizedJson,documentSnapshot.updatedAt,documentSnapshot.documentId]
    : [];
  const statements=[
    env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,document_id,branch_id,reason,before_json,after_json,created_at)
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
    env.DB.prepare(`UPDATE expense_events SET status='CONFIRMED',reviewed_by_employee_id=?,approved_at=?,updated_at=?,
        version=(SELECT json_extract(after_json,'$.version') FROM expense_audit_log WHERE audit_id=?)
      WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'
        AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=? AND expense_id=expense_events.expense_id AND action='CONFIRM'
          AND json_extract(before_json,'$.version')=expense_events.version)`)
      .bind(input.actorEmployeeId,now,now,auditId,input.expenseId,input.lineUserId,auditId),
    env.DB.prepare(`UPDATE expense_documents SET status='CONFIRMED',updated_at=?
      WHERE expense_id=? AND status='WAITING_CONFIRM'
        AND EXISTS(SELECT 1 FROM expense_audit_log a JOIN expense_events e ON e.expense_id=a.expense_id
          WHERE a.audit_id=? AND a.action='CONFIRM' AND e.status='CONFIRMED' AND e.version=json_extract(a.after_json,'$.version'))`)
      .bind(now,input.expenseId,auditId)
  ];
  if(env.SHEETS_SYNC_ENABLED==="true")statements.push(
    env.DB.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token)
      SELECT ?,'EXPENSE',e.expense_id,e.version,?,'PENDING',0,?,?,NULL,NULL
      FROM expense_events e JOIN expense_audit_log a ON a.expense_id=e.expense_id
      WHERE a.audit_id=? AND a.action='CONFIRM' AND e.status='CONFIRMED' AND e.version=json_extract(a.after_json,'$.version')`)
      .bind(randomId("sync"),input.traceId,now,now,auditId)
  );
  statements.push(env.DB.prepare(`SELECT e.version FROM expense_events e JOIN expense_audit_log a ON a.expense_id=e.expense_id
    WHERE a.audit_id=? AND a.action='CONFIRM' AND e.status='CONFIRMED' AND e.version=json_extract(a.after_json,'$.version')`).bind(auditId));
  const results=await env.DB.batch<{version:number}>(statements);
  if(Number(results[1]?.meta.changes||0)!==1)return null;
  const version=Number(results[results.length-1]?.results?.[0]?.version);
  if(!Number.isSafeInteger(version)||version<1)throw new Error("Expense confirmation committed without a valid sync version");
  return version;
}
