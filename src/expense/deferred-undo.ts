import type {Env} from '../types';
import {randomId} from '../shared/ids';
import {enqueueSheetSync} from '../db/repositories';
import {wakeSyncFailureAlerts} from '../line/sync-failure-alerts';
import {undoConfirmedExpense,type UndoInput} from './undo';

type GuardEnv=Env&{CONTINUOUS_UNDO_SERIALIZATION_ENABLED?:string};
type Pending={request_id:string;expense_id:string;source_version:number;line_user_id:string;trace_id:string;actor_employee_id:string|null;branch_id:string|null;publication_transition_id:string;state:'PENDING'|'APPLIED'|'REVIEW';audit_id:string|null;cancelled_version:number|null};
export type UndoRequestResult={kind:'UNDONE';version:number}|{kind:'PENDING'}|{kind:'REVIEW'}|{kind:'UNAVAILABLE'};
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('continuous_undo_activation_no_update','continuous_undo_activation_no_delete','continuous_undo_activation_no_replace','continuous_pending_undo_insert','continuous_pending_undo_transition','continuous_pending_undo_no_delete','continuous_pending_undo_no_replace','continuous_pending_undo_blocks_publish','continuous_undo_guard_expense_update','continuous_undo_guard_expense_delete','continuous_undo_guard_expense_document_items_insert','continuous_undo_guard_expense_document_items_update','continuous_undo_guard_expense_document_items_delete','continuous_undo_guard_expense_document_links_insert','continuous_undo_guard_expense_document_links_update','continuous_undo_guard_expense_document_links_delete','continuous_undo_guard_documents_insert','continuous_undo_guard_documents_update','continuous_undo_guard_documents_delete','continuous_pending_undo_apply_auth_insert','continuous_pending_undo_apply_auth_no_update','continuous_pending_undo_apply_auth_no_delete','continuous_pending_undo_apply_auth_no_replace'))=23";
async function ready(env:GuardEnv):Promise<boolean>{const db=env.DB;if(env.CONTINUOUS_UNDO_SERIALIZATION_ENABLED!=='true'||env.SHEETS_SYNC_ENABLED!=='true')return false;const row=await db.prepare(`SELECT 1 AS ok WHERE EXISTS(SELECT 1 FROM continuous_undo_serialization_activation WHERE singleton=1) AND ${integrity}`).first<{ok:number}>();return env.DB===db&&env.CONTINUOUS_UNDO_SERIALIZATION_ENABLED==='true'&&env.SHEETS_SYNC_ENABLED==='true'&&row?.ok===1;}
const active="(i.state IN ('IN_FLIGHT','REVIEW') OR (i.state='VERIFIED' AND c.state IN ('HELD','REVIEW')))";

/** Request is durable before acknowledging a deferred Undo. A source write and
 * a PUBLISH intent are serialized by D1 triggers; no provider result is inferred. */
