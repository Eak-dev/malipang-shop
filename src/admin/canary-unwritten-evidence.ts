import type {Env} from '../types';
import {stableSourceIntegrity} from '../sheets/stable-source-cutover';
import {continuousAdmissionIntegrity,continuousDailyCutoverIntegrity,continuousReportCutoverIntegrity} from '../sheets/continuous-daily-cutover';

/** Private, in-memory evidence only. Never return this object from an HTTP
 * handler or include its identifiers or token in a log. This read does not
 * authorize any write, retry, claim release or provider mutation. */
export type CanaryUnwrittenEvidence={
 expense_id:string;document_id:string;item_id:string;line_user_id:string;trace_id:string;
 transaction_date:string;claim_token:string;notice_stamp:string;notice_identity:string;
 epoch_id:string;source_revision:number;expense_updated_at:string;job_updated_at:string;
};

// One SQL snapshot binds all of the matching operational state. Every value
// here is an exact precondition for this single synthetic v1 incident. A
// future mutation MUST re-run the proof in the same guarded transaction and
// separately settle and fence the provider notice; this SELECT is not a lock.
// Keep predicates grouped: D1 limits expression depth to 100, and this proof
// is also embedded inside guarded writes whose triggers increase that depth.
export const CANARY_UNWRITTEN_EVIDENCE_SQL=`SELECT c.expense_id,c.document_id,c.item_id,c.line_user_id,c.trace_id,c.transaction_date,
 w.operation_token AS claim_token,w.notice_stamp,w.notice_identity,r.epoch_id,rev.revision AS source_revision,
 e.updated_at AS expense_updated_at,j.updated_at AS job_updated_at
 FROM continuous_canary_operator c
 JOIN expense_events e ON e.expense_id=c.expense_id
 JOIN expense_documents d ON d.document_id=c.document_id AND d.expense_id=e.expense_id
 JOIN expense_document_items i ON i.item_id=c.item_id AND i.document_id=d.document_id AND i.expense_id=e.expense_id
 JOIN expense_document_links l ON l.document_id=d.document_id AND l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT'
 JOIN continuous_canary_confirm_attempts a ON a.spreadsheet_id=c.spreadsheet_id AND a.expense_id=c.expense_id AND a.document_id=c.document_id AND a.state='CONFIRMED'
 JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=1
 JOIN stable_workbook_claims w ON w.spreadsheet_id=c.spreadsheet_id
 JOIN stable_recovery_epochs r ON r.spreadsheet_id=c.spreadsheet_id AND r.target_type='EXPENSE' AND r.target_key=c.expense_id AND r.target_version=1 AND r.state='ARMED'
 JOIN stable_recovery_operations o ON o.epoch_id=r.epoch_id AND o.operation_token=w.operation_token AND o.state='ADMITTED'
 JOIN stable_source_revision rev ON rev.singleton=1

 WHERE (
  c.spreadsheet_id=?
  AND c.state='ARMED_CONFIRM'
  AND e.status='CONFIRMED'
  AND e.version=1
  AND e.description='[SYSTEM TEST] Synthetic expense - cancel after verification'
  AND e.amount_satang=100
  AND e.payment_key='transfer'
  AND e.source_wallet='SHOP_BANK'
 )
 AND (
  e.category='ingredients'
  AND e.line_user_id=c.line_user_id
  AND e.trace_id=c.trace_id
  AND e.transaction_date=c.transaction_date
  AND d.status='CONFIRMED'
  AND d.line_user_id=c.line_user_id
  AND d.trace_id=c.trace_id
  AND d.normalized_json=a.snapshot_normalized_json
 )
 AND (
  d.updated_at=e.updated_at
  AND i.description='[SYSTEM TEST] Synthetic item'
  AND i.line_total_satang=100
  AND j.status='REVIEW'
  AND j.last_error='STABLE_SYNC_REVIEW'
  AND j.lease_token IS NULL
  AND j.lease_until IS NULL
  AND w.state='REVIEW'
 )
 AND (
  w.phase='OPERATION'
  AND w.review_reason='INSERT_DAILY_PREFLIGHT_REPORT_HEALTH_FORMULA'
  AND w.notice_stamp IS NOT NULL
  AND w.notice_identity IS NOT NULL
  AND (SELECT count(*) FROM continuous_canary_operator)=1
  AND (SELECT count(*) FROM stable_workbook_claims)=1
  AND ${stableSourceIntegrity}
  AND ${continuousDailyCutoverIntegrity}
 )
 AND (
  ${continuousReportCutoverIntegrity}
  AND ${continuousAdmissionIntegrity}
  AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_canary_operator' AND name IN ('continuous_canary_no_delete','continuous_canary_no_replace','continuous_canary_transition'))=3
  AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('continuous_canary_confirm_insert','continuous_canary_confirm_no_delete','continuous_canary_confirm_no_replace','continuous_canary_confirm_transition','continuous_canary_confirm_recovery_fenced'))=5
  AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('stable_recovery_epoch_no_delete','stable_recovery_epoch_transition','stable_recovery_operation_no_delete','stable_recovery_operation_transition'))=4
  AND (SELECT count(*) FROM sqlite_master WHERE type='index' AND name='continuous_canary_one_open_confirm_attempt')=1
  AND (SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW'))=1
  AND (SELECT count(*) FROM stable_recovery_operations WHERE state='ADMITTED')=1
 )
 AND (
  (SELECT count(*) FROM continuous_daily_cutovers WHERE spreadsheet_id=c.spreadsheet_id AND state='ACTIVE')=1
  AND (SELECT count(*) FROM continuous_cutover_operator WHERE spreadsheet_id=c.spreadsheet_id AND state='COMPLETE')=1
  AND (SELECT count(*) FROM continuous_report_cutover_attempts WHERE spreadsheet_id=c.spreadsheet_id AND stage IN ('VIEWS','DAILY_J','REPORTS') AND state='VERIFIED')=3
  AND (SELECT count(*) FROM sync_jobs WHERE status='PROCESSING')=0
  AND (SELECT count(*) FROM staff_config_sync_outbox WHERE status='PROCESSING')=0
  AND (SELECT count(*) FROM stable_projection_writes WHERE state<>'VERIFIED')=0
  AND (SELECT count(*) FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED')=0
  AND (SELECT count(*) FROM expense_documents z WHERE z.expense_id=c.expense_id)=1
 )
 AND (
  (SELECT count(*) FROM expense_document_items z WHERE z.expense_id=c.expense_id)=1
  AND (SELECT count(*) FROM expense_document_links z WHERE z.expense_id=c.expense_id)=1
  AND (SELECT count(*) FROM sync_jobs z WHERE z.entity_type='EXPENSE' AND z.entity_key=c.expense_id)=1
  AND (SELECT count(*) FROM continuous_canary_confirm_attempts z WHERE z.spreadsheet_id=c.spreadsheet_id AND z.expense_id=c.expense_id AND z.state='CONFIRMED')=1
  AND (SELECT count(*) FROM continuous_canary_confirm_attempts z WHERE z.spreadsheet_id=c.spreadsheet_id AND z.expense_id=c.expense_id)=1
  AND EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses z WHERE z.spreadsheet_id=c.spreadsheet_id AND z.expense_id=c.expense_id)
  AND (SELECT count(*) FROM expense_audit_log z WHERE z.expense_id=c.expense_id AND z.document_id=c.document_id AND z.action='CONFIRM' AND z.actor_employee_id IS NULL AND z.branch_id IS NULL AND z.reason='' AND json_valid(z.before_json) AND json_valid(z.after_json) AND json_extract(z.before_json,'$.status')='WAITING_CONFIRM' AND json_extract(z.before_json,'$.version')=1 AND json_extract(z.after_json,'$.status')='CONFIRMED' AND json_extract(z.after_json,'$.version')=1 AND z.created_at=e.updated_at)=1
  AND (SELECT count(*) FROM expense_audit_log z WHERE z.expense_id=c.expense_id AND z.action='CONFIRM')=1
 )
 AND (
  NOT EXISTS(SELECT 1 FROM expense_audit_log z WHERE z.expense_id=c.expense_id AND z.action='UNDO')
  AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||c.expense_id||':1' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')
  AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=c.expense_id OR substr(p.entity_id,1,length(c.expense_id)+1)=c.expense_id||'|'))
  AND NOT EXISTS(SELECT 1 FROM stable_expense_projection_preimages p WHERE p.entity_type='EXPENSE' AND (p.entity_id=c.expense_id OR substr(p.entity_id,1,length(c.expense_id)+1)=c.expense_id||'|'))
  AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=c.expense_id OR substr(p.entity_id,1,length(c.expense_id)+1)=c.expense_id||'|'))
  AND NOT EXISTS(SELECT 1 FROM sheet_row_index z WHERE z.entity_key=c.expense_id OR substr(z.entity_key,1,length(c.expense_id)+1)=c.expense_id||'|')
  AND NOT EXISTS(SELECT 1 FROM atomic_daily_marker_reservations z WHERE z.entity_id=c.expense_id)
  AND NOT EXISTS(SELECT 1 FROM continuous_daily_write_evidence z WHERE z.entity_id=c.expense_id)
 )
 AND (
  NOT EXISTS(SELECT 1 FROM continuous_ledger_write_evidence z WHERE z.entity_id=c.expense_id OR substr(z.entity_id,1,length(c.expense_id)+1)=c.expense_id||'|')
  AND NOT EXISTS(SELECT 1 FROM continuous_publication_intents z WHERE z.entity_id=c.expense_id)
  AND NOT EXISTS(SELECT 1 FROM continuous_publication_markers z WHERE z.entity_id=c.expense_id)
 )`;

