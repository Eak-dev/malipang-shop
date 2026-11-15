import {randomId} from "../shared/ids";
import type {Env} from "../types";

export interface UndoInput{
  expenseId:string;lineUserId:string;traceId:string;
  actorEmployeeId:string|null;branchId:string|null;
}

/**
 * Reserve the transition with a private audit token inside one D1 transaction.
 * An admin correction may already have consumed v2 (or later), so fixed Undo
 * versions are not safe. Preserve every old job and allocate beyond both the
 * business version and the existing outbox high-water mark while holding the
 * transaction. A failed audit/document/outbox statement rolls everything back.
 */
export async function undoConfirmedExpense(env:Env,input:UndoInput,options?:{auditId:string;pendingRequestId?:string;expectedVersion?:number}):Promise<number|null>{
  const now=new Date().toISOString(),auditId=options?.auditId??randomId("exp_audit");
  if(options?.pendingRequestId&&env.SHEETS_SYNC_ENABLED!=="true")throw Error("DEFERRED_UNDO_SYNC_DISABLED");
  const statements=[
    env.DB.prepare(`INSERT INTO expense_audit_log(audit_id,actor_employee_id,action,expense_id,branch_id,reason,before_json,after_json,created_at)
      SELECT ?,?,'UNDO',expense_id,?,'',json_object('status',status,'version',version),
        json_object('status','CANCELLED','version',MAX(version,COALESCE((SELECT MAX(entity_version) FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=expense_events.expense_id),0))+1),?
      FROM expense_events WHERE expense_id=? AND line_user_id=? AND status='CONFIRMED' AND (? IS NULL OR version=?)
        AND (? IS NULL OR EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=expense_events.expense_id AND j.entity_version=expense_events.version))`)
      .bind(auditId,input.actorEmployeeId,input.branchId,now,input.expenseId,input.lineUserId,options?.expectedVersion??null,options?.expectedVersion??null,options?.pendingRequestId??null),
    env.DB.prepare(`UPDATE expense_events SET status='CANCELLED',updated_at=?,
        version=(SELECT json_extract(after_json,'$.version') FROM expense_audit_log WHERE audit_id=?)
      WHERE expense_id=? AND line_user_id=? AND status='CONFIRMED'
        AND EXISTS(SELECT 1 FROM expense_audit_log WHERE audit_id=? AND expense_id=expense_events.expense_id AND action='UNDO'
          AND json_extract(before_json,'$.version')=expense_events.version)`)
      .bind(now,auditId,input.expenseId,input.lineUserId,auditId),
    env.DB.prepare(`UPDATE expense_documents SET status='CANCELLED',updated_at=?
      WHERE expense_id=? AND status='CONFIRMED'
        AND EXISTS(SELECT 1 FROM expense_audit_log a JOIN expense_events e ON e.expense_id=a.expense_id
          WHERE a.audit_id=? AND a.action='UNDO' AND e.status='CANCELLED' AND e.version=json_extract(a.after_json,'$.version'))`)
      .bind(now,input.expenseId,auditId)
  ];
  if(options?.pendingRequestId){
    statements.splice(1,0,env.DB.prepare("INSERT INTO continuous_pending_undo_apply_auth(request_id,audit_id,created_at) SELECT ?,?,? WHERE changes()=1").bind(options.pendingRequestId,auditId,now));
  }
  if(env.SHEETS_SYNC_ENABLED==="true")statements.push(
    env.DB.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token)
      SELECT ?,'EXPENSE',e.expense_id,e.version,?,'PENDING',0,?,?,NULL,NULL
      FROM expense_events e JOIN expense_audit_log a ON a.expense_id=e.expense_id
      WHERE a.audit_id=? AND a.action='UNDO' AND e.status='CANCELLED' AND e.version=json_extract(a.after_json,'$.version')`)
      .bind(randomId("sync"),input.traceId,now,now,auditId)
  );
  if(options?.pendingRequestId){
    statements.push(env.DB.prepare(`UPDATE continuous_pending_undo SET state='APPLIED',audit_id=?,cancelled_version=(SELECT version FROM expense_events WHERE expense_id=?),updated_at=? WHERE request_id=? AND expense_id=? AND source_version=? AND state='PENDING' AND EXISTS(SELECT 1 FROM expense_audit_log a JOIN expense_events e ON e.expense_id=a.expense_id WHERE a.audit_id=? AND e.expense_id=continuous_pending_undo.expense_id AND e.status='CANCELLED' AND e.version=json_extract(a.after_json,'$.version'))`).bind(auditId,input.expenseId,now,options.pendingRequestId,input.expenseId,options.expectedVersion,auditId));
    statements.push(env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok"));
    // Only resolve this request's own incident; a JOB incident may represent
    // a different, still-unresolved sync error for the same expense.
    statements.push(env.DB.prepare("UPDATE sync_alert_incidents SET state='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='JOB' AND source_id='DEFERRED_UNDO_RETRY:'||? AND state='OPEN'").bind(options.pendingRequestId));
  }
  statements.push(env.DB.prepare(`SELECT e.version FROM expense_events e JOIN expense_audit_log a ON a.expense_id=e.expense_id
    WHERE a.audit_id=? AND a.action='UNDO' AND e.status='CANCELLED' AND e.version=json_extract(a.after_json,'$.version')`).bind(auditId));
  const results=await env.DB.batch<{version:number}>(statements);
  if(Number(results[options?.pendingRequestId?2:1]?.meta.changes||0)!==1)return null;
  const version=Number(results[results.length-1]?.results?.[0]?.version);
  if(!Number.isSafeInteger(version)||version<1)throw new Error("Expense Undo committed without a valid sync version");
  return version;
}
