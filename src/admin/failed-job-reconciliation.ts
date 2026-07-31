import type { Env } from "../types";

export type FailedJobReconciliationOutcome=
  | "ATTENDANCE_COMMITTED"
  | "EXPENSE_COMMITTED"
  | "EXPENSE_DOCUMENT_COMMITTED"
  | "TEXT_NO_BUSINESS_TRANSACTION"
  | "IMAGE_RESUBMISSION_REQUIRED"
  | "SMOKE_NOTIFICATION_EXHAUSTED"
  | "NOTIFICATION_REVIEW_REQUIRED"
  | "UNSUPPORTED_REVIEW_REQUIRED";

export interface HistoricalFailedJobFacts {
  kind:string;
  messageType:string;
  purpose:string;
  hasAttendance:boolean;
  hasExpense:boolean;
  hasDocument:boolean;
}

export interface FailedJobReconciliationDecision {
  outcome:FailedJobReconciliationOutcome;
  resolved:boolean;
  reason:string;
}

/**
 * Historical DLQ work is never blindly replayed.  Some old replies failed
 * after the business transaction committed, while a stale image may no
 * longer be retrievable from LINE.  This classifier records that distinction
 * without fabricating a replacement transaction.
 */
export function classifyHistoricalFailedJob(facts:HistoricalFailedJobFacts):FailedJobReconciliationDecision {
  if(facts.kind==="LINE_NOTIFICATION"){
    if(facts.purpose==="ATTENDANCE_SMOKE")return {
      outcome:"SMOKE_NOTIFICATION_EXHAUSTED",resolved:true,
      reason:"A non-business smoke notification exhausted delivery retries; no attendance or expense transaction was created."
    };
    return {
      outcome:"NOTIFICATION_REVIEW_REQUIRED",resolved:false,
      reason:"A business notification has no safe generic replay path and requires an operator review."
    };
  }
  if(facts.kind!=="LINE_EVENT")return {
    outcome:"UNSUPPORTED_REVIEW_REQUIRED",resolved:false,
    reason:"This failed job kind is outside the historical inbound reconciliation scope."
  };
  if(facts.hasAttendance)return {
    outcome:"ATTENDANCE_COMMITTED",resolved:true,
    reason:"The attendance business record exists; only a historical downstream delivery/retry failure remains."
  };
  if(facts.hasExpense)return {
    outcome:"EXPENSE_COMMITTED",resolved:true,
    reason:"The expense business record exists; no replacement Expense may be created during reconciliation."
  };
  if(facts.hasDocument)return {
    outcome:"EXPENSE_DOCUMENT_COMMITTED",resolved:true,
    reason:"The reviewable expense document exists without a finalized duplicate transaction."
  };
  if(facts.messageType==="text")return {
    outcome:"TEXT_NO_BUSINESS_TRANSACTION",resolved:true,
    reason:"No Attendance, Expense, or document record was created from this historical text input."
  };
  if(facts.messageType==="image")return {
    outcome:"IMAGE_RESUBMISSION_REQUIRED",resolved:true,
    reason:"No business record or retained evidence is available for safe replay; a new submission is required instead of fabricating a transaction."
  };
  return {
    outcome:"UNSUPPORTED_REVIEW_REQUIRED",resolved:false,
    reason:"This historical inbound event has no deterministic, non-destructive reconciliation outcome."
  };
}

interface FailedJobRow {
  id:unknown;
  kind:unknown;
  message_type:unknown;
  purpose:unknown;
  has_attendance:unknown;
  has_expense:unknown;
  has_document:unknown;
}

function string(value:unknown):string{return typeof value==="string"?value:"";}
function bool(value:unknown):boolean{return Number(value)===1||value===true;}
function validIso(value:string):boolean{return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)&&Number.isFinite(Date.parse(value));}

export interface ReconcileHistoricalFailedJobsInput { createdBefore:string; dryRun?:boolean; }
export interface ReconcileHistoricalFailedJobsResult {
  scanned:number;
  reconciled:number;
  requiresResubmission:number;
  requiresManualReview:number;
  outcomes:Record<string,number>;
}

export async function reconcileHistoricalFailedJobs(env:Env,input:ReconcileHistoricalFailedJobsInput):Promise<ReconcileHistoricalFailedJobsResult> {
  if(!validIso(input.createdBefore))throw new Error("createdBefore must be a UTC ISO timestamp");
  const rows=await env.DB.prepare(`
    SELECT f.id,
      json_extract(f.payload_json,'$.kind') AS kind,
      json_extract(f.payload_json,'$.event.message.type') AS message_type,
      json_extract(f.payload_json,'$.purpose') AS purpose,
      EXISTS(SELECT 1 FROM attendance_events a WHERE a.message_id=json_extract(f.payload_json,'$.event.message.id')) AS has_attendance,
      EXISTS(SELECT 1 FROM expense_events e WHERE e.message_id=json_extract(f.payload_json,'$.event.message.id')) AS has_expense,
      EXISTS(SELECT 1 FROM expense_documents d WHERE d.message_id=json_extract(f.payload_json,'$.event.message.id')) AS has_document
    FROM failed_jobs f
    WHERE f.queue_name='malipang-jobs'
      AND f.status='OPEN'
      AND f.created_at<=?
      AND NOT EXISTS(SELECT 1 FROM failed_job_reconciliations r WHERE r.failed_job_id=f.id)
    ORDER BY f.created_at,f.id
    LIMIT 100
  `).bind(input.createdBefore).all<FailedJobRow>();
  const result:ReconcileHistoricalFailedJobsResult={scanned:0,reconciled:0,requiresResubmission:0,requiresManualReview:0,outcomes:{}};
  for(const row of rows.results||[]){
    const decision=classifyHistoricalFailedJob({
      kind:string(row.kind),messageType:string(row.message_type),purpose:string(row.purpose),
      hasAttendance:bool(row.has_attendance),hasExpense:bool(row.has_expense),hasDocument:bool(row.has_document)
    });
    result.scanned+=1;
    result.outcomes[decision.outcome]=(result.outcomes[decision.outcome]||0)+1;
    if(decision.outcome==="IMAGE_RESUBMISSION_REQUIRED")result.requiresResubmission+=1;
    if(!decision.resolved){result.requiresManualReview+=1;continue;}
    if(input.dryRun)continue;
    const now=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO failed_job_reconciliations(reconciliation_id,failed_job_id,outcome,reason,reconciled_by,reconciled_at) VALUES(?,?,?,?,?,?) ON CONFLICT(failed_job_id) DO NOTHING`).bind(crypto.randomUUID(),String(row.id),decision.outcome,decision.reason,"SYSTEM_V1_CLOSEOUT",now),
      env.DB.prepare(`UPDATE failed_jobs SET status='RESOLVED',resolved_at=?,updated_at=? WHERE id=? AND status='OPEN'`).bind(now,now,String(row.id))
    ]);
    result.reconciled+=1;
  }
  return result;
}
