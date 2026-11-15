import {STABLE_TERMINAL_HOLD} from './sheet-terminal-hold';
import type {Env,SheetsSyncJob} from '../types';
import {claimSheetSyncJob,ensureSheetSyncOutbox,syncJob,STABLE_NONFINANCIAL_COMPLETION_UNCERTAIN,type SheetSyncOutcome} from './sync';
import {newStableSourcePredicate} from './stable-source-cutover';
import {runStableExpenseJob} from './stable-expense-job';
import {runStablePersonalJob} from './stable-personal-job';
import {stableWorkbookInReview,withStableWorkbookClaim,STABLE_NOTICE_READ_DEFERRED,STABLE_NONFINANCIAL_JOB_CLOSED} from './stable-workbook-claim';
import {stableFaultReason} from './stable-fault';
import {stableRecoveryGateBlocked,STABLE_RECOVERY_BLOCKED} from './stable-recovery-admission';
import {STABLE_SHEETS_PACING_BLOCKED,STABLE_SHEETS_PACING_UNAVAILABLE,pacingPreflightBlocked,stablePacingConfigured} from './stable-sheet-pacing';
import {assertContinuousDailyActivated} from './continuous-daily-route';
import {runStableExpenseCancellationJob} from './stable-expense-cancellation-job';
import {recordCanaryDuplicateDelivery} from './canary-duplicate-receipt';
import {normalNoticeHandoffReady} from './continuous-normal-notice-handoff';

/** BLOCKED: the workbook claim awaits operator review. The durable outbox row
 * is kept unchanged and scheduled recovery re-sends it after the review. */
export type StablePhase1Outcome=SheetSyncOutcome|'REVIEW'|'BLOCKED'|'CONTINUE'|'DEFERRED';
export const isStableWorkbookBusy=(error:unknown):boolean=>error instanceof Error&&error.message==='STABLE_WORKBOOK_BUSY';
export const isStableWorkbookReview=(error:unknown):boolean=>error instanceof Error&&error.message==='STABLE_WORKBOOK_REVIEW';

/** Default-off routing. An old financial record is held, never sent through
 * its legacy numeric-row writer. Other workers share the workbook claim. */