async function deferWhenResolving(env:GuardEnv,input:UndoInput):Promise<'PENDING'|'REVIEW'|null>{
 const db=env.DB,id=randomId('pending_undo'),now=new Date().toISOString();
 let result:D1Result[];try{result=await db.batch([
  db.prepare(`INSERT INTO continuous_pending_undo(request_id,expense_id,source_version,publication_transition_id,line_user_id,trace_id,actor_employee_id,branch_id,state,created_at,updated_at) SELECT ?,e.expense_id,e.version,i.transition_id,e.line_user_id,?,?,?,'PENDING',?,? FROM expense_events e JOIN continuous_publication_intents i ON i.entity_id=e.expense_id AND i.source_version=e.version AND i.kind='PUBLISH' LEFT JOIN stable_workbook_claims c ON c.spreadsheet_id=i.spreadsheet_id AND c.operation_token=i.claim_token WHERE e.expense_id=? AND e.line_user_id=? AND e.status='CONFIRMED' AND ${active} AND (SELECT count(*) FROM continuous_publication_intents p LEFT JOIN stable_workbook_claims pc ON pc.spreadsheet_id=p.spreadsheet_id AND pc.operation_token=p.claim_token WHERE p.entity_id=e.expense_id AND p.source_version=e.version AND p.kind='PUBLISH' AND (p.state IN ('IN_FLIGHT','REVIEW') OR (p.state='VERIFIED' AND pc.state IN ('HELD','REVIEW'))))=1 AND NOT EXISTS(SELECT 1 FROM continuous_pending_undo u WHERE u.expense_id=e.expense_id AND u.source_version=e.version) AND ${integrity}`).bind(id,input.traceId,input.actorEmployeeId,input.branchId,now,now,input.expenseId,input.lineUserId),
  db.prepare(`SELECT u.state FROM continuous_pending_undo u JOIN expense_events e ON e.expense_id=u.expense_id AND e.version=u.source_version AND e.status='CONFIRMED' WHERE u.expense_id=? AND u.line_user_id=? AND u.state IN ('PENDING','REVIEW') AND ${integrity}`).bind(input.expenseId,input.lineUserId)
 ]);}catch(error){
  const retained=await db.prepare(`SELECT u.state FROM continuous_pending_undo u JOIN expense_events e ON e.expense_id=u.expense_id AND e.version=u.source_version AND e.status='CONFIRMED' WHERE u.expense_id=? AND u.line_user_id=? AND u.state IN ('PENDING','REVIEW') AND ${integrity}`).bind(input.expenseId,input.lineUserId).first<{state:'PENDING'|'REVIEW'}>();
  if(env.DB===db&&retained&&(retained.state==='PENDING'||retained.state==='REVIEW'))return retained.state;throw error;
 }
 if(env.DB!==db||result.length!==2||result.some(r=>r.success!==true)||!Array.isArray(result[1]!.results)||result[1]!.results!.length>1)throw Error('DEFERRED_UNDO_REQUEST_UNCERTAIN');
 const pending=result[1]!.results![0] as {state?:unknown}|undefined;if(!pending)return null;if(pending.state!=='PENDING'&&pending.state!=='REVIEW')throw Error('DEFERRED_UNDO_REQUEST_UNCERTAIN');return pending.state;
}
async function exactReceipt(env:Env,input:UndoInput,auditId:string):Promise<number|null>{
 const row=await env.DB.prepare(`SELECT e.version FROM expense_events e JOIN expense_audit_log a ON a.expense_id=e.expense_id AND a.audit_id=? AND a.action='UNDO' JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE e.expense_id=? AND e.line_user_id=? AND e.status='CANCELLED' AND e.version=json_extract(a.after_json,'$.version')`).bind(auditId,input.expenseId,input.lineUserId).first<{version:number}>();return row&&Number.isSafeInteger(row.version)&&row.version>0?row.version:null;
}
export async function requestConfirmedExpenseUndo(env:GuardEnv,input:UndoInput):Promise<UndoRequestResult>{
 if(env.CONTINUOUS_UNDO_SERIALIZATION_ENABLED!=='true'){const version=await undoConfirmedExpense(env,input);return version===null?{kind:'UNAVAILABLE'}:{kind:'UNDONE',version};}
 if(!await ready(env))throw Error('DEFERRED_UNDO_NOT_READY');
 const first=await deferWhenResolving(env,input);if(first)return {kind:first};
 const auditId=randomId('exp_audit');
 try{const version=await undoConfirmedExpense(env,input,{auditId});return version===null?{kind:'UNAVAILABLE'}:{kind:'UNDONE',version};}
 catch(error){const committed=await exactReceipt(env,input,auditId);if(committed!==null)return {kind:'UNDONE',version:committed};const pending=await deferWhenResolving(env,input);if(pending)return {kind:pending};throw error;}
}

/** This operation is only eligible after the exact PUBLISH notice close. The
 * source Undo, audit, v2 outbox and request completion share one transaction. */
