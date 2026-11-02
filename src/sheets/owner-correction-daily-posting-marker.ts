import type {Env} from '../types';
import {numberEnv} from '../shared/env';
import {createSheetRowMetadata,type NewSheetRowMetadata,type SheetRowMetadata} from './client';
import type {DailyPostingReservation,DailyPostingSnapshot} from './owner-correction-daily-posting-reservation';

/** Caller must independently establish complete identities, target blankness,
 * approved formulas and structural/cell protection. No live verifier exists. */
export interface DailyPostingMarkerDispatchPorts{
  verify:()=>Promise<boolean>;
  create:(env:Env,rows:NewSheetRowMetadata[],beforeDispatch:()=>Promise<void>)=>Promise<SheetRowMetadata[]>;
  now:()=>number;
}
export interface DailyPostingMarkerObservation{
  marker:SheetRowMetadata|null;
  headerDigest:string;
  /** Trusted independent proof, not an assertion from sheet contents alone. */
  completeIdentityAndBlanknessAndProtection:boolean;
}
export interface DailyPostingMarkerRecoveryPorts{observe:()=>Promise<DailyPostingMarkerObservation|null>;now:()=>number}
export const defaultDailyPostingMarkerCreate=createSheetRowMetadata;
type DispatchResult='PENDING'|'REVIEW';
type RecoveryResult='WAIT'|'VERIFIED'|'REVIEW';
interface ReservationRow{sheet_name:string;sheet_id:number;row_number:number;metadata_id:number;snapshot_json:string;header_digest:string;state:string;dispatch_id:string|null;not_before:string|null}
const same=(row:ReservationRow,r:DailyPostingReservation,s:DailyPostingSnapshot)=>row.sheet_name===r.sheetName&&row.sheet_id===r.sheetId&&row.row_number===r.rowNumber&&row.metadata_id===r.metadataId&&row.snapshot_json===JSON.stringify(s)&&row.header_digest===r.headerDigest&&r.expenseId===s.expenseId&&r.version===s.version;
async function read(env:Env,s:DailyPostingSnapshot):Promise<ReservationRow|null>{return env.DB.prepare(`SELECT sheet_name,sheet_id,row_number,metadata_id,snapshot_json,header_digest,state,dispatch_id,not_before FROM daily_identity_posting_reservations WHERE expense_id=? AND expense_version=?`).bind(s.expenseId,s.version).first<ReservationRow>();}
const guard=`EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version
 JOIN owner_correction_daily_write_fences f ON f.sheet_name=? AND f.lease_token=? AND f.state='OWNED' AND f.lease_until>?
 JOIN owner_correction_daily_identity_latch l ON l.sheet_name=f.sheet_name
 WHERE e.expense_id=? AND e.status='CONFIRMED' AND e.version=? AND e.updated_at IS ? AND e.description=? AND e.category=? AND e.amount_satang=? AND e.transaction_date=? AND e.payment_key=? AND e.source_wallet=?
 AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>? AND NOT EXISTS(SELECT 1 FROM sync_jobs c WHERE c.entity_type='EXPENSE_CORRECTION' AND c.entity_key=e.expense_id AND c.status<>'COMPLETED'))`;
const guardArgs=(sheet:string,fence:string,now:string,s:DailyPostingSnapshot,job:string)=>[sheet,fence,now,s.expenseId,s.version,s.updatedAt,s.description,s.category,s.amountSatang,s.transactionDate,s.paymentKey,s.sourceWallet,job,now];
const bound=`expense_id=? AND expense_version=? AND sheet_name=? AND sheet_id=? AND row_number=? AND metadata_id=? AND snapshot_json=? AND header_digest=?`;
const boundArgs=(r:DailyPostingReservation,s:DailyPostingSnapshot)=>[s.expenseId,s.version,r.sheetName,r.sheetId,r.rowNumber,r.metadataId,JSON.stringify(s),r.headerDigest];

/**
 * No automatic retry follows any possible dispatch. Once the callback commits,
 * the marker and shared fence remain IN_FLIGHT even for a successful response;
 * recovery must wait the full uncertainty window and inspect independently.
 */
