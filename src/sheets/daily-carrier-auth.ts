import type {Env} from '../types';
import {decodeAtomicDailyPayload} from './atomic-daily-template';
import {stableSourceIntegrity} from './stable-source-cutover';
import {continuousDailyCutoverIntegrity} from './continuous-daily-cutover';
import {legacySourceWallet,resolvePayment} from './daily-expense';
import {paymentOptionForPair} from '../expense/document';

type Current={entityId:string;operationToken:string;payload:string};
export type ReviewedRevokeDaily={expenseId:string;version:number;claim:string;transitionId:string};
/** This SQL is only enabled for the exact positively recovered REVOKE. */
function reviewedRevokePredicate(env:Env,input?:ReviewedRevokeDaily):{sql:string;args:unknown[]}{
 if(!input||env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED!=='true'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(input.expenseId)||!Number.isSafeInteger(input.version)||input.version<2||!input.claim||!input.transitionId)return{sql:'0',args:[]};
 return{sql:`j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND j.entity_key=? AND j.entity_version=? AND EXISTS(SELECT 1 FROM stable_workbook_claims c JOIN stable_recovery_epochs epoch ON epoch.spreadsheet_id=c.spreadsheet_id AND epoch.state='ARMED' AND epoch.target_type='EXPENSE' AND epoch.target_key=j.entity_key AND epoch.target_version=j.entity_version JOIN stable_recovery_operations o ON o.epoch_id=epoch.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED' JOIN continuous_publication_intents i ON i.spreadsheet_id=c.spreadsheet_id AND i.claim_token=c.operation_token AND i.entity_id=j.entity_key AND i.source_version=j.entity_version AND i.kind='REVOKE' AND i.state='VERIFIED' JOIN continuous_publication_markers m ON m.spreadsheet_id=i.spreadsheet_id AND m.entity_id=i.entity_id AND m.transition_id=i.transition_id AND m.sheet_id=i.sheet_id AND m.sheet_name=i.sheet_name AND m.row_number=i.row_number AND m.version=i.source_version AND m.marker=i.after_value AND m.state='REVOKED' JOIN continuous_publication_review_evidence proof ON proof.transition_id=i.transition_id AND proof.source_digest=i.source_digest JOIN continuous_revoke_review_close_activation a ON a.singleton=1 WHERE c.spreadsheet_id=p.spreadsheet_id AND c.operation_token=? AND c.state='REVIEW' AND c.phase='OPERATION' AND i.transition_id=? AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_publication_review_evidence' AND name IN ('continuous_publication_review_evidence_insert','continuous_publication_review_evidence_no_update','continuous_publication_review_evidence_no_delete','continuous_publication_review_evidence_no_replace'))=4 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_revoke_review_close_activation' AND name IN ('continuous_revoke_review_close_activation_no_update','continuous_revoke_review_close_activation_no_delete','continuous_revoke_review_close_activation_no_replace'))=3)`,args:[input.expenseId,input.version,input.claim,input.transitionId]};
}

export type CancellingDailyCarrier={entityId:string;sourceVersion:number;cancelVersion:number;operationToken:string;leaseToken:string;tombstone?:string};
type Evidence={entity_id:string;state:string;source_version:number;operation_token:string;preimage_width:number|null;preimage_digest:string|null;expense_version:number|null;expense_status:string|null;description:string|null;amount_satang:number|null;payment_key:string|null;source_wallet:string|null;category:string|null;transaction_date:string|null;marker_present:number;marker_value:string|null;pending_cancel:number;cancel_lease:string|null;cancel_lease_active:number;cancel_state:string|null;cancel_token:string|null;cancel_version:number|null;previous_version:number|null;cancel_preimage_digest:string|null};
const blank=(v:unknown)=>v===undefined||v===null||v==='';
async function digest(values:unknown[]):Promise<string>{return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(values)))),v=>v.toString(16).padStart(2,'0')).join('');}

/** Require a bijection between all projected daily expenses and sheet rows.
 * An active row must retain its immutable VERIFIED journal, reservation and
 * exact full-row preimage; a tombstone must match the VERIFIED cancellation.
 * Only the caller's exact current IN_FLIGHT payload is allowed after dispatch. */