export async function applyPendingUndoAfterNotice(env:GuardEnv,dispatchId:string):Promise<'NONE'|'APPLIED'>{
 if(env.CONTINUOUS_UNDO_SERIALIZATION_ENABLED!=='true')return 'NONE';if(!await ready(env))throw Error('DEFERRED_UNDO_NOT_READY');
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book||!dispatchId)return 'NONE';
 const row=await db.prepare(`SELECT u.* FROM continuous_pending_undo u JOIN continuous_publication_intents i ON i.transition_id=u.publication_transition_id AND i.entity_id=u.expense_id AND i.source_version=u.source_version AND i.kind='PUBLISH' AND i.state='VERIFIED' JOIN continuous_normal_notice_handoffs h ON h.spreadsheet_id=i.spreadsheet_id AND h.operation_token=i.claim_token AND h.expense_id=i.entity_id AND h.source_version=i.source_version AND h.projection='PUBLICATION' AND h.journal_entity=i.transition_id AND h.operation_kind='CONFIRM' JOIN continuous_review_notice_close n ON n.spreadsheet_id=h.spreadsheet_id AND n.operation_token=h.operation_token AND n.expense_id=h.expense_id AND n.source_version=h.source_version AND n.projection='PUBLICATION' AND n.journal_entity=h.journal_entity AND n.state='COMPLETE' JOIN continuous_notice_dispatches d ON d.spreadsheet_id=n.spreadsheet_id AND d.operation_token=n.operation_token AND d.expense_id=n.expense_id AND d.source_version=n.source_version WHERE d.dispatch_id=? AND d.spreadsheet_id=? AND u.state='PENDING' AND NOT EXISTS(SELECT 1 FROM continuous_deferred_undo_retries r WHERE r.request_id=u.request_id AND r.next_attempt_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=i.spreadsheet_id AND c.operation_token=i.claim_token) AND ${integrity}`).bind(dispatchId,book).first<Pending>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||!row)return 'NONE';
 const original=await db.prepare("SELECT 1 AS ok FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=?").bind(row.expense_id,row.source_version).first<{ok:number}>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)throw Error('DEFERRED_UNDO_SCOPE_CHANGED');
 if(original?.ok!==1)throw Error('DEFERRED_UNDO_ORIGINAL_JOB_MISSING');
 const input:UndoInput={expenseId:row.expense_id,lineUserId:row.line_user_id,traceId:row.trace_id,actorEmployeeId:row.actor_employee_id,branchId:row.branch_id},auditId=randomId('exp_audit');let version:number|null=null;
 try{version=await undoConfirmedExpense(env,input,{auditId,pendingRequestId:row.request_id,expectedVersion:row.source_version});}
 catch(error){const saved=await db.prepare("SELECT cancelled_version FROM continuous_pending_undo WHERE request_id=? AND expense_id=? AND state='APPLIED' AND audit_id=?").bind(row.request_id,row.expense_id,auditId).first<{cancelled_version:number}>();if(!saved||!Number.isSafeInteger(saved.cancelled_version))throw error;version=saved.cancelled_version;}
 if(!version)throw Error('DEFERRED_UNDO_APPLY_UNCERTAIN');
 try{await enqueueSheetSync(env,{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:row.expense_id,entityVersion:version,traceId:row.trace_id});}catch{/* The transactional outbox remains for normal recovery. */}
 return 'APPLIED';
}

/** Isolate only a positively identified missing original outbox. Other D1
 * errors remain pending: a failed receipt read never proves the Undo failed. */
export async function holdPendingUndoAfterNotice(env:GuardEnv,dispatchId:string):Promise<'HELD'|'NONE'>{
 if(env.CONTINUOUS_UNDO_SERIALIZATION_ENABLED!=='true')return 'NONE';if(!await ready(env))throw Error('DEFERRED_UNDO_NOT_READY');
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book||!dispatchId)return 'NONE';
 const row=await db.prepare(`SELECT u.request_id FROM continuous_pending_undo u JOIN continuous_publication_intents i ON i.transition_id=u.publication_transition_id AND i.entity_id=u.expense_id AND i.source_version=u.source_version AND i.kind='PUBLISH' AND i.state='VERIFIED' JOIN continuous_normal_notice_handoffs h ON h.spreadsheet_id=i.spreadsheet_id AND h.operation_token=i.claim_token AND h.expense_id=i.entity_id AND h.source_version=i.source_version AND h.projection='PUBLICATION' AND h.journal_entity=i.transition_id AND h.operation_kind='CONFIRM' JOIN continuous_review_notice_close n ON n.spreadsheet_id=h.spreadsheet_id AND n.operation_token=h.operation_token AND n.expense_id=h.expense_id AND n.source_version=h.source_version AND n.projection='PUBLICATION' AND n.journal_entity=h.journal_entity AND n.state='COMPLETE' JOIN continuous_notice_dispatches d ON d.spreadsheet_id=n.spreadsheet_id AND d.operation_token=n.operation_token AND d.expense_id=n.expense_id AND d.source_version=n.source_version WHERE d.dispatch_id=? AND d.spreadsheet_id=? AND u.state IN ('PENDING','REVIEW') AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=i.spreadsheet_id AND c.operation_token=i.claim_token) AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=u.expense_id AND j.entity_version=u.source_version) AND ${integrity}`).bind(dispatchId,book).first<{request_id:string}>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||!row)return 'NONE';
 const incident=`DEFERRED_UNDO_HOLD:${row.request_id}`;
 const exact=async()=>{const proof=await db.prepare("SELECT 1 AS ok FROM continuous_pending_undo u JOIN sync_alert_incidents i ON i.kind='JOB' AND i.source_id=? AND i.state='OPEN' WHERE u.request_id=? AND u.state='REVIEW' AND u.last_error='DEFERRED_UNDO_APPLY_FAILED'").bind(incident,row.request_id).first<{ok:number}>();return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&proof?.ok===1;};
 let result:D1Result[];try{result=await db.batch([
  db.prepare("UPDATE continuous_pending_undo SET state='REVIEW',last_error='DEFERRED_UNDO_APPLY_FAILED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE request_id=? AND state='PENDING' AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=continuous_pending_undo.expense_id AND j.entity_version=continuous_pending_undo.source_version)").bind(row.request_id),
  db.prepare("UPDATE sync_alert_incidents SET state='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='JOB' AND source_id=? AND state='OPEN' AND EXISTS(SELECT 1 FROM continuous_pending_undo WHERE request_id=? AND state='REVIEW')").bind(`DEFERRED_UNDO_RETRY:${row.request_id}`,row.request_id),
  db.prepare("INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at) SELECT 'JOB',?,'REVIEW','OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE EXISTS(SELECT 1 FROM continuous_pending_undo WHERE request_id=? AND state='REVIEW' AND last_error='DEFERRED_UNDO_APPLY_FAILED') AND NOT EXISTS(SELECT 1 FROM sync_alert_incidents WHERE kind='JOB' AND source_id=? AND state='OPEN') ON CONFLICT DO NOTHING").bind(incident,row.request_id,incident),
  db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM continuous_pending_undo WHERE request_id=? AND state='REVIEW' AND last_error='DEFERRED_UNDO_APPLY_FAILED') AND EXISTS(SELECT 1 FROM sync_alert_incidents WHERE kind='JOB' AND source_id=? AND state='OPEN') THEN 1 ELSE json_extract('invalid-json','$') END AS ok").bind(row.request_id,incident)
 ]);}catch(error){if(await exact()){await wakeSyncFailureAlerts(env);return 'HELD';}throw error;}
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||result.length!==4||result.some(r=>r.success!==true)||!await exact())throw Error('DEFERRED_UNDO_HOLD_UNCERTAIN');
 await wakeSyncFailureAlerts(env);return 'HELD';
}

