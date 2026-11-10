import {hasTerminalSheetHold,STABLE_TERMINAL_HOLD} from './sheet-terminal-hold';
import type {Env} from '../types';
import {beginStableNotice,endStableNotice,stableNoticePaused} from './stable-edit-notice';
import {stableFaultReason} from './stable-fault';
import {SheetsHttpError} from './client';
import {admitStableRecovery,verifyStableRecoveryAdmission,holdStableRecoveryCapacity,completeStableRecoveryTarget,stableRecoveryGateBlocked,STABLE_RECOVERY_BLOCKED,type RecoveryIdentity} from './stable-recovery-admission';
import {admitPacedWorkbookOperation,pacingPreflightBlocked,STABLE_SHEETS_PACING_BLOCKED,STABLE_SHEETS_PACING_UNAVAILABLE} from './stable-sheet-pacing';

export type StableClaimPhase='ADMISSION'|'BEGIN_NOTICE'|'OPERATION'|'END_NOTICE'|'RELEASE';
export const STABLE_NOTICE_READ_DEFERRED='STABLE_NOTICE_READ_DEFERRED';
function readMayBeSafelyDeferred(error:unknown):boolean{
  return error instanceof SheetsHttpError && error.message==='STABLE_NOTICE_READ' &&
    (error.status===429||error.status>=500&&error.status<=599);
}

/** Read-only. A retained review claim blocks every workbook writer until an
 * operator investigates it; retrying sooner only spends D1, queue and Sheets
 * quota without making progress. */
export async function stableWorkbookInReview(env:Env):Promise<boolean>{
  if(env.STABLE_PHASE1_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID)return false;
  const row=await env.DB.prepare("SELECT 1 AS review FROM stable_workbook_claims WHERE spreadsheet_id=? AND state='REVIEW'").bind(env.GOOGLE_SPREADSHEET_ID).first<{review:number}>();
  return row?.review===1;
}