export async function dispatchStablePhase1(env:Env,job:SheetsSyncJob,attempt=1):Promise<StablePhase1Outcome>{
 // Reject the unready experimental route before any outbox, lease, workbook
 // claim or legacy write can mutate a potentially mislabeled live binding.
 const dailyTarget=job.entityType==='EXPENSE'?await assertContinuousDailyActivated(env):null;
 if(env.STABLE_PHASE1_ENABLED!=='true')return syncJob(env,job,attempt);
 if(env.SHEETS_SYNC_ENABLED!=='true')return 'IGNORED';
 // Checked before taking a job lease, so a retained review neither spends an
 // attempt nor rewrites the job on every delivery.
 if(await stableWorkbookInReview(env)){await ensureSheetSyncOutbox(env,job);return 'BLOCKED';}
 if(await stableRecoveryGateBlocked(env,job)||await pacingPreflightBlocked(env)){await ensureSheetSyncOutbox(env,job);return 'BLOCKED';}
 // A deferred preflight has not touched Sheets in that invocation. Before
 // resuming, conservatively hold any prior attempts or projections until they
 // can be positively reverified; a missing row alone is not provider proof.
 if(job.entityType==='EXPENSE'&&env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED==='true'){
  const deferred=await env.DB.prepare("SELECT attempt_count FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PENDING' AND last_error='NORMAL_NOTICE_HANDOFF_NOT_READY'").bind(job.entityKey,job.entityVersion).first<{attempt_count:number}>();
  if(deferred&&await normalNoticeHandoffReady(env)){
   const prior=await env.DB.prepare(`SELECT 1 AS present WHERE ? > 0 OR EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|')) OR EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|')) OR EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=? OR substr(i.entity_key,1,length(?)+1)=?||'|') OR EXISTS(SELECT 1 FROM continuous_publication_intents i WHERE i.entity_id=?)`).bind(deferred.attempt_count,job.entityKey,job.entityKey,job.entityKey,job.entityKey,job.entityKey,job.entityKey,job.entityKey,job.entityKey,job.entityKey,job.entityKey).first<{present:number}>();
   if(prior){const held=await env.DB.prepare("UPDATE sync_jobs SET status='REVIEW',last_error='NORMAL_NOTICE_PRIOR_REVERIFY_REQUIRED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PENDING' AND last_error='NORMAL_NOTICE_HANDOFF_NOT_READY'").bind(job.entityKey,job.entityVersion).run();if(held.success!==true||!Number.isSafeInteger(held.meta?.changes))throw Error('NOTICE_PRIOR_HOLD_UNCERTAIN');return held.meta.changes===1?'REVIEW':'BUSY';}
  }
 }
 if(job.entityType!=='EXPENSE'&&job.entityType!=='PERSONAL_USE'){try{return await withStableWorkbookClaim(env,()=>syncJob(env,job,attempt),job);}catch(error){if(error instanceof Error&&error.message===STABLE_NONFINANCIAL_COMPLETION_UNCERTAIN)return 'REVIEW';if(error instanceof Error&&[STABLE_TERMINAL_HOLD,STABLE_NONFINANCIAL_JOB_CLOSED].includes(error.message))return 'BLOCKED';throw error;}}
 const lease=await claimSheetSyncJob(env,job);
 if(!lease){
  // A terminal financial record blocks the atomic lease CAS; ACK this
  // duplicate without requeueing or resolving the terminal event.
  const current=await env.DB.prepare(`SELECT s.status,EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=s.entity_type||':'||s.entity_key||':'||s.entity_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') AS terminal_hold FROM sync_jobs s WHERE s.entity_type=? AND s.entity_key=? AND s.entity_version=?`).bind(job.entityType,job.entityKey,job.entityVersion).first<{status:string;terminal_hold:number}>();
  if(Number(current?.terminal_hold)===1)return 'BLOCKED';
  if(current?.status==='COMPLETED'){await recordCanaryDuplicateDelivery(env,job);return 'IGNORED';}
  return current?.status==='REVIEW'?'REVIEW':'BUSY';
 }
 const hold=async(reason:string)=>{const r=await env.DB.prepare("UPDATE sync_jobs SET status='REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=? WHERE entity_type=? AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?").bind(reason,job.entityType,job.entityKey,job.entityVersion,lease).run();if(r.success!==true||Number(r.meta?.changes)!==1)throw Error('STABLE_JOB_HOLD_UNCERTAIN');};
 try{
  const eligible=await env.DB.prepare(`SELECT 1 AS ok WHERE ${newStableSourcePredicate(job.entityType)}`).bind(job.entityKey).first<{ok:number}>();
  if(!eligible){await hold('STABLE_HISTORICAL_OR_SOURCE_REVIEW');return 'REVIEW';}
  if(job.entityType==='EXPENSE'){
   const current=dailyTarget?await env.DB.prepare("SELECT status,version FROM expense_events WHERE expense_id=?").bind(job.entityKey).first<{status:string;version:number}>():null;
   const result=dailyTarget&&current?.status==='CANCELLED'&&current.version===job.entityVersion
    ?await runStableExpenseCancellationJob(env,job,lease):await runStableExpenseJob(env,job,lease);
   return result==='COMPLETED'?'PROCESSED':result==='CONTINUE'?(stablePacingConfigured(env)?'CONTINUE':'BUSY'):'REVIEW';
  }
  await runStablePersonalJob(env,job,lease);return 'PROCESSED';
 }catch(error){
  if(error instanceof Error&&error.message===STABLE_TERMINAL_HOLD){return 'BLOCKED';}
  // The handoff readiness check happens before this invocation acquires a
  // workbook claim or sends a Sheets request. Earlier projections may exist,
  // so retain the expense and report the exact failure rather than cancel it.
  if(error instanceof Error&&error.message==='NORMAL_NOTICE_HANDOFF_NOT_READY'){
   const r=await env.DB.batch([
    env.DB.prepare("UPDATE sync_jobs SET status='PENDING',attempt_count=CASE WHEN attempt_count>0 THEN attempt_count-1 ELSE 0 END,last_error='NORMAL_NOTICE_HANDOFF_NOT_READY',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND attempt_count>=1").bind(job.entityKey,job.entityVersion,lease),
    env.DB.prepare("INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at) SELECT 'JOB',j.job_id,'REVIEW','OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=? AND j.entity_version=? AND j.status='PENDING' AND j.last_error='NORMAL_NOTICE_HANDOFF_NOT_READY' AND changes()=1 AND NOT EXISTS(SELECT 1 FROM sync_alert_incidents i WHERE i.kind='JOB' AND i.source_id=j.job_id AND i.state='OPEN') ON CONFLICT DO NOTHING").bind(job.entityKey,job.entityVersion),
    env.DB.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM sync_jobs j JOIN sync_alert_incidents i ON i.kind='JOB' AND i.source_id=j.job_id AND i.state='OPEN' WHERE j.entity_type='EXPENSE' AND j.entity_key=? AND j.entity_version=? AND j.status='PENDING' AND j.last_error='NORMAL_NOTICE_HANDOFF_NOT_READY') THEN 1 ELSE json_extract('invalid-json','$') END AS ok").bind(job.entityKey,job.entityVersion)
   ]);
   if(r.length!==3||r.some(x=>x.success!==true)||r[0]!.meta?.changes!==1)throw Error('NORMAL_NOTICE_DEFER_UNCERTAIN');return 'DEFERRED';
  }
  if(error instanceof Error&&[STABLE_RECOVERY_BLOCKED,STABLE_SHEETS_PACING_BLOCKED,STABLE_SHEETS_PACING_UNAVAILABLE,STABLE_NOTICE_READ_DEFERRED].includes(error.message)){
   const r=await env.DB.prepare("UPDATE sync_jobs SET status='PENDING',attempt_count=CASE WHEN attempt_count>0 THEN attempt_count-1 ELSE 0 END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=? WHERE entity_type=? AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND attempt_count>=1").bind(error.message,job.entityType,job.entityKey,job.entityVersion,lease).run();
   if(r.success!==true||Number(r.meta?.changes)!==1)throw Error('STABLE_RECOVERY_DEFER_UNCERTAIN');
   return [STABLE_SHEETS_PACING_BLOCKED,STABLE_NOTICE_READ_DEFERRED].includes(error.message)?'BUSY':'BLOCKED';
  }
  const busy=isStableWorkbookBusy(error),review=isStableWorkbookReview(error);
  if(busy||review){
   const r=await env.DB.prepare("UPDATE sync_jobs SET status='PENDING',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=? WHERE entity_type=? AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?").bind(busy?'STABLE_WORKBOOK_BUSY':'STABLE_WORKBOOK_REVIEW',job.entityType,job.entityKey,job.entityVersion,lease).run();
   if(r.success!==true||Number(r.meta?.changes)!==1)throw Error('STABLE_JOB_RELEASE_UNCERTAIN');return busy?'BUSY':'BLOCKED';
  }
  // A failed provider or D1 acknowledgement holds the workbook claim. Only
  // this owned job is moved to review; no request is automatically replayed.
  console.error('stable-sync-review',{entityType:job.entityType,reason:stableFaultReason(error)});
  const current=await env.DB.prepare('SELECT status FROM sync_jobs WHERE entity_type=? AND entity_key=? AND entity_version=?').bind(job.entityType,job.entityKey,job.entityVersion).first<{status:string}>();
  if(current?.status==='PROCESSING')await hold('STABLE_SYNC_REVIEW');
  return 'REVIEW';
 }
}