export async function dispatchDailyPostingMarker(env:Env,s:DailyPostingSnapshot,r:DailyPostingReservation,input:{fenceToken:string;syncToken:string},ports:DailyPostingMarkerDispatchPorts):Promise<DispatchResult>{
  if(!s||!r||!input?.fenceToken||!input.syncToken||!ports||typeof ports.verify!=='function'||typeof ports.create!=='function'||typeof ports.now!=='function'||r.sheetName!==env.SHEET_EXPENSE_DAILY)return 'REVIEW';
  const existing=await read(env,s);if(!existing||!same(existing,r,s))return 'REVIEW';if(existing.state==='IN_FLIGHT')return 'PENDING';if(existing.state!=='PREPARED')return 'REVIEW';
  try{
    if(!await ports.verify())return 'REVIEW';
    await ports.create(env,[{metadataId:r.metadataId,metadataKey:'malipang_expense_daily',metadataValue:s.expenseId,sheetId:r.sheetId,rowIndex:r.rowNumber-1}],async()=>{
      if(!await ports.verify())throw new Error('DAILY_MARKER_PREFLIGHT_FAILED');
      const at=ports.now(),timeout=numberEnv(env.EXTERNAL_API_TIMEOUT_MS,15000);if(!Number.isFinite(at)||!Number.isFinite(timeout)||timeout<0)throw new Error('DAILY_MARKER_TIME_INVALID');
      const time=new Date(at),end=new Date(at+Math.max(15*60_000,timeout+240_000));if(!Number.isFinite(time.getTime())||!Number.isFinite(end.getTime()))throw new Error('DAILY_MARKER_TIME_INVALID');
      const now=time.toISOString(),until=end.toISOString(),dispatch=crypto.randomUUID(),args=boundArgs(r,s);
      const result=await env.DB.batch([
        env.DB.prepare(`UPDATE daily_identity_posting_reservations SET state='IN_FLIGHT',dispatch_id=?,fence_token=?,not_before=? WHERE ${bound} AND state='PREPARED' AND ${guard} AND EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.sheet_name=? AND i.entity_key=? AND i.row_number=?)`)
          .bind(dispatch,input.fenceToken,until,...args,...guardArgs(r.sheetName,input.fenceToken,now,s,input.syncToken),r.sheetName,s.expenseId,r.rowNumber),
        env.DB.prepare(`UPDATE owner_correction_daily_write_fences SET state='IN_FLIGHT',dispatch_id=?,not_before=?,lease_until=?,updated_at=? WHERE sheet_name=? AND lease_token=? AND state='OWNED' AND lease_until>? AND EXISTS(SELECT 1 FROM daily_identity_posting_reservations WHERE expense_id=? AND expense_version=? AND state='IN_FLIGHT' AND dispatch_id=?)`)
          .bind(dispatch,until,until,now,r.sheetName,input.fenceToken,now,s.expenseId,s.version,dispatch),
        env.DB.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM daily_identity_posting_reservations WHERE expense_id=? AND expense_version=? AND state='IN_FLIGHT' AND dispatch_id=?) AND NOT EXISTS(SELECT 1 FROM owner_correction_daily_write_fences WHERE sheet_name=? AND lease_token=? AND state='IN_FLIGHT' AND dispatch_id=? AND not_before=?) THEN json('daily marker fence incomplete') ELSE 1 END AS verified`)
          .bind(s.expenseId,s.version,dispatch,r.sheetName,input.fenceToken,dispatch,until)
      ]);
      if(Number(result[0]?.meta.changes||0)!==1||Number(result[1]?.meta.changes||0)!==1)throw new Error('DAILY_MARKER_NOT_ARMED');
    });
  }catch{/* Inspect durable state: DB or Sheets responses can be lost. */}
  const current=await read(env,s);return current&&same(current,r,s)&&current.state==='IN_FLIGHT'?'PENDING':'REVIEW';
}

/**
 * A new fence and current sync lease are required after the old uncertainty
 * deadline. Missing, moved, conflicting or unverified markers remain in REVIEW;
 * recovery never sends another create or mutates a spreadsheet.
 */
export async function recoverDailyPostingMarker(env:Env,s:DailyPostingSnapshot,r:DailyPostingReservation,input:{fenceToken:string;syncToken:string},ports:DailyPostingMarkerRecoveryPorts):Promise<RecoveryResult>{
  if(!s||!r||!input?.fenceToken||!input.syncToken||!ports||typeof ports.observe!=='function'||typeof ports.now!=='function'||r.sheetName!==env.SHEET_EXPENSE_DAILY)return 'REVIEW';
  const saved=await read(env,s),at=ports.now();if(!saved||!same(saved,r,s)||saved.state!=='IN_FLIGHT'||!saved.dispatch_id||!saved.not_before||!Number.isFinite(Date.parse(saved.not_before))||!Number.isFinite(at))return 'REVIEW';
  if(at<Date.parse(saved.not_before))return 'WAIT';
  let a:DailyPostingMarkerObservation|null,b:DailyPostingMarkerObservation|null,first:string;try{a=await ports.observe();if(!a)return 'REVIEW';first=JSON.stringify(a);b=await ports.observe();}catch{return 'REVIEW';}
  if(!b||first!==JSON.stringify(b))return 'REVIEW';
  // Retain the first serialized observation: callers may reuse mutable objects.
  try{a=JSON.parse(first) as DailyPostingMarkerObservation;}catch{return 'REVIEW';}
  if(a.completeIdentityAndBlanknessAndProtection!==true||a.headerDigest!==r.headerDigest||!a.marker||a.marker.metadataId!==r.metadataId||a.marker.metadataKey!=='malipang_expense_daily'||a.marker.metadataValue!==s.expenseId||a.marker.sheetId!==r.sheetId||a.marker.rowIndex!==r.rowNumber-1)return 'REVIEW';
  const nowDate=new Date(ports.now());if(!Number.isFinite(nowDate.getTime()))return 'REVIEW';const now=nowDate.toISOString();
  const updated=await env.DB.prepare(`UPDATE daily_identity_posting_reservations SET state='VERIFIED' WHERE ${bound} AND state='IN_FLIGHT' AND dispatch_id=? AND not_before=? AND not_before<=? AND ${guard} AND EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.sheet_name=? AND i.entity_key=? AND i.row_number=?)`)
    .bind(...boundArgs(r,s),saved.dispatch_id,saved.not_before,now,...guardArgs(r.sheetName,input.fenceToken,now,s,input.syncToken),r.sheetName,s.expenseId,r.rowNumber).run();
  return Number(updated.meta.changes||0)===1?'VERIFIED':'REVIEW';
}
