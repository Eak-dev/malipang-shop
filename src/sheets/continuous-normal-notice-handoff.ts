import type {ReviewRequestBudget} from './review-request-budget';
import type {Env,SheetsSyncJob} from '../types';
import {noticeReadinessReady,noticeReadinessFingerprint,noticeReadinessSql} from './continuous-notice-readiness';

/** This marker only hands off a verified normal stage. It is not proof that
 * a notice POST was sent, and does not authorize any worker or scheduler. */
export function normalNoticeHandoffEnabled(env:Env):boolean{return env.CONTINUOUS_NOTICE_DISPATCH_ENABLED==='true'&&env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED==='true'&&env.CONTINUOUS_REVIEW_CLOSE_ENABLED==='true'&&env.CONTINUOUS_DAILY_ENABLED==='true'&&env.SHEETS_SYNC_ENABLED==='true'&&env.STABLE_PHASE1_ENABLED==='true'&&env.STABLE_RECOVERY_GATE_ENABLED==='true'&&env.STABLE_SHEETS_PACING_ENABLED==='true';}
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_normal_notice_handoffs' AND name IN ('continuous_normal_notice_handoff_insert','continuous_normal_notice_handoff_no_update','continuous_normal_notice_handoff_no_delete','continuous_normal_notice_handoff_no_replace'))=4";
const dispatchIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_notice_dispatches' AND name IN ('continuous_notice_dispatch_insert','continuous_notice_dispatch_transition','continuous_notice_dispatch_no_delete','continuous_notice_dispatch_no_replace','continuous_notice_dispatch_owner_insert','continuous_notice_dispatch_owner_update'))=6 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='continuous_notice_one_live_dispatch') AND EXISTS(SELECT 1 FROM pragma_table_info('continuous_notice_dispatches') WHERE name='owner_token')";
export async function normalNoticeHandoffReady(env:Env):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!normalNoticeHandoffEnabled(env)||!book||!await noticeReadinessReady(env))return false;
 const row=await db.prepare(`SELECT 1 AS ok WHERE ${integrity} AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_review_notice_close' AND name IN ('continuous_review_close_insert','continuous_review_close_transition','continuous_review_close_no_delete','continuous_review_close_no_replace'))=4 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_final_notice_evidence' AND name IN ('continuous_final_notice_evidence_insert','continuous_final_notice_evidence_no_update','continuous_final_notice_evidence_no_delete','continuous_final_notice_evidence_no_replace'))=4 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_notice_status_attempts' AND name IN ('continuous_notice_status_attempt_insert','continuous_notice_status_attempt_no_update','continuous_notice_status_attempt_no_delete','continuous_notice_status_attempt_no_replace'))=4 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_final_notice_cleanup' AND name IN ('continuous_final_notice_cleanup_insert','continuous_final_notice_cleanup_no_update','continuous_final_notice_cleanup_no_delete','continuous_final_notice_cleanup_no_replace'))=4 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_notice_dispatches' AND name IN ('continuous_notice_dispatch_insert','continuous_notice_dispatch_transition','continuous_notice_dispatch_no_delete','continuous_notice_dispatch_no_replace'))=4 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='continuous_notice_one_live_dispatch') AND EXISTS(SELECT 1 FROM pragma_table_info('continuous_notice_dispatches') WHERE name='owner_token') AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_notice_dispatches' AND name IN ('continuous_notice_dispatch_owner_insert','continuous_notice_dispatch_owner_update'))=2 AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_alert_incidents') AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('sync_alert_job_insert','sync_alert_job_update','sync_alert_job_complete','sync_alert_job_delete','sync_alert_claim_insert','sync_alert_claim_update','sync_alert_claim_release','sync_alert_claim_resume','sync_alert_terminal_insert','sync_alert_terminal_update','sync_alert_terminal_resolve','sync_alert_terminal_delete'))=12`).first<{ok:number}>();
 return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&normalNoticeHandoffEnabled(env)&&row?.ok===1&&await noticeReadinessReady(env);
}
type Target={job:SheetsSyncJob;claim:string;entity:string;projection:string;kind:'CONFIRM'|'CANCEL'};
export async function saveNormalNoticeHandoff(env:Env,next:D1PreparedStatement,target:Target,prefix: D1PreparedStatement[]=[]):Promise<void>{
 const {job,claim,entity,projection,kind}=target,db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(!normalNoticeHandoffEnabled(env)||!book||job.entityType!=='EXPENSE'||!claim||!['DAILY','EXPENSE_RAW','DETAIL','FINAL','PUBLICATION'].includes(projection))throw Error('NORMAL_NOTICE_HANDOFF_DISABLED');
 const fingerprint=await noticeReadinessFingerprint(env);
 if(!fingerprint)throw Error('NORMAL_NOTICE_HANDOFF_OUTCOME_UNVERIFIED');
 const stable=()=>env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&normalNoticeHandoffEnabled(env);
 const checks=prefix.flatMap(statement=>[statement,db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")]);
 let result:D1Result[];
 try{result=await db.batch([
  db.prepare(`SELECT CASE WHEN ${noticeReadinessSql} THEN 1 ELSE json_extract('invalid-json','$') END AS ok`).bind(book,fingerprint,book,fingerprint),
  ...checks,
  next,
  db.prepare(`INSERT INTO continuous_normal_notice_handoffs(operation_token,spreadsheet_id,epoch_id,expense_id,source_version,projection,journal_entity,operation_kind,created_at) SELECT ?,?,e.epoch_id,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM stable_recovery_epochs e WHERE e.spreadsheet_id=? AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=? AND e.target_version=? AND changes()=1 AND ${integrity}`).bind(claim,book,job.entityKey,job.entityVersion,projection,entity,kind,book,job.entityKey,job.entityVersion),
  db.prepare("UPDATE stable_workbook_claims SET phase='END_NOTICE_PENDING',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND changes()=1 AND EXISTS(SELECT 1 FROM continuous_normal_notice_handoffs h WHERE h.spreadsheet_id=stable_workbook_claims.spreadsheet_id AND h.operation_token=stable_workbook_claims.operation_token)").bind(book,claim),
  db.prepare(`INSERT INTO continuous_notice_dispatches(dispatch_id,spreadsheet_id,operation_token,expense_id,source_version,sequence,safe_retry,state,created_at,updated_at) SELECT ?,?,?,?,?,0,0,'PENDING',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE changes()=1 AND ${dispatchIntegrity}`).bind(crypto.randomUUID(),book,claim,job.entityKey,job.entityVersion),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);}catch(error){
  // A lost batch acknowledgement is settled only by its exact durable marker
  // and retained claim; absence or an unreadable result never permits retry.
  const exact=await db.prepare("SELECT 1 AS ok FROM continuous_normal_notice_handoffs WHERE spreadsheet_id=? AND operation_token=? AND expense_id=? AND source_version=? AND projection=? AND journal_entity=? AND operation_kind=?").bind(book,claim,job.entityKey,job.entityVersion,projection,entity,kind).first<{ok:number}>().catch(()=>null);
  if(stable()&&fingerprint===await noticeReadinessFingerprint(env)&&exact?.ok===1&&await hasNormalNoticeHandoff(env,claim,job))return;
  throw error;
 }
 if(!stable()||fingerprint!==await noticeReadinessFingerprint(env)||result.length!==6+checks.length||result.some(x=>x.success!==true)||result.filter((_,i)=>i>0&&(i<=checks.length?(i-1)%2===0:i<=checks.length+4)).some(x=>x.meta?.changes!==1))throw Error('NORMAL_NOTICE_HANDOFF_UNCERTAIN');
}
/** Immutable handoff and initial dispatch are written in the same transaction.
 * The separate worker may already have released this operation's claim by the
 * time the original caller checks, so the current claim is not the proof. */
export async function hasNormalNoticeHandoff(env:Env,claim:string,job:Pick<SheetsSyncJob,'entityKey'|'entityVersion'>):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book)return false;
 const row=await db.prepare(`SELECT 1 AS ok FROM continuous_normal_notice_handoffs h JOIN continuous_notice_dispatches d ON d.spreadsheet_id=h.spreadsheet_id AND d.operation_token=h.operation_token AND d.expense_id=h.expense_id AND d.source_version=h.source_version AND d.sequence=0 WHERE h.spreadsheet_id=? AND h.operation_token=? AND h.expense_id=? AND h.source_version=? AND ${integrity} AND ${dispatchIntegrity}`).bind(book,claim,job.entityKey,job.entityVersion).first<{ok:number}>();
 return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&row?.ok===1;
}
/** Best-effort wake after the wrapper has observed the immutable handoff. */
export async function wakeNormalNoticeHandoff(env:Env,claim:string,job:Pick<SheetsSyncJob,'entityKey'|'entityVersion'>,budget?:ReviewRequestBudget):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,queue=env.NOTICE_QUEUE;if(!book||!queue)return;
 try{
  const row=await db.prepare("SELECT d.dispatch_id FROM continuous_normal_notice_handoffs h JOIN continuous_notice_dispatches d ON d.spreadsheet_id=h.spreadsheet_id AND d.operation_token=h.operation_token AND d.expense_id=h.expense_id AND d.source_version=h.source_version AND d.sequence=0 WHERE h.spreadsheet_id=? AND h.operation_token=? AND h.expense_id=? AND h.source_version=? AND d.state='PENDING'").bind(book,claim,job.entityKey,job.entityVersion).first<{dispatch_id:string}>();
  if(row&&env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.NOTICE_QUEUE===queue&&normalNoticeHandoffEnabled(env)){budget?.consumeQueue();await queue.send({dispatchId:row.dispatch_id});}
 }catch{/* Durable PENDING is swept independently. Never repeat the operation. */}
}