/** Persist a bounded retry without inventing a failure outcome. If the Undo
 * committed but its response was lost, the APPLIED row is the durable proof;
 * otherwise the atomic pending transition makes a later guarded attempt safe. */
export async function recordDeferredUndoApplyIssue(env:GuardEnv,dispatchId:string):Promise<'RETRY'|'HELD'|'NONE'>{
 if(env.CONTINUOUS_UNDO_SERIALIZATION_ENABLED!=='true')return 'NONE';if(!await ready(env))throw Error('DEFERRED_UNDO_NOT_READY');
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book||!dispatchId)return 'NONE';
 const row=await db.prepare(`SELECT u.request_id,u.state,EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=u.expense_id AND j.entity_version=u.source_version) AS has_job FROM continuous_pending_undo u JOIN continuous_publication_intents i ON i.transition_id=u.publication_transition_id AND i.entity_id=u.expense_id AND i.source_version=u.source_version AND i.kind='PUBLISH' AND i.state='VERIFIED' JOIN continuous_normal_notice_handoffs h ON h.spreadsheet_id=i.spreadsheet_id AND h.operation_token=i.claim_token AND h.expense_id=i.entity_id AND h.source_version=i.source_version AND h.projection='PUBLICATION' AND h.journal_entity=i.transition_id AND h.operation_kind='CONFIRM' JOIN continuous_review_notice_close n ON n.spreadsheet_id=h.spreadsheet_id AND n.operation_token=h.operation_token AND n.expense_id=h.expense_id AND n.source_version=h.source_version AND n.projection='PUBLICATION' AND n.journal_entity=h.journal_entity AND n.state='COMPLETE' JOIN continuous_notice_dispatches d ON d.spreadsheet_id=n.spreadsheet_id AND d.operation_token=n.operation_token AND d.expense_id=n.expense_id AND d.source_version=n.source_version WHERE d.dispatch_id=? AND d.spreadsheet_id=? AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=i.spreadsheet_id AND c.operation_token=i.claim_token) AND ${integrity}`).bind(dispatchId,book).first<{request_id:string;state:string;has_job:number}>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)throw Error('DEFERRED_UNDO_SCOPE_CHANGED');
 if(!row||row.state==='APPLIED')return 'NONE';
 if(row.state==='REVIEW'){
  const alert=await db.prepare("SELECT 1 AS ok FROM sync_alert_incidents WHERE kind='JOB' AND source_id=? AND state='OPEN'").bind(`DEFERRED_UNDO_HOLD:${row.request_id}`).first<{ok:number}>();
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||alert?.ok!==1)throw Error('DEFERRED_UNDO_HOLD_UNVERIFIED');
  return 'HELD';
 }
 if(row.state!=='PENDING')throw Error('DEFERRED_UNDO_STATE_UNVERIFIED');
 if(Number(row.has_job)===0){const held=await holdPendingUndoAfterNotice(env,dispatchId);if(held==='HELD')return held;throw Error('DEFERRED_UNDO_ORPHAN_UNCERTAIN');}
 const incident=`DEFERRED_UNDO_RETRY:${row.request_id}`;
 const result=await db.batch([
  db.prepare("INSERT INTO continuous_deferred_undo_retries(request_id,attempt_count,next_attempt_at,updated_at) SELECT ?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE EXISTS(SELECT 1 FROM continuous_pending_undo WHERE request_id=? AND state='PENDING') ON CONFLICT(request_id) DO UPDATE SET attempt_count=attempt_count+1,next_attempt_at=excluded.next_attempt_at,updated_at=excluded.updated_at").bind(row.request_id,row.request_id),
  db.prepare("INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at) SELECT 'JOB',?,'REVIEW','OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND NOT EXISTS(SELECT 1 FROM sync_alert_incidents WHERE kind='JOB' AND source_id=? AND state='OPEN') ON CONFLICT DO NOTHING").bind(incident,incident),
  db.prepare("SELECT CASE WHEN EXISTS(SELECT 1 FROM continuous_deferred_undo_retries r JOIN continuous_pending_undo u ON u.request_id=r.request_id WHERE r.request_id=? AND u.state='PENDING') AND EXISTS(SELECT 1 FROM sync_alert_incidents WHERE kind='JOB' AND source_id=? AND state='OPEN') THEN 1 ELSE json_extract('invalid-json','$') END AS ok").bind(row.request_id,incident)
 ]);
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||result.length!==3||result.some(x=>x.success!==true)||result[0]!.meta?.changes!==1)throw Error('DEFERRED_UNDO_RETRY_UNCERTAIN');
 await wakeSyncFailureAlerts(env);return 'RETRY';
}

