import type {Env,SheetsSyncJob} from '../types';
import {closeReviewedContinuousExpense} from './continuous-review-close';
import {normalNoticeHandoffEnabled} from './continuous-normal-notice-handoff';
import {ReviewRequestBudget} from './review-request-budget';
import {wakeSyncFailureAlerts} from '../line/sync-failure-alerts';
import {SheetsHttpError,SheetsReadNetworkError,SheetsMutationOutcomeUnknownError} from './client';
import {GoogleOAuthHttpError,GoogleOAuthPreflightError} from './google-auth';
import {OperationTimeoutError} from '../shared/async';
import {ReviewRequestBudgetError} from './review-request-budget';

type Dispatch={dispatch_id:string;spreadsheet_id:string;operation_token:string;expense_id:string;source_version:number;sequence:number;safe_retry:number;owner_token:string|null;state:'PENDING'|'RUNNING'|'DONE'|'HELD'};
type CloseRow={state:string};
export type NoticeDispatchOutcome='DISABLED'|'DUPLICATE'|'RUNNING'|'NEXT'|'DONE'|'HELD';
const dispatchIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_notice_dispatches' AND name IN ('continuous_notice_dispatch_insert','continuous_notice_dispatch_transition','continuous_notice_dispatch_no_delete','continuous_notice_dispatch_no_replace'))=4 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='continuous_notice_one_live_dispatch') AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_notice_dispatches' AND name IN ('continuous_notice_dispatch_owner_insert','continuous_notice_dispatch_owner_update'))=2 AND EXISTS(SELECT 1 FROM pragma_table_info('continuous_notice_dispatches') WHERE name='owner_token')";
const alertIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='stable_workbook_claims' AND name IN ('sync_alert_claim_insert','sync_alert_claim_update','sync_alert_claim_release','sync_alert_claim_resume'))=4";
const enabled=(env:Env)=>normalNoticeHandoffEnabled(env)&&!!env.GOOGLE_SPREADSHEET_ID;

// Never persist provider messages or response bodies. Only typed, bounded codes
// are safe for an owner notification; all unrecognized errors are opaque.
function safeFailureCode(error:unknown):string{
 if(error instanceof SheetsMutationOutcomeUnknownError)return 'SHEETS_MUTATION_OUTCOME_UNKNOWN';
 if(error instanceof SheetsHttpError&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599)return `SHEETS_HTTP_${error.status}`;
 if(error instanceof GoogleOAuthHttpError&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599)return `GOOGLE_OAUTH_HTTP_${error.status}`;
 if(error instanceof GoogleOAuthPreflightError)return error.code;
 if(error instanceof SheetsReadNetworkError)return 'SHEETS_READ_NETWORK';
 if(error instanceof OperationTimeoutError)return 'TIMEOUT';
 if(error instanceof ReviewRequestBudgetError)return `REVIEW_REQUEST_BUDGET_${error.code}`;
 if(error instanceof Error&&error.message==='SHEETS_RESPONSE_TOO_LARGE')return 'SHEETS_READ_RESPONSE_TOO_LARGE';
 if(error instanceof Error&&error.message.length<=80&&/^(?:FINAL_HANDOFF_JOURNAL|CANCEL_FINAL_[A-Z_]+|INSERT_DAILY_FINAL_[A-Z_]+|REPORT_HEALTH_[A-Z_]+|REVIEW_CLOSE_(?:TIME|STATUS)_(?:PREIMAGE|NOTICE|INTENT)|FINAL_CLEANUP_(?:PREIMAGE|INTENT|RELEASE_UNCERTAIN))$/.test(error.message))return error.message;
 return 'INTERNAL_ERROR';
}
/** Re-wake only a proven durable, exact workbook incident. The outbox sweep
 * deduplicates delivery; this covers a lost D1 acknowledgement after hold. */