type EvidenceEnv=Env & {CONTINUOUS_CANARY_OPERATOR_ENABLED?:string};
export async function readCanaryUnwrittenEvidence(env:EvidenceEnv):Promise<CanaryUnwrittenEvidence|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const off=(x:string|undefined)=>x===undefined||x==='false';
 const flags=()=>env.STABLE_PHASE1_ENABLED==='true'&&env.STABLE_SHEETS_PACING_ENABLED==='true'&&env.STABLE_RECOVERY_GATE_ENABLED==='true'&&env.CONTINUOUS_CANARY_OPERATOR_ENABLED==='true'&&env.CONTINUOUS_DAILY_ENABLED==='true'&&env.SHEETS_SYNC_ENABLED==='true'&&off(env.CONTINUOUS_PUBLICATION_ENABLED)&&off(env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED);
 if(!book||!flags())return null;
 try{
  const r=await db.prepare(CANARY_UNWRITTEN_EVIDENCE_SQL).bind(book).all<CanaryUnwrittenEvidence>();
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||!flags()||r.success!==true||!Array.isArray(r.results)||r.results.length!==1)return null;
  const x=r.results[0]!;
  if(!/^exp_canary_[a-f0-9]{32}$/.test(x.expense_id)||!/^doc_canary_[a-f0-9]{32}$/.test(x.document_id)||!/^item_canary_[a-f0-9]{32}$/.test(x.item_id)||!/^CANARY_NO_LINE_[a-f0-9]{32}$/.test(x.line_user_id)||!/^trace_canary_[a-f0-9]{32}$/.test(x.trace_id)||!/^\d{4}-\d{2}-\d{2}$/.test(x.transaction_date)||typeof x.claim_token!=='string'||x.claim_token.length<8||typeof x.notice_stamp!=='string'||!x.notice_stamp||typeof x.notice_identity!=='string'||!x.notice_identity||typeof x.epoch_id!=='string'||!x.epoch_id||!Number.isSafeInteger(x.source_revision)||x.source_revision<0||typeof x.expense_updated_at!=='string'||!x.expense_updated_at||typeof x.job_updated_at!=='string'||!x.job_updated_at)return null;
  return x;
 }catch{return null;}
}
