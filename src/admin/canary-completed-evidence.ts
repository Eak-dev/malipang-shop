import type {Env} from '../types';

/** Read-only proof of this exact synthetic completion and retained fence. */
export const CANARY_COMPLETED_EVIDENCE_SQL=`SELECT c.expense_id,c.trace_id,w.operation_token claim_token,ep.epoch_id,r.revision source_revision,w.notice_stamp,w.notice_identity
 FROM continuous_canary_operator c
 JOIN expense_events e ON e.expense_id=c.expense_id AND e.status='CONFIRMED' AND e.version=1
 JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=c.expense_id AND j.entity_version=1 AND j.status='COMPLETED' AND j.lease_token IS NULL AND j.lease_until IS NULL
 JOIN stable_workbook_claims w ON w.spreadsheet_id=c.spreadsheet_id AND w.state='REVIEW' AND w.phase='OPERATION' AND w.review_reason='STABLE_EXPENSE_COMPLETION_UNCERTAIN'
 JOIN stable_recovery_epochs ep ON ep.spreadsheet_id=c.spreadsheet_id AND ep.state='ARMED' AND ep.target_type='EXPENSE' AND ep.target_key=c.expense_id AND ep.target_version=1
 JOIN stable_recovery_operations op ON op.epoch_id=ep.epoch_id AND op.operation_token=w.operation_token AND op.state='ADMITTED'
 JOIN stable_source_revision r ON r.singleton=1
 WHERE c.spreadsheet_id=? AND c.state='ARMED_CONFIRM' AND c.duplicate_epoch_id IS NULL AND e.description='[SYSTEM TEST] Synthetic expense - cancel after verification' AND e.amount_satang=100 AND e.trace_id=c.trace_id AND e.line_user_id=c.line_user_id
 AND EXISTS(SELECT 1 FROM sync_alert_incidents a WHERE a.kind='JOB' AND a.source_id=j.job_id AND a.state='CLOSED' AND a.closed_at=j.updated_at)
 AND (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND p.source_version=1 AND p.state='VERIFIED' AND ((p.entity_id=c.expense_id AND p.projection IN ('DAILY','EXPENSE_RAW')) OR (p.entity_id=c.expense_id||'|'||c.item_id AND p.projection='DETAIL')) AND EXISTS(SELECT 1 FROM stable_expense_projection_preimages i WHERE i.spreadsheet_id=p.spreadsheet_id AND i.entity_type=p.entity_type AND i.entity_id=p.entity_id AND i.projection=p.projection AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name AND i.source_version=p.source_version AND i.source_digest=p.source_digest) AND (SELECT count(*) FROM atomic_daily_marker_reservations m WHERE m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.operation_token=p.operation_token)=1)=3
 AND (SELECT count(*) FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=c.expense_id OR substr(p.entity_id,1,length(c.expense_id)+1)=c.expense_id||'|'))=3
 AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=c.expense_id OR substr(p.entity_id,1,length(c.expense_id)+1)=c.expense_id||'|'))
 AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=c.expense_id AND other.entity_version<>1)
 AND (SELECT count(*) FROM continuous_canary_operator)=1 AND (SELECT count(*) FROM stable_workbook_claims)=1 AND (SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW'))=1 AND (SELECT count(*) FROM stable_recovery_operations WHERE state='ADMITTED')=1
 AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='PROCESSING') AND NOT EXISTS(SELECT 1 FROM staff_config_sync_outbox WHERE status='PROCESSING') AND NOT EXISTS(SELECT 1 FROM stable_projection_writes WHERE state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED')
 AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||c.expense_id||':1' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')`;
export type CompletedCanaryEvidence={expense_id:string;trace_id:string;claim_token:string;epoch_id:string;source_revision:number;notice_stamp:string;notice_identity:string};
export async function readCompletedCanaryEvidence(env:Env):Promise<CompletedCanaryEvidence|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book)return null;
 const x=await db.prepare(CANARY_COMPLETED_EVIDENCE_SQL).bind(book).all<CompletedCanaryEvidence>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||x.success!==true||x.results?.length!==1)return null;
 const e=x.results[0]!;return /^exp_canary_[a-f0-9]{32}$/.test(e.expense_id)&&/^trace_canary_[a-f0-9]{32}$/.test(e.trace_id)&&Number.isSafeInteger(e.source_revision)&&e.source_revision>=0&&!!e.claim_token&&!!e.epoch_id&&!!e.notice_stamp&&!!e.notice_identity?e:null;
}