async function wakeHeld(env:Env,db:D1Database,book:string,d:Dispatch):Promise<NoticeDispatchOutcome>{
 const row=await db.prepare(`SELECT i.alerted_at FROM continuous_notice_dispatches x JOIN stable_workbook_claims c ON c.spreadsheet_id=x.spreadsheet_id AND c.operation_token=x.operation_token JOIN sync_alert_incidents i ON i.kind='WORKBOOK' AND i.source_id=CAST(c.rowid AS TEXT) AND i.state='OPEN' WHERE x.dispatch_id=? AND x.spreadsheet_id=? AND x.operation_token=? AND x.expense_id=? AND x.source_version=? AND x.state='HELD' AND c.state='REVIEW' AND ${alertIntegrity}`).bind(d.dispatch_id,book,d.operation_token,d.expense_id,d.source_version).first<{alerted_at:string|null}>();
 if(!row||env.DB!==db)throw Error('NOTICE_DISPATCH_HOLD_UNCERTAIN');if(row.alerted_at===null)await wakeSyncFailureAlerts(env);return 'HELD';
}
/** Settle an exception after claim using only durable D1 state. A RUNNING
 * phase is never replayed. If D1 cannot be read or the hold cannot be proved,
 * throw so Queue retries and the independent watchdog can surface the fault. */