/** Atomically commit the verified journal, pending job and handoff. No
 * provider request may follow this batch in the original invocation. */
export async function finishVerifiedNormalStage(env:Env,prefix:D1PreparedStatement[],target:Target,lease:string,revision:number):Promise<void>{
 const {job,claim,entity,projection,kind}=target,book=env.GOOGLE_SPREADSHEET_ID;
 if(!normalNoticeHandoffEnabled(env)||!lease||!Number.isSafeInteger(revision)||revision<0)throw Error('NORMAL_NOTICE_HANDOFF_DISABLED');
 const next=env.DB.prepare(`UPDATE sync_jobs SET status='PENDING',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=? WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1 AND revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD') AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||?||':'||? AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')`).bind(kind==='CONFIRM'?'STABLE_STAGE_CONTINUE':'STABLE_CANCELLATION_STAGE_CONTINUE',job.entityKey,job.entityVersion,lease,revision,book,claim,job.entityKey,job.entityVersion);
 await saveNormalNoticeHandoff(env,next,{job,claim,entity,projection,kind},prefix);
}

/** Called only after the full FINAL readback and source re-read. The evidence,
 * pending job and handoff share one transaction and never authorize a POST. */
export async function finishFinalNormalStage(env:Env,job:SheetsSyncJob,claim:string,lease:string,kind:'CONFIRM'|'CANCEL',revision:number,digest:string,manifest:string):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(!normalNoticeHandoffEnabled(env)||!book||!lease||!Number.isSafeInteger(revision)||revision<0||!/^[0-9a-f]{64}$/.test(digest)||!manifest)throw Error('FINAL_NOTICE_HANDOFF_INVALID');
 const evidence=db.prepare(`INSERT INTO continuous_final_notice_evidence(operation_token,spreadsheet_id,epoch_id,expense_id,source_version,operation_kind,source_revision,source_digest,journal_manifest,created_at) SELECT ?,?,e.epoch_id,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM stable_recovery_epochs e WHERE e.spreadsheet_id=? AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=? AND e.target_version=? AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_final_notice_evidence' AND name IN ('continuous_final_notice_evidence_insert','continuous_final_notice_evidence_no_update','continuous_final_notice_evidence_no_delete','continuous_final_notice_evidence_no_replace'))=4`).bind(claim,book,job.entityKey,job.entityVersion,kind,revision,digest,manifest,book,job.entityKey,job.entityVersion);
 const next=db.prepare(`UPDATE sync_jobs SET status='PENDING',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error='STABLE_FINAL_NOTICE_PENDING' WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND changes()=1 AND EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1 AND revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD')`).bind(job.entityKey,job.entityVersion,lease,revision,book,claim);
 await saveNormalNoticeHandoff(env,next,{job,claim,entity:job.entityKey,projection:'FINAL',kind},[evidence]);
}