async function retainForReview(db:D1Database,book:string,token:string,phase:StableClaimPhase,error:unknown):Promise<void>{
  const reason=stableFaultReason(error);
  console.error('stable-workbook-review',{phase,reason,operation:token.slice(0,8)});
  try{await db.prepare("UPDATE stable_workbook_claims SET state='REVIEW',phase=?,review_reason=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind(phase,reason,book,token).run();return;}
  catch{/* Migration 0022 may not be applied yet; keep the original transition. */}
  try{await db.prepare("UPDATE stable_workbook_claims SET state='REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind(book,token).run();}catch{/* The remaining HELD state also blocks later operations. */}
}

/** A point-in-time check only. Callers still need a guarded write intent and
 * a final provider readback; this check is not a Google Sheets lock. */
export async function stableWorkbookClaimOwned(env:Env,token:string):Promise<boolean>{
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,flag=env.STABLE_PHASE1_ENABLED;if(!book||!token)return false;
  const row=await db.prepare("SELECT 1 AS ok,notice_stamp,notice_identity FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind(book,token).first<{ok:number;notice_stamp:string|null;notice_identity:string|null}>();
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag||row?.ok!==1)return false;
  return flag==='true'?!!row.notice_stamp&&!!row.notice_identity&&await stableNoticePaused(env,row.notice_stamp,row.notice_identity)&&env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.STABLE_PHASE1_ENABLED===flag:true;
}

/** A durable guard for one workbook operation. It does not itself stop a
 * human editor, an old deployment, or any writer not using this guard.
 * The caller must return only after all provider writes are read back and
 * verified; an exception retains the claim for review rather than retrying. */
export async function withStableWorkbookClaim<T>(env:Env,operation:(token:string)=>Promise<T>,identity?:RecoveryIdentity):Promise<T>{
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,flag=env.STABLE_PHASE1_ENABLED,token=crypto.randomUUID();
  const sheetJob=identity&&'entityType' in identity?identity:undefined;
  if(!book)throw new Error('STABLE_WORKBOOK_NOT_CONFIGURED');
  // Fast deny before reserving the shared workbook; the atomic D1 admission
  // below remains authoritative against concurrent queue invocations.
  if(await stableRecoveryGateBlocked(env,identity))throw Error(STABLE_RECOVERY_BLOCKED);
  if(await pacingPreflightBlocked(env))throw Error(STABLE_SHEETS_PACING_UNAVAILABLE);
  let claimed=false,phase:StableClaimPhase='ADMISSION',beginNoticeMayHaveWritten=false;
  try{
    const admissionSql=sheetJob?`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at)
      SELECT ?,?,'HELD',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=? AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') ON CONFLICT DO NOTHING`:`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at)
      VALUES(?,?,'HELD',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT DO NOTHING`;
    const args:unknown[]=sheetJob?[book,token,`${sheetJob.entityType}:${sheetJob.entityKey}:${sheetJob.entityVersion}`]:[book,token];
    const inserted=await db.prepare(admissionSql).bind(...args).run();
    if(inserted.success!==true||!Number.isSafeInteger(inserted.meta?.changes))throw new Error('STABLE_WORKBOOK_CLAIM_OUTCOME_UNKNOWN');
    if(Number(inserted.meta.changes)!==1){
      if(sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);
      // A held claim is temporary; a review claim waits for an operator. An
      // unreadable state is treated as temporary so it never escalates a job.
      const current=await db.prepare('SELECT state FROM stable_workbook_claims WHERE spreadsheet_id=?').bind(book).first<{state:string}>().catch(()=>null);
      throw new Error(current?.state==='REVIEW'?'STABLE_WORKBOOK_REVIEW':'STABLE_WORKBOOK_BUSY');
    }
    claimed=true;
    const paced=await admitPacedWorkbookOperation(env,identity,token);
    if(!paced){
      const released=await db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND notice_stamp IS NULL").bind(book,token).run();
      if(released.success!==true||Number(released.meta?.changes)!==1)throw Error('STABLE_SHEETS_PACING_RELEASE_UNCERTAIN');
      claimed=false;
      throw Error(STABLE_SHEETS_PACING_BLOCKED);
    }
    phase='BEGIN_NOTICE';
    if(flag==='true')await beginStableNotice(env,token,undefined,async()=>{
      // The pre-image is verified and no provider POST has been sent yet.
      // Admit here (not before the notice GETs) so a safe read deferral
      // cannot strand an ADMITTED recovery epoch.
      if(sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);
      if(!await admitStableRecovery(env,identity,token))throw Error(STABLE_RECOVERY_BLOCKED);
      // MUST be the last instruction before returning to mutation dispatch:
      // a lost POST acknowledgement must never look like a safe read defer.
      beginNoticeMayHaveWritten=true;
    });
    if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag)throw new Error('STABLE_WORKBOOK_SCOPE_CHANGED');
    phase='OPERATION';
    // A terminal signal after notice authorization may race a provider POST.
    // Stop subsequent stages and retain REVIEW; its provider outcome is unknown.
    if(sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);
    const result=await operation(token);
    if(sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);
    if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag)throw new Error('STABLE_WORKBOOK_SCOPE_CHANGED');
    phase='END_NOTICE';
    if(flag==='true')await endStableNotice(env,token);
    if(sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);
    if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag)throw new Error('STABLE_WORKBOOK_SCOPE_CHANGED');
    phase='RELEASE';
    // Each stage (DAILY/RAW/DETAIL/FINAL) is independently admitted,
    // and only a fully verified notice lifecycle frees the next stage.
    if(result==='CAPACITY_REVIEW')await holdStableRecoveryCapacity(env,identity,token);
    else {
      await verifyStableRecoveryAdmission(env,token);
      await completeStableRecoveryTarget(env,identity,token);
    }
    const releaseSql=sheetJob?"DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=? AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')":"DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'";
    const releaseArgs:unknown[]=sheetJob?[book,token,`${sheetJob.entityType}:${sheetJob.entityKey}:${sheetJob.entityVersion}`]:[book,token];
    const released=await db.prepare(releaseSql).bind(...releaseArgs).run();
    if(released.success!==true||!Number.isSafeInteger(released.meta?.changes))throw new Error('STABLE_WORKBOOK_RELEASE_OUTCOME_UNKNOWN');
    if(Number(released.meta.changes)!==1){if(sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);throw new Error('STABLE_WORKBOOK_RELEASE_OUTCOME_UNKNOWN');}
    claimed=false;
    return result;
  }catch(error){
    // When a *read* failed before the first Sheets mutation was authorized,
    // this claim never wrote to Google. A guarded release is safe; all other
    // errors (including a lost POST ACK) retain the claim for review.
    if(claimed && phase==='BEGIN_NOTICE' && !beginNoticeMayHaveWritten &&
       (env.STABLE_SHEETS_PACING_ENABLED==='true' && readMayBeSafelyDeferred(error) ||
        error instanceof Error && [STABLE_RECOVERY_BLOCKED,STABLE_TERMINAL_HOLD].includes(error.message))){
      let released=false;
      try{
        const r=await db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND notice_stamp IS NULL AND notice_identity IS NULL").bind(book,token).run();
        released=r.success===true&&Number(r.meta?.changes)===1;
      }catch{}
      if(released){claimed=false;throw Error(error instanceof Error && [STABLE_RECOVERY_BLOCKED,STABLE_TERMINAL_HOLD].includes(error.message) ? error.message : STABLE_NOTICE_READ_DEFERRED);}
    }
    if(claimed)await retainForReview(db,book,token,phase,error);
    throw error;
  }
}
