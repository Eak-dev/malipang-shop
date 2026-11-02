import type {Env,SheetsSyncJob} from '../types';
import {assertStableShadowConfig,assertStableShadowDatabase,writeDailyStableShadow} from './daily-stable-row-shadow';
import {classifyStableShadowSource} from './daily-stable-cutover';
import {SyntheticExpenseProjectionJournal,type SyntheticProjection} from './synthetic-expense-projection-journal';
import {loadExpenseDailyPosting} from './sync';

/** A trusted in-process fixture adapter must independently check its Sheets
 * readback and its own dispatch fence. Its returned digest is a journal marker,
 * not independently verified proof. No request may supply these callbacks. */
export type SyntheticProjectionAdapters=Partial<Record<SyntheticProjection,()=>Promise<string>>>;
export type SyntheticWorkflowResult='VERIFIED'|'REVIEW'|'BUSY';

/** Isolated UAT only. A missing, failed, ambiguous or prior in-flight
 * projection is never retried blindly; the durable outbox is held for review.
 * The caller must provide a pre-existing synthetic expense and outbox. */
export async function runSyntheticExpenseWorkflow(env:Env,job:SheetsSyncJob,adapters:SyntheticProjectionAdapters):Promise<SyntheticWorkflowResult>{
  if(job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<1)throw new Error('SYNTHETIC_WORKFLOW_INVALID');
  assertStableShadowConfig(env,job.entityKey);await assertStableShadowDatabase(env);
  const existing=await env.DB.prepare(`SELECT status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=?`).bind(job.entityKey,job.entityVersion).first<{status:string}>();
  if(!existing)throw new Error('SYNTHETIC_WORKFLOW_OUTBOX_MISSING');
  if(existing.status==='REVIEW'||existing.status==='COMPLETED')return 'REVIEW';
  const now=new Date().toISOString(),lease=crypto.randomUUID();
  const claim=await env.DB.prepare(`UPDATE sync_jobs SET status='PROCESSING',attempt_count=attempt_count+1,updated_at=?,next_attempt_at=NULL,lease_until=?,lease_token=?,last_error=NULL
    WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status IN ('PENDING','FAILED') AND (next_attempt_at IS NULL OR next_attempt_at<=?)
    AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=? AND j.status IN ('PROCESSING','REVIEW'))
    AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES' AND substr(f.job_key,1,length(sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':'))=sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':')`).bind(now,new Date(Date.now()+15*60_000).toISOString(),lease,job.entityKey,job.entityVersion,now,job.entityKey).run();
  if(Number(claim.meta.changes||0)!==1)return 'BUSY';
  const journal=new SyntheticExpenseProjectionJournal(env,job,lease);
  const hold=async()=>{const r=await env.DB.prepare(`UPDATE sync_jobs SET status='REVIEW',updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error='SYNTHETIC_WORKFLOW_REVIEW_REQUIRED' WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?`).bind(new Date().toISOString(),job.entityKey,job.entityVersion,lease).run();if(Number(r.meta.changes||0)!==1)throw new Error('SYNTHETIC_WORKFLOW_OUTBOX_OWNERSHIP_LOST');};
  try{
    for(const projection of ['DAILY','RAW','DETAIL'] as const){
      const eligible=await classifyStableShadowSource(env,job.entityKey,job.entityVersion);if(eligible.kind==='REVIEW'||!adapters[projection]){await hold();return 'REVIEW';}
      const token=await journal.begin(projection);if(!token){await hold();return 'REVIEW';}
      try{const evidence=await adapters[projection]!();if(!await journal.verify(projection,token,evidence)){await journal.hold(projection,token);await hold();return 'REVIEW';}}
      catch{await journal.hold(projection,token);await hold();return 'REVIEW';}
    }
    if(!await journal.complete()){await hold();return 'REVIEW';}
    return 'VERIFIED';
  }catch(error){await hold();throw error;}
}

/** Real daily adapter only. RAW and DETAIL are intentionally unavailable until
 * a trusted Google reader, enrollment/append and complete source proof exist. */
export async function runSyntheticDailyOnlyWorkflow(env:Env,job:SheetsSyncJob):Promise<SyntheticWorkflowResult>{
  return runSyntheticExpenseWorkflow(env,job,{DAILY:async()=>{
    const loaded=await loadExpenseDailyPosting(env,job.entityKey);
    if(loaded.expense.status!=='CONFIRMED'||loaded.record.version!==job.entityVersion)throw new Error('SYNTHETIC_WORKFLOW_SOURCE_CHANGED');
    await writeDailyStableShadow(env,loaded.record);
    const bytes=new TextEncoder().encode(JSON.stringify(['synthetic-daily-readback',job.entityKey,job.entityVersion]));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  }});
}
