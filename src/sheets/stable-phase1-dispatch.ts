import type {Env,SheetsSyncJob} from '../types';
import {claimSheetSyncJob,ensureSheetSyncOutbox,syncJob,type SheetSyncOutcome} from './sync';
import {newStableSourcePredicate} from './stable-source-cutover';
import {runStableExpenseJob} from './stable-expense-job';
import {runStablePersonalJob} from './stable-personal-job';
import {stableWorkbookInReview,withStableWorkbookClaim,STABLE_NOTICE_READ_DEFERRED} from './stable-workbook-claim';
import {stableFaultReason} from './stable-fault';
import {stableRecoveryGateBlocked,STABLE_RECOVERY_BLOCKED} from './stable-recovery-admission';
import {STABLE_SHEETS_PACING_BLOCKED,STABLE_SHEETS_PACING_UNAVAILABLE,pacingPreflightBlocked,stablePacingConfigured} from './stable-sheet-pacing';

/** BLOCKED: the workbook claim awaits operator review. The durable outbox row
 * is kept unchanged and scheduled recovery re-sends it after the review. */
export type StablePhase1Outcome=SheetSyncOutcome|'REVIEW'|'BLOCKED'|'CONTINUE';
export const isStableWorkbookBusy=(error:unknown):boolean=>error instanceof Error&&error.message==='STABLE_WORKBOOK_BUSY';
export const isStableWorkbookReview=(error:unknown):boolean=>error instanceof Error&&error.message==='STABLE_WORKBOOK_REVIEW';

/** Default-off routing. An old financial record is held, never sent through
 * its legacy numeric-row writer. Other workers share the workbook claim. */
export async function dispatchStablePhase1(env:Env,job:SheetsSyncJob,attempt=1):Promise<StablePhase1Outcome>{
 if(env.STABLE_PHASE1_ENABLED!=='true')return syncJob(env,job,attempt);
 if(env.SHEETS_SYNC_ENABLED!=='true')return 'IGNORED';
 // Checked before taking a job lease, so a retained review neither spends an
 // attempt nor rewrites the job on every delivery.
 if(await stableWorkbookInReview(env)){await ensureSheetSyncOutbox(env,job);return 'BLOCKED';}
 if(await stableRecoveryGateBlocked(env,job)||await pacingPreflightBlocked(env)){await ensureSheetSyncOutbox(env,job);return 'BLOCKED';}
 if(job.entityType!=='EXPENSE'&&job.entityType!=='PERSONAL_USE')return withStableWorkbookClaim(env,()=>syncJob(env,job,attempt),job);
 const lease=await claimSheetSyncJob(env,job);
 if(!lease){const current=await env.DB.prepare('SELECT status FROM sync_jobs WHERE entity_type=? AND entity_key=? AND entity_version=?').bind(job.entityType,job.entityKey,job.entityVersion).first<{status:string}>();return current?.status==='REVIEW'?'REVIEW':current?.status==='COMPLETED'?'IGNORED':'BUSY';}
 const hold=async(reason:string)=>{const r=await env.DB.prepare("UPDATE sync_jobs SET status='REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=? WHERE entity_type=? AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?").bind(reason,job.entityType,job.entityKey,job.entityVersion,lease).run();if(r.success!==true||Number(r.meta?.changes)!==1)throw Error('STABLE_JOB_HOLD_UNCERTAIN');};
 try{
  const eligible=await env.DB.prepare(`SELECT 1 AS ok WHERE ${newStableSourcePredicate(job.entityType)}`).bind(job.entityKey).first<{ok:number}>();
  if(!eligible){await hold('STABLE_HISTORICAL_OR_SOURCE_REVIEW');return 'REVIEW';}
  if(job.entityType==='EXPENSE'){const result=await runStableExpenseJob(env,job,lease);return result==='COMPLETED'?'PROCESSED':result==='CONTINUE'?(stablePacingConfigured(env)?'CONTINUE':'BUSY'):'REVIEW';}
  await runStablePersonalJob(env,job,lease);return 'PROCESSED';
 }catch(error){
  if(error instanceof Error&&[STABLE_RECOVERY_BLOCKED,STABLE_SHEETS_PACING_BLOCKED,STABLE_SHEETS_PACING_UNAVAILABLE,STABLE_NOTICE_READ_DEFERRED].includes(error.message)){
   const r=await env.DB.prepare("UPDATE sync_jobs SET status='PENDING',attempt_count=CASE WHEN attempt_count>0 THEN attempt_count-1 ELSE 0 END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error='STABLE_RECOVERY_GATE_BLOCKED' WHERE entity_type=? AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND attempt_count>=1").bind(job.entityType,job.entityKey,job.entityVersion,lease).run();
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