export async function verifyDailyCarrierEvidence(env:Env,sheet:string,sheetId:number,columnCount:number,formula:unknown[][],current?:Current,pendingAllowed?:ReadonlySet<string>,cancelling?:CancellingDailyCarrier,reviewed?:ReviewedRevokeDaily):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book||!sheet||!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(columnCount)||columnCount<29||columnCount>100||!Array.isArray(formula))return false;
 const reviewedGuard=reviewedRevokePredicate(env,reviewed);
 const result=await db.prepare(`SELECT p.entity_id,p.state,p.source_version,p.operation_token,i.preimage_width,i.preimage_digest,e.version AS expense_version,e.status AS expense_status,e.description,e.amount_satang,e.payment_key,e.source_wallet,e.category,e.transaction_date,
  EXISTS(SELECT 1 FROM atomic_daily_marker_reservations m WHERE m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.operation_token=p.operation_token) AS marker_present,
  (SELECT m.marker FROM atomic_daily_marker_reservations m WHERE m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.operation_token=p.operation_token LIMIT 1) AS marker_value,
  EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND (j.status IN ('PENDING','PROCESSING') OR (${reviewedGuard.sql}))) AS pending_cancel,
  (SELECT j.lease_token FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING') AS cancel_lease,
  EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AS cancel_lease_active,
  c.state AS cancel_state,c.operation_token AS cancel_token,c.cancellation_version AS cancel_version,c.previous_version,c.preimage_digest AS cancel_preimage_digest
  FROM stable_projection_writes p LEFT JOIN stable_expense_projection_preimages i ON i.spreadsheet_id=p.spreadsheet_id AND i.entity_type=p.entity_type AND i.entity_id=p.entity_id AND i.projection=p.projection AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name AND i.source_version=p.source_version AND i.source_digest=p.source_digest
  LEFT JOIN expense_events e ON e.expense_id=p.entity_id
  LEFT JOIN stable_expense_cancellation_writes c ON c.spreadsheet_id=p.spreadsheet_id AND c.entity_type=p.entity_type AND c.entity_id=p.entity_id AND c.projection=p.projection
  WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.projection='DAILY' AND p.sheet_id=? AND p.sheet_name=? AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity}`).bind(...reviewedGuard.args,book,sheetId,sheet).all<Evidence>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||result.success!==true||!Array.isArray(result.results))return false;
 const byId=new Map<string,Evidence>(),active=new Map<string,unknown[]>(),tombs=new Set<string>();
 for(const r of result.results){if(!r.entity_id||byId.has(r.entity_id)||Number(r.marker_present)!==1)return false;byId.set(r.entity_id,r);}
 for(const row of formula){
  if(!Array.isArray(row)||row.length>columnCount)return false;
  const value=row[24],payload=decodeAtomicDailyPayload(value);
  if(payload){if(active.has(payload.expenseId))return false;active.set(payload.expenseId,row);continue;}
  if(typeof value==='string'&&/^MPD1_CANCELLED_[0-9a-f]{64}$/.test(value)){if(tombs.has(value))return false;tombs.add(value);}
 }
 const expectedTombs=new Set<string>();
 for(const [entityId,r] of byId){
  const row=active.get(entityId);
  if(row){const marker=decodeAtomicDailyPayload(row[24])?.operationMarker;if(marker&&marker!==r.marker_value)return false;}
  if(r.state==='IN_FLIGHT'){
   if(!current||current.entityId!==entityId||current.operationToken!==r.operation_token||!row||row[24]!==current.payload||r.cancel_state!==null||r.expense_status!=='CONFIRMED'||r.expense_version!==r.source_version)return false;
   continue;
  }
  if(r.state!=='VERIFIED'||!r.preimage_digest||r.preimage_width!==columnCount)return false;
  const ownCancel=!!cancelling&&cancelling.entityId===entityId&&cancelling.sourceVersion===r.source_version&&cancelling.cancelVersion===r.expense_version&&r.expense_status==='CANCELLED'&&r.cancel_lease===cancelling.leaseToken&&Number(r.cancel_lease_active)===1;
  if(r.cancel_state!==null){
   if(ownCancel&&cancelling?.tombstone&&r.cancel_state==='IN_FLIGHT'&&r.cancel_token===cancelling.operationToken&&r.cancel_version===cancelling.cancelVersion&&r.previous_version===r.source_version&&r.cancel_preimage_digest===r.preimage_digest&&!row){
    const tomb=`MPD1_CANCELLED_${await digest([cancelling.operationToken])}`;if(tomb!==cancelling.tombstone||expectedTombs.has(tomb)||!tombs.has(tomb))return false;expectedTombs.add(tomb);continue;
   }
   if(r.cancel_state!=='VERIFIED'||!r.cancel_token||row||r.expense_status!=='CANCELLED'||r.expense_version!==r.cancel_version||r.previous_version!==r.source_version||r.cancel_preimage_digest!==r.preimage_digest)return false;
   const tomb=`MPD1_CANCELLED_${await digest([r.cancel_token])}`;if(expectedTombs.has(tomb)||!tombs.has(tomb))return false;expectedTombs.add(tomb);continue;
  }
  const pending=!!pendingAllowed?.has(entityId)&&r.expense_status==='CANCELLED'&&r.expense_version===r.source_version+1&&Number(r.pending_cancel)===1;
  const cancellingBefore=ownCancel&&!cancelling?.tombstone&&r.expense_version===r.source_version+1;
  if(!row||!pending&&!cancellingBefore&&(r.expense_status!=='CONFIRMED'||r.expense_version!==r.source_version)||await digest(Array.from({length:columnCount},(_,i)=>blank(row[i])?null:row[i]))!==r.preimage_digest)return false;
  const payload=decodeAtomicDailyPayload(row[24]),date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(r.transaction_date??''));
  if(!payload||!date||typeof r.payment_key!=='string'||typeof r.source_wallet!=='string'||!paymentOptionForPair(r.payment_key,r.source_wallet)||payload.description!==String(r.description??'').trim()||payload.category!==String(r.category??'').trim()||payload.amountSatang!==r.amount_satang||payload.wallet!==legacySourceWallet(r.payment_key,r.source_wallet))return false;
  try{const payment=resolvePayment(formula.slice(0,3),r.payment_key,Number(date[1]),Number(date[2]),Number(date[3]));if(payload.amountColumn!==payment.amountColumn||payload.postingYear!==payment.postingYear||payload.postingMonth!==payment.postingMonth||payload.postingDay!==payment.postingDay)return false;}catch{return false;}
 }
 if(active.size!==[...byId.values()].filter(r=>r.cancel_state===null).length||expectedTombs.size!==tombs.size)return false;
 return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book;
}

