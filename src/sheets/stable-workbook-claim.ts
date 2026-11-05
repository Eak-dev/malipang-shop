import type {Env} from '../types';
import {beginStableNotice,endStableNotice,stableNoticePaused} from './stable-edit-notice';
import {stableFaultReason} from './stable-fault';

export type StableClaimPhase='BEGIN_NOTICE'|'OPERATION'|'END_NOTICE'|'RELEASE';

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
export async function withStableWorkbookClaim<T>(env:Env,operation:(token:string)=>Promise<T>):Promise<T>{
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,flag=env.STABLE_PHASE1_ENABLED,token=crypto.randomUUID();
  if(!book)throw new Error('STABLE_WORKBOOK_NOT_CONFIGURED');
  let claimed=false,phase:StableClaimPhase='BEGIN_NOTICE';
  try{
    const inserted=await db.prepare(`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at)
      VALUES(?,?,'HELD',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT DO NOTHING`).bind(book,token).run();
    if(inserted.success!==true||!Number.isSafeInteger(inserted.meta?.changes))throw new Error('STABLE_WORKBOOK_CLAIM_OUTCOME_UNKNOWN');
    if(Number(inserted.meta.changes)!==1){
      // A held claim is temporary; a review claim waits for an operator. An
      // unreadable state is treated as temporary so it never escalates a job.
      const current=await db.prepare('SELECT state FROM stable_workbook_claims WHERE spreadsheet_id=?').bind(book).first<{state:string}>().catch(()=>null);
      throw new Error(current?.state==='REVIEW'?'STABLE_WORKBOOK_REVIEW':'STABLE_WORKBOOK_BUSY');
    }
    claimed=true;
    if(flag==='true')await beginStableNotice(env,token);
    if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag)throw new Error('STABLE_WORKBOOK_SCOPE_CHANGED');
    phase='OPERATION';
    const result=await operation(token);
    if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag)throw new Error('STABLE_WORKBOOK_SCOPE_CHANGED');
    phase='END_NOTICE';
    if(flag==='true')await endStableNotice(env,token);
    if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag)throw new Error('STABLE_WORKBOOK_SCOPE_CHANGED');
    phase='RELEASE';
    const released=await db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind(book,token).run();
    if(released.success!==true||Number(released.meta?.changes)!==1)throw new Error('STABLE_WORKBOOK_RELEASE_OUTCOME_UNKNOWN');
    claimed=false;
    return result;
  }catch(error){
    if(claimed)await retainForReview(db,book,token,phase,error);
    throw error;
  }
}
