import type {Env} from '../types';

/**
 * Read-only diagnostic for ONE expense and workbook. It is deliberately not a
 * release decision: a database snapshot cannot prove the outcome of a Sheets
 * request or fence a legacy/human writer. Never use it to authorize a retry.
 */
export type StableRecoveryPreview = {
  disposition: 'HOLD' | 'PROVIDER_RECONCILIATION_REQUIRED' | 'UNAVAILABLE';
  reasons: string[];
  journal: { verified: number; inFlight: number; review: number } | null;
};
type Snapshot = {
  job_status: string | null; source_status: string | null; source_version: number | null;
  claim_state: string | null; recovery_state: string | null; admitted: number;
  terminal: number; verified: number; inflight: number; review: number;
  cutover: string | null; historical: number;
};
const unavailable = (reason: string): StableRecoveryPreview => ({disposition:'UNAVAILABLE',reasons:[reason],journal:null});

export async function previewExpenseRecovery(env:Env, target:{expenseId:string;version:number}):Promise<StableRecoveryPreview> {
  const book=env.GOOGLE_SPREADSHEET_ID;
  if(typeof book!=='string'||!book.trim()||typeof target?.expenseId!=='string'||!target.expenseId||target.expenseId.length>256||target.expenseId.includes('|')||!Number.isSafeInteger(target.version)||target.version<1)
    return unavailable('INVALID_TARGET');
  try {
    // A single statement gives a coherent database snapshot. No identifiers,
    // error strings, receipt fields or provider credentials are returned.
    const row=await env.DB.prepare(`WITH target(book,id,version) AS (VALUES(?,?,?))
      SELECT
      (SELECT status FROM sync_jobs j,target t WHERE j.entity_type='EXPENSE' AND j.entity_key=t.id AND j.entity_version=t.version) job_status,
      (SELECT status FROM expense_events e,target t WHERE e.expense_id=t.id) source_status,
      (SELECT e.version FROM expense_events e,target t WHERE e.expense_id=t.id) source_version,
      (SELECT state FROM stable_workbook_claims c,target t WHERE c.spreadsheet_id=t.book) claim_state,
      (SELECT state FROM stable_recovery_epochs r,target t WHERE r.spreadsheet_id=t.book AND r.state IN ('ARMED','REVIEW')) recovery_state,
      (SELECT count(*) FROM stable_recovery_operations o JOIN stable_recovery_epochs r ON r.epoch_id=o.epoch_id,target t WHERE r.spreadsheet_id=t.book AND o.state='ADMITTED') admitted,
      (SELECT count(*) FROM failed_jobs f,target t WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||t.id||':'||CAST(t.version AS INTEGER) AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') terminal,
      (SELECT count(*) FROM stable_projection_writes p,target t WHERE p.spreadsheet_id=t.book AND p.entity_type='EXPENSE' AND (p.entity_id=t.id OR substr(p.entity_id,1,length(t.id)+1)=t.id||'|') AND p.state='VERIFIED') verified,
      (SELECT count(*) FROM stable_projection_writes p,target t WHERE p.spreadsheet_id=t.book AND p.entity_type='EXPENSE' AND (p.entity_id=t.id OR substr(p.entity_id,1,length(t.id)+1)=t.id||'|') AND p.state='IN_FLIGHT') inflight,
      (SELECT count(*) FROM stable_projection_writes p,target t WHERE p.spreadsheet_id=t.book AND p.entity_type='EXPENSE' AND (p.entity_id=t.id OR substr(p.entity_id,1,length(t.id)+1)=t.id||'|') AND p.state='REVIEW') review,
      (SELECT state FROM stable_sync_cutover WHERE singleton=1) cutover,
      (SELECT count(*) FROM stable_pre_cutover_sources s,target t WHERE s.entity_type='EXPENSE' AND s.entity_id=t.id) historical`).bind(book,target.expenseId,target.version).first<Snapshot>();
    if(!row || !['admitted','terminal','verified','inflight','review','historical'].every(k=>Number.isSafeInteger(row[k as keyof Snapshot]) && Number(row[k as keyof Snapshot])>=0)
       || ![null,'HELD','REVIEW'].includes(row.claim_state) || ![null,'ARMED','REVIEW'].includes(row.recovery_state)
       || ![null,'PREPARED','ACTIVE'].includes(row.cutover)
       || ![null,'PENDING','PROCESSING','FAILED','REVIEW','COMPLETED'].includes(row.job_status)
       || (row.source_status!==null && (typeof row.source_status!=='string'||!Number.isSafeInteger(row.source_version)||Number(row.source_version)<1))) return unavailable('READ_UNVERIFIED');
    const reasons:string[]=[];
    if(!row.job_status) reasons.push('JOB_NOT_FOUND');
    else if(row.job_status!=='PENDING') reasons.push(`JOB_${row.job_status}`);
    if(!row.source_status) reasons.push('SOURCE_NOT_FOUND');
    else {
      if(row.source_status!=='CONFIRMED') reasons.push('SOURCE_NOT_CONFIRMED');
      if(row.source_version!==target.version) reasons.push('SOURCE_VERSION_CHANGED');
    }
    if(row.claim_state) reasons.push(`WORKBOOK_${row.claim_state}`);
    if(row.recovery_state) reasons.push(`RECOVERY_${row.recovery_state}`);
    if(row.admitted) reasons.push('UNVERIFIED_OPERATION');
    if(row.terminal) reasons.push('OPEN_TERMINAL');
    if(row.inflight) reasons.push('PROJECTION_IN_FLIGHT');
    if(row.review) reasons.push('PROJECTION_REVIEW');
    if(row.cutover!=='ACTIVE') reasons.push('CUTOVER_UNVERIFIED');
    if(row.historical) reasons.push('HISTORICAL_SOURCE');
    // Even if no DB blockers are visible, the provider must be independently
    // reconciled and concurrency fenced; this result NEVER authorizes a write.
    reasons.push('PROVIDER_RECONCILIATION_REQUIRED');
    return {disposition:reasons.length>1?'HOLD':'PROVIDER_RECONCILIATION_REQUIRED',reasons,journal:{verified:row.verified,inFlight:row.inflight,review:row.review}};
  } catch { return unavailable('READ_UNVERIFIED'); }
}