/** Identify exact pending cancellations only; a missing/REVIEW/IN_FLIGHT
 * cancellation is not a safe reason to release or retry another job. */
export async function pendingDailyCancellations(env:Env,sheet:string,sheetId:number,claim:string,reviewed?:ReviewedRevokeDaily):Promise<Set<string>>{
 const reviewedGuard=reviewed&&reviewed.claim===claim?reviewedRevokePredicate(env,reviewed):{sql:'0',args:[]};
 const result=await env.DB.prepare(`SELECT p.entity_id FROM stable_projection_writes p JOIN expense_events e ON e.expense_id=p.entity_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.projection='DAILY' AND p.sheet_id=? AND p.sheet_name=? AND p.state='VERIFIED' AND e.status='CANCELLED' AND e.version=p.source_version+1 AND ((j.status IN ('PENDING','PROCESSING') AND EXISTS(SELECT 1 FROM stable_workbook_claims held WHERE held.spreadsheet_id=p.spreadsheet_id AND held.operation_token=? AND held.state='HELD')) OR (${reviewedGuard.sql})) AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=p.spreadsheet_id AND c.entity_type=p.entity_type AND c.entity_id=p.entity_id AND c.projection=p.projection) AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity}`).bind(env.GOOGLE_SPREADSHEET_ID,sheetId,sheet,claim,...reviewedGuard.args).all<{entity_id:string}>();
 if(result.success!==true||!Array.isArray(result.results))throw Error('DAILY_PENDING_CANCELLATION_UNVERIFIED');
 return new Set(result.results.map(r=>r.entity_id));
}