/** Recover a committed notice close even when its queue acknowledgement or
 * the best-effort Undo wake was lost. This never retries a provider write. */
export async function sweepPendingUndoAfterNotice(env:GuardEnv):Promise<'NONE'|'APPLIED'|'HELD'|'DEFERRED'>{
 if(env.CONTINUOUS_UNDO_SERIALIZATION_ENABLED!=='true')return 'NONE';if(!await ready(env))throw Error('DEFERRED_UNDO_NOT_READY');
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book)return 'NONE';
 const row=await db.prepare(`SELECT d.dispatch_id FROM continuous_pending_undo u JOIN continuous_publication_intents i ON i.transition_id=u.publication_transition_id AND i.entity_id=u.expense_id AND i.source_version=u.source_version AND i.kind='PUBLISH' AND i.state='VERIFIED' JOIN continuous_normal_notice_handoffs h ON h.spreadsheet_id=i.spreadsheet_id AND h.operation_token=i.claim_token AND h.expense_id=i.entity_id AND h.source_version=i.source_version AND h.projection='PUBLICATION' AND h.journal_entity=i.transition_id AND h.operation_kind='CONFIRM' JOIN continuous_review_notice_close n ON n.spreadsheet_id=h.spreadsheet_id AND n.operation_token=h.operation_token AND n.expense_id=h.expense_id AND n.source_version=h.source_version AND n.projection='PUBLICATION' AND n.journal_entity=h.journal_entity AND n.state='COMPLETE' JOIN continuous_notice_dispatches d ON d.spreadsheet_id=n.spreadsheet_id AND d.operation_token=n.operation_token AND d.expense_id=n.expense_id AND d.source_version=n.source_version LEFT JOIN continuous_deferred_undo_retries r ON r.request_id=u.request_id WHERE d.spreadsheet_id=? AND u.state='PENDING' AND (r.request_id IS NULL OR r.next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=i.spreadsheet_id AND c.operation_token=i.claim_token) AND ${integrity} ORDER BY COALESCE(r.updated_at,u.created_at),CASE WHEN r.request_id IS NULL THEN 0 ELSE 1 END,u.created_at,d.sequence LIMIT 1`).bind(book).first<{dispatch_id:string}>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||!row)return 'NONE';try{return await applyPendingUndoAfterNotice(env,row.dispatch_id);}catch{const issue=await recordDeferredUndoApplyIssue(env,row.dispatch_id);return issue==='RETRY'?'DEFERRED':issue;}
}