async function holdUnexpected(env:Env,db:D1Database,book:string,d:Dispatch,owner:string,error:unknown):Promise<NoticeDispatchOutcome>{
 if(env.DB!==db)throw Error('NOTICE_DISPATCH_SCOPE_CHANGED');
 const current=await db.prepare('SELECT state,owner_token FROM continuous_notice_dispatches WHERE dispatch_id=? AND spreadsheet_id=? AND operation_token=?').bind(d.dispatch_id,book,d.operation_token).first<{state:string;owner_token:string|null}>();
 if(!current)throw Error('NOTICE_DISPATCH_STATE_UNCERTAIN');
 if(current.state==='PENDING')return 'RUNNING'; // queue retries; provider has not run
 if(current.state==='HELD')return wakeHeld(env,db,book,d);
 if(current.state==='DONE'){
  const next=await db.prepare("SELECT dispatch_id,state FROM continuous_notice_dispatches WHERE spreadsheet_id=? AND operation_token=? AND sequence=?").bind(book,d.operation_token,d.sequence+1).first<{dispatch_id:string;state:string}>();
  if(next){if(next.state==='PENDING'&&env.NOTICE_QUEUE)try{await env.NOTICE_QUEUE.send({dispatchId:next.dispatch_id});}catch{/* durable fallback */}return 'NEXT';}
  const complete=await db.prepare("SELECT 1 AS ok FROM continuous_review_notice_close WHERE spreadsheet_id=? AND operation_token=? AND expense_id=? AND source_version=? AND state='COMPLETE'").bind(book,d.operation_token,d.expense_id,d.source_version).first<{ok:number}>();
  if(complete?.ok===1)return 'DONE';
  throw Error('NOTICE_DISPATCH_STATE_UNCERTAIN');
 }
 if(current.state!=='RUNNING')throw Error('NOTICE_DISPATCH_STATE_UNCERTAIN');
 if(current.owner_token!==owner)return 'RUNNING';
 const close=await db.prepare('SELECT state FROM continuous_review_notice_close WHERE spreadsheet_id=? AND operation_token=?').bind(book,d.operation_token).first<CloseRow>();
 if(close?.state==='COMPLETE'){
  const settled=await db.prepare(`UPDATE continuous_notice_dispatches SET state='DONE',outcome='ALREADY_COMPLETED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND state='RUNNING' AND owner_token=? AND ${dispatchIntegrity} AND EXISTS(SELECT 1 FROM continuous_review_notice_close n WHERE n.spreadsheet_id=continuous_notice_dispatches.spreadsheet_id AND n.operation_token=continuous_notice_dispatches.operation_token AND n.expense_id=continuous_notice_dispatches.expense_id AND n.source_version=continuous_notice_dispatches.source_version AND n.state='COMPLETE')`).bind(d.dispatch_id,book,owner).run();
  if(settled.success===true&&settled.meta?.changes===1)return 'DONE';throw Error('NOTICE_DISPATCH_SETTLE_UNCERTAIN');
 }
 const unknown=close?.state==='TIME_IN_FLIGHT'||close?.state==='STATUS_IN_FLIGHT'||close?.state==='CLEANUP_IN_FLIGHT',code=safeFailureCode(error);
 const result=await db.batch([
  db.prepare(`UPDATE continuous_notice_dispatches SET state='HELD',outcome=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND operation_token=? AND state='RUNNING' AND owner_token=? AND ${dispatchIntegrity}`).bind(unknown?'OUTCOME_UNKNOWN':'RETRY_EXHAUSTED',d.dispatch_id,book,d.operation_token,owner),
  db.prepare(`UPDATE stable_workbook_claims SET state='REVIEW',phase='END_NOTICE',review_reason=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND phase='END_NOTICE_PENDING' AND changes()=1 AND ${alertIntegrity}`).bind(`CONTINUOUS_NOTICE_FAILURE:${unknown?'UNKNOWN':'STOPPED'}:${code}`,book,d.operation_token),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(result.length!==3||result.some(x=>x.success!==true)||result[0]!.meta?.changes!==1||result[1]!.meta?.changes!==1)throw Error('NOTICE_DISPATCH_HOLD_UNCERTAIN');
 await wakeSyncFailureAlerts(env);return 'HELD';
}
/** Exactly one phase in an isolated invocation. A RUNNING dispatch is never
 * stolen or replayed. Provider ambiguity is not evidence of failure. */
export async function runNoticeDispatch(env:Env,dispatchId:string):Promise<NoticeDispatchOutcome>{
 if(!enabled(env))return 'DISABLED';
 if(!/^[0-9a-f-]{36}$/.test(dispatchId))throw Error('NOTICE_DISPATCH_INVALID');
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,stable=()=>env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&enabled(env);
 const d=await db.prepare(`SELECT dispatch_id,spreadsheet_id,operation_token,expense_id,source_version,sequence,safe_retry,owner_token,state FROM continuous_notice_dispatches WHERE dispatch_id=? AND spreadsheet_id=? AND ${dispatchIntegrity}`).bind(dispatchId,book).first<Dispatch>();
 if(!stable())return 'DISABLED';
 if(!d)return 'DUPLICATE';
 if(d.state==='RUNNING')return 'RUNNING';
 if(d.state==='HELD')return wakeHeld(env,db,book,d);
 if(d.state!=='PENDING')return 'DUPLICATE';
 const owner=crypto.randomUUID();
 let claimed:D1Result|undefined;
 try{claimed=await db.prepare(`UPDATE continuous_notice_dispatches SET state='RUNNING',owner_token=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND state='PENDING' AND ${dispatchIntegrity} AND EXISTS(SELECT 1 FROM stable_workbook_claims c JOIN continuous_normal_notice_handoffs h ON h.spreadsheet_id=c.spreadsheet_id AND h.operation_token=c.operation_token WHERE c.spreadsheet_id=continuous_notice_dispatches.spreadsheet_id AND c.operation_token=continuous_notice_dispatches.operation_token AND c.state='HELD' AND c.phase='END_NOTICE_PENDING' AND h.expense_id=continuous_notice_dispatches.expense_id AND h.source_version=continuous_notice_dispatches.source_version)`).bind(owner,dispatchId,book).run();}catch{/* Resolve lost D1 acknowledgement using this invocation's owner. */}
 if(!stable())return 'DISABLED';
 if(claimed?.success!==true||claimed.meta?.changes!==1){
  const proof=await db.prepare(`SELECT x.state,x.owner_token,EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=x.spreadsheet_id AND c.operation_token=x.operation_token AND c.state='HELD' AND c.phase='END_NOTICE_PENDING') AS authorized FROM continuous_notice_dispatches x WHERE x.dispatch_id=? AND x.spreadsheet_id=? AND x.operation_token=? AND x.expense_id=? AND x.source_version=? AND ${dispatchIntegrity}`).bind(dispatchId,book,d.operation_token,d.expense_id,d.source_version).first<{state:string;owner_token:string|null;authorized:number}>();
  if(!stable())return 'DISABLED';if(!proof)throw Error('NOTICE_CLAIM_UNCERTAIN');
  if(!(proof.state==='RUNNING'&&proof.owner_token===owner&&proof.authorized===1))return proof.state==='RUNNING'||proof.state==='PENDING'?'RUNNING':proof.state==='HELD'?wakeHeld(env,db,book,d):'DUPLICATE';
 }

 try{
 const job:SheetsSyncJob={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:d.expense_id,entityVersion:d.source_version,traceId:'continuous-notice'};
 let outcome:'DISABLED'|'HELD'|'IN_PROGRESS'|'RESUMED'|'ALREADY_COMPLETED';let failureCode:string|null=null;
 try{outcome=await closeReviewedContinuousExpense(env,job,d.operation_token,new ReviewRequestBudget(40),'HANDOFF');}catch(error){outcome='HELD';failureCode=safeFailureCode(error);}
 if(!stable()||outcome==='DISABLED')return 'DISABLED';
 const close=await db.prepare('SELECT state FROM continuous_review_notice_close WHERE spreadsheet_id=? AND operation_token=?').bind(book,d.operation_token).first<CloseRow>();
 if(!stable())return 'DISABLED';
 if(close?.state==='COMPLETE')outcome='ALREADY_COMPLETED';
 else if(outcome==='RESUMED'||outcome==='ALREADY_COMPLETED'||outcome==='IN_PROGRESS'&&!close)outcome='HELD';
 if(outcome==='ALREADY_COMPLETED'){
  const done=await db.prepare(`UPDATE continuous_notice_dispatches SET state='DONE',outcome=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND state='RUNNING' AND owner_token=? AND ${dispatchIntegrity}`).bind(outcome,dispatchId,book,owner).run();
  if(!stable()||done.success!==true||done.meta?.changes!==1)throw Error('NOTICE_DISPATCH_FINISH_UNCERTAIN');return 'DONE';
 }
 // A HELD result is a failed proof, not a transient classification. Surface
 // it immediately; never retry merely because a previous POST has no reply.
 if(outcome==='IN_PROGRESS'&&d.sequence<24){
  const kind='IN_PROGRESS',retryNo=0;
  const nextDispatchId=crypto.randomUUID();
  const result=await db.batch([
   db.prepare(`UPDATE continuous_notice_dispatches SET state='DONE',outcome=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND state='RUNNING' AND owner_token=? AND ${dispatchIntegrity}`).bind(kind,dispatchId,book,owner),
   db.prepare(`INSERT INTO continuous_notice_dispatches(dispatch_id,spreadsheet_id,operation_token,expense_id,source_version,sequence,safe_retry,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,'PENDING',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND ${dispatchIntegrity}`).bind(nextDispatchId,book,d.operation_token,d.expense_id,d.source_version,d.sequence+1,retryNo),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);
  if(!stable()||result.length!==3||result.some(x=>x.success!==true)||result[0]!.meta?.changes!==1||result[1]!.meta?.changes!==1)throw Error('NOTICE_DISPATCH_NEXT_UNCERTAIN');
  // PENDING is durable before wake-up. A lost queue ACK may duplicate the
  // message, but the exact ID and PENDING -> RUNNING CAS prevent replay.
  // If sending fails the independent sweep can re-enqueue that same ID.
  if(env.NOTICE_QUEUE&&stable())try{await env.NOTICE_QUEUE.send({dispatchId:nextDispatchId});}catch{/* durable PENDING remains for sweep */}
  return 'NEXT';
 }
 const uncertain=close?.state==='STATUS_IN_FLIGHT'||close?.state==='TIME_IN_FLIGHT'||close?.state==='CLEANUP_IN_FLIGHT';
 const reason=uncertain?'OUTCOME_UNKNOWN':'RETRY_EXHAUSTED',alertReason=failureCode?`CONTINUOUS_NOTICE_FAILURE:${uncertain?'UNKNOWN':'STOPPED'}:${failureCode}`:uncertain?'CONTINUOUS_NOTICE_OUTCOME_UNKNOWN':'CONTINUOUS_NOTICE_PROOF_UNVERIFIED';
 const held=await db.batch([
  db.prepare(`UPDATE continuous_notice_dispatches SET state='HELD',outcome=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE dispatch_id=? AND spreadsheet_id=? AND state='RUNNING' AND owner_token=? AND ${dispatchIntegrity}`).bind(reason,dispatchId,book,owner),
  db.prepare(`UPDATE stable_workbook_claims SET state='REVIEW',phase='END_NOTICE',review_reason=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND phase='END_NOTICE_PENDING' AND changes()=1 AND ${alertIntegrity}`).bind(alertReason,book,d.operation_token),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(!stable()||held.length!==3||held.some(x=>x.success!==true)||held[0]!.meta?.changes!==1||held[1]!.meta?.changes!==1)throw Error('NOTICE_DISPATCH_HOLD_UNCERTAIN');
 await wakeSyncFailureAlerts(env);return 'HELD';
 }catch(error){return holdUnexpected(env,db,book,d,owner,error);}
}
