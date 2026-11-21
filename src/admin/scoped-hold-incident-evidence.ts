import type {Env} from '../types';

/** Narrow proof for a held, cancelled expense; no absent-provider-write claim. */
export const SCOPED_HOLD_EVIDENCE_SQL=`SELECT j.job_id,j.entity_key expense_id,w.operation_token claim_token,r.revision source_revision,w.notice_stamp,w.notice_identity
 FROM stable_workbook_claims w JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_version=1 AND j.status='REVIEW' AND j.last_error='STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED' AND j.attempt_count=1 AND j.lease_token IS NULL AND j.lease_until IS NULL
 JOIN expense_events e ON e.expense_id=j.entity_key AND e.status='CANCELLED' AND e.version=2 JOIN stable_source_revision r ON r.singleton=1
 WHERE w.spreadsheet_id=? AND w.state='REVIEW' AND w.phase='OPERATION' AND w.review_reason='STABLE_EXPENSE_SOURCE_UNVERIFIED' AND w.notice_stamp IS NOT NULL AND w.notice_identity IS NOT NULL
 AND j.updated_at>=w.created_at AND j.updated_at<=w.updated_at AND (julianday(w.updated_at)-julianday(j.updated_at))*86400.0<2
 AND EXISTS(SELECT 1 FROM sync_alert_incidents a WHERE a.kind='JOB' AND a.source_id=j.job_id AND a.state='OPEN')
 AND EXISTS(SELECT 1 FROM sync_jobs u WHERE u.entity_type='EXPENSE' AND u.entity_key=j.entity_key AND u.entity_version=2 AND u.status='PENDING' AND u.attempt_count=0 AND u.lease_token IS NULL AND u.lease_until IS NULL)
 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|'))
 AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|'))
 AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=j.entity_key OR substr(i.entity_key,1,length(j.entity_key)+1)=j.entity_key||'|')
 AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key IN ('EXPENSE:'||j.entity_key||':1','EXPENSE:'||j.entity_key||':2'))
 AND (SELECT count(*) FROM stable_workbook_claims)=1 AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW'))
 AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='PROCESSING') AND NOT EXISTS(SELECT 1 FROM staff_config_sync_outbox WHERE status='PROCESSING')
 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes WHERE state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED')`;
export type ScopedHoldEvidence={job_id:string;expense_id:string;claim_token:string;source_revision:number;notice_stamp:string;notice_identity:string};
export async function readScopedHoldEvidence(env:Env,identityHash:string):Promise<ScopedHoldEvidence|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book||!/^[a-f0-9]{64}$/.test(identityHash))return null;
 const x=await db.prepare(SCOPED_HOLD_EVIDENCE_SQL).bind(book).all<ScopedHoldEvidence>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||x.success!==true||x.results?.length!==1)return null;
 const e=x.results[0]!;if(!e.job_id||!e.expense_id||!e.claim_token||!e.notice_stamp||!e.notice_identity||!Number.isSafeInteger(e.source_revision)||e.source_revision<0)return null;
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(e.claim_token+'\n'+e.job_id));const actual=Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
 return actual===identityHash&&env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book?e:null;
}
