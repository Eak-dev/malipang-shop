import type {Env,SheetsSyncJob} from '../types';
import {newStableSourcePredicate} from '../sheets/stable-source-cutover';

/** Resumes only a capacity hold known to have sent no provider request. */
export async function resumeStableCapacity(env:Env,expenseId:string,version:number):Promise<void>{
 if(env.STABLE_PHASE1_ENABLED!=='true'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(expenseId)||!Number.isSafeInteger(version)||version<1)throw Error('STABLE_CAPACITY_RESUME_INVALID');
 const row=await env.DB.prepare("SELECT trace_id FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='REVIEW' AND last_error='STABLE_DAILY_CAPACITY'").bind(expenseId,version).first<{trace_id:string}>();if(!row)throw Error('STABLE_CAPACITY_NOT_FOUND');
 const result=await env.DB.prepare(`UPDATE sync_jobs SET status='PENDING',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,last_error=NULL WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='REVIEW' AND last_error='STABLE_DAILY_CAPACITY'
  AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=?)
  AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|'))
  AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED') AND ${newStableSourcePredicate('EXPENSE')}`)
  .bind(expenseId,version,env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SPREADSHEET_ID,expenseId,expenseId,expenseId,expenseId,version,expenseId).run();
 if(result.success!==true||Number(result.meta?.changes)!==1)throw Error('STABLE_CAPACITY_RESUME_UNVERIFIED');
 const job:SheetsSyncJob={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:expenseId,entityVersion:version,traceId:row.trace_id};
 // If sending is uncertain, the durable PENDING outbox remains eligible for
 // normal scheduled recovery; the operator must not replay a Google write.
 await env.JOB_QUEUE.send(job);
}
