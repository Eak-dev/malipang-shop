import type {Env,SheetsSyncJob} from '../types';
import {verifyPublicationHandoff} from './continuous-publication-handoff';
import {wakeSyncFailureAlerts} from '../line/sync-failure-alerts';
import {finalPublicationCommitGuard,publicationGuardIntegrity} from './continuous-final-publication-commit-guard';
import {verifyFinalHandoff} from './continuous-final-positive-recovery';
import {normalNoticeHandoffEnabled} from './continuous-normal-notice-handoff';
import {reviewedJobState,reviewedClaimState,type NormalNoticeAuthority} from './normal-notice-authority';
import {ReviewRequestBudget,ReviewRequestBudgetError} from './review-request-budget';
import type {ContinuousSheetsReadPolicy} from './client';
import {batchUpdateSpreadsheetWithReply} from './client';
import {getGoogleAccessToken} from './google-auth';
import {stableNoticeStyleFingerprint} from './stable-edit-notice';
import {verifyReviewedDailyProjection} from './continuous-daily-positive-recovery';
import {verifyReviewedDailyCancellation} from './continuous-daily-cancel-positive-recovery';
import {verifyReviewedLedgerProjection} from './continuous-ledger-positive-recovery';

/** This module is deliberately not called by cron, queue, or an HTTP route.
 * Its opt-in is not evidence that non-cooperating writers are fenced. */
type Stage={epoch_id:string;projection:'DAILY'|'EXPENSE_RAW'|'DETAIL'|'FINAL'|'PUBLICATION';journal_entity:string;operation_kind:'CONFIRM'|'CANCEL';notice_stamp:string;notice_identity:string;state:'IN_FLIGHT'|'VERIFIED'};
type Intent={operation_token:string;spreadsheet_id:string;epoch_id:string;expense_id:string;source_version:number;projection:Stage['projection'];journal_entity:string;operation_kind:Stage['operation_kind'];claim_mode:NormalNoticeAuthority;ready_status:string;notice_identity:string;paused_stamp:string;next_stamp:string;style_digest:string;state:'TIME_IN_FLIGHT'|'TIME_VERIFIED'|'STATUS_IN_FLIGHT'|'STATUS_ACKED'|'FINAL_COMMITTED'|'CLEANUP_IN_FLIGHT'|'COMPLETE';source_revision:number|null};
export type ReviewCloseOutcome='DISABLED'|'HELD'|'IN_PROGRESS'|'RESUMED'|'ALREADY_COMPLETED';
const dailySheetId=1815870717,paused='พักแก้ไฟล์',reviewReady='พร้อมแก้ไข • มีรายการรอตรวจ',plainReady='พร้อมแก้ไข',syncReady='พร้อมแก้ไข • กำลังซิงก์',syncReviewReady='พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ';
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_review_notice_close' AND name IN ('continuous_review_close_insert','continuous_review_close_transition','continuous_review_close_no_delete','continuous_review_close_no_replace'))=4 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_notice_status_attempts' AND name IN ('continuous_notice_status_attempt_insert','continuous_notice_status_attempt_no_update','continuous_notice_status_attempt_no_delete','continuous_notice_status_attempt_no_replace'))=4";
const scope=(e:Env)=>JSON.stringify([e.GOOGLE_SPREADSHEET_ID,e.SHEET_EXPENSE_DAILY,e.GOOGLE_SERVICE_ACCOUNT_EMAIL,e.GOOGLE_PRIVATE_KEY_BASE64,e.STABLE_PHASE1_ENABLED,e.STABLE_RECOVERY_GATE_ENABLED,e.STABLE_SHEETS_PACING_ENABLED,e.CONTINUOUS_DAILY_ENABLED,e.CONTINUOUS_DAILY_SHEET,e.CONTINUOUS_DAILY_SHEET_ID,e.CONTINUOUS_PUBLICATION_ENABLED,e.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED,e.CONTINUOUS_CANCEL_FINANCIAL_FINGERPRINT_ENABLED,e.CONTINUOUS_PUBLICATION_SHEET,e.CONTINUOUS_PUBLICATION_SHEET_ID,e.CONTINUOUS_PUBLICATION_ROWS,e.CONTINUOUS_REVIEW_CLOSE_ENABLED,e.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED,e.CONTINUOUS_NOTICE_DISPATCH_ENABLED,e.SHEETS_SYNC_ENABLED,e.APP_ENV,e.RUNTIME_MODE]);
function timestamp():string{const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()),v=(name:string)=>p.find(x=>x.type===name)?.value;return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}:${v('second')}`;}
const request=(column:number,find:string,replacement:string)=>({findReplace:{range:{sheetId:dailySheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:column,endColumnIndex:column+1},find,replacement,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}});

const oneChange=(reply:unknown):boolean=>{const r=reply&&typeof reply==='object'?(reply as {replies?:Array<{findReplace?:{valuesChanged?:unknown;occurrencesChanged?:unknown;formulasChanged?:unknown}}>}).replies:undefined;return Array.isArray(r)&&r.length===1&&r[0]?.findReplace?.valuesChanged===1&&r[0].findReplace.occurrencesChanged===1&&Number(r[0].findReplace.formulasChanged??0)===0;};

async function sourceRevision(env:Env):Promise<number|null>{const r=await env.DB.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').first<{revision:number}>();return r&&Number.isSafeInteger(r.revision)&&r.revision>=0?r.revision:null;}
async function findStage(env:Env,job:SheetsSyncJob,token:string,authority:NormalNoticeAuthority):Promise<Stage|null>{
 const reviewCandidate=env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED==='true'?"i.kind='REVOKE' AND EXISTS(SELECT 1 FROM continuous_publication_review_evidence p JOIN continuous_revoke_review_close_activation a ON a.singleton=1 WHERE p.transition_id=i.transition_id AND p.source_digest=i.source_digest)":"0";
 const rows=await env.DB.prepare(`SELECT e.epoch_id,p.projection,p.entity_id AS journal_entity,'CONFIRM' AS operation_kind,c.notice_stamp,c.notice_identity,p.state
  FROM stable_workbook_claims c JOIN stable_recovery_epochs e ON e.spreadsheet_id=c.spreadsheet_id AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=? AND e.target_version=?
  JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED'
  JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.target_key AND j.entity_version=e.target_version AND ${reviewedJobState('j',authority)}
  JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.operation_token=c.operation_token AND p.entity_type='EXPENSE' AND p.state IN ('IN_FLIGHT','VERIFIED')
  WHERE c.spreadsheet_id=? AND c.operation_token=? AND ${reviewedClaimState('c',authority)}
  UNION ALL
  SELECT e.epoch_id,p.projection,p.entity_id AS journal_entity,'CANCEL' AS operation_kind,c.notice_stamp,c.notice_identity,p.state
  FROM stable_workbook_claims c JOIN stable_recovery_epochs e ON e.spreadsheet_id=c.spreadsheet_id AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=? AND e.target_version=?
  JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED'
  JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.target_key AND j.entity_version=e.target_version AND ${reviewedJobState('j',authority)}
  JOIN stable_expense_cancellation_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.operation_token=c.operation_token AND p.entity_type='EXPENSE' AND p.state IN ('IN_FLIGHT','VERIFIED')
  WHERE c.spreadsheet_id=? AND c.operation_token=? AND ${reviewedClaimState('c',authority)}
  UNION ALL
  SELECT e.epoch_id,'PUBLICATION' AS projection,i.transition_id AS journal_entity,CASE WHEN i.kind='REVOKE' THEN 'CANCEL' ELSE 'CONFIRM' END AS operation_kind,c.notice_stamp,c.notice_identity,i.state
  FROM stable_workbook_claims c JOIN stable_recovery_epochs e ON e.spreadsheet_id=c.spreadsheet_id AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=? AND e.target_version=?
  JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED'
  JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.target_key AND j.entity_version=e.target_version AND ${reviewedJobState('j',authority)}
  JOIN continuous_publication_intents i ON i.spreadsheet_id=c.spreadsheet_id AND i.claim_token=c.operation_token AND i.entity_id=e.target_key AND i.source_version=e.target_version AND i.state='VERIFIED'
  WHERE c.spreadsheet_id=? AND c.operation_token=? AND ${reviewedClaimState('c',authority)} AND ((?='HANDOFF' AND EXISTS(SELECT 1 FROM continuous_normal_notice_handoffs h WHERE h.spreadsheet_id=i.spreadsheet_id AND h.operation_token=i.claim_token AND h.expense_id=i.entity_id AND h.source_version=i.source_version AND h.projection='PUBLICATION' AND h.journal_entity=i.transition_id AND h.operation_kind=CASE WHEN i.kind='REVOKE' THEN 'CANCEL' ELSE 'CONFIRM' END)) OR (?='REVIEW' AND ${reviewCandidate}))
  UNION ALL
  SELECT e.epoch_id,'FINAL' AS projection,z.expense_id AS journal_entity,z.operation_kind,c.notice_stamp,c.notice_identity,'VERIFIED' AS state
  FROM stable_workbook_claims c JOIN stable_recovery_epochs e ON e.spreadsheet_id=c.spreadsheet_id AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=? AND e.target_version=?
  JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED'
  JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.target_key AND j.entity_version=e.target_version AND ${reviewedJobState('j',authority)}
  JOIN continuous_final_notice_evidence z ON z.spreadsheet_id=c.spreadsheet_id AND z.operation_token=c.operation_token AND z.epoch_id=e.epoch_id AND z.expense_id=e.target_key AND z.source_version=e.target_version
  WHERE c.spreadsheet_id=? AND c.operation_token=? AND ${reviewedClaimState('c',authority)} AND ?='HANDOFF'`).bind(job.entityKey,job.entityVersion,env.GOOGLE_SPREADSHEET_ID,token,job.entityKey,job.entityVersion,env.GOOGLE_SPREADSHEET_ID,token,job.entityKey,job.entityVersion,env.GOOGLE_SPREADSHEET_ID,token,authority,authority,job.entityKey,job.entityVersion,env.GOOGLE_SPREADSHEET_ID,token,authority).all<Stage>();
 if(rows.success!==true||!Array.isArray(rows.results)||rows.results.length!==1)return null;
 const s=rows.results[0]!;if(!s.notice_stamp||!s.notice_identity||!['DAILY','EXPENSE_RAW','DETAIL','FINAL','PUBLICATION'].includes(s.projection)||!['CONFIRM','CANCEL'].includes(s.operation_kind)||(s.projection==='PUBLICATION'?!s.journal_entity:s.projection==='DETAIL'?!s.journal_entity.startsWith(`${job.entityKey}|`):s.journal_entity!==job.entityKey))return null;
 return s;
}
async function verifyStage(env:Env,job:SheetsSyncJob,token:string,s:Stage,mode:'PAUSED'|'REVIEW_READY',policy:ContinuousSheetsReadPolicy,authority:NormalNoticeAuthority,allowExtraBlankTail=false):Promise<boolean>{
 if(s.projection==='PUBLICATION')return (authority==='HANDOFF'||authority==='REVIEW'&&s.operation_kind==='CANCEL'&&env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED==='true')&&verifyPublicationHandoff(env,job,token,s.journal_entity,mode,policy,authority);
 if(s.projection==='FINAL')return authority==='HANDOFF'&&verifyFinalHandoff(env,job,token,mode,policy);
 if(s.projection==='DAILY')return s.operation_kind==='CONFIRM'?verifyReviewedDailyProjection(env,job,token,mode,policy,authority,allowExtraBlankTail):verifyReviewedDailyCancellation(env,job,token,mode,policy,authority);
 const item=s.projection==='DETAIL'?s.journal_entity.slice(job.entityKey.length+1):undefined;
 return verifyReviewedLedgerProjection(env,job,token,s.projection,s.operation_kind,item,mode,policy,authority);
}
async function expectedReady(env:Env,authority:NormalNoticeAuthority,nonce?:string):Promise<string|null>{const r=await env.DB.prepare("SELECT count(*) AS n FROM sync_jobs WHERE status='REVIEW'").first<{n:number}>();if(!r||!Number.isSafeInteger(r.n)||r.n<0)return null;const base=authority==='HANDOFF'?(r.n?syncReviewReady:syncReady):(r.n?reviewReady:plainReady);return nonce?`${base} • รหัส ${nonce}`:base;}
async function readIntent(env:Env,book:string,token:string):Promise<Intent|null>{return env.DB.prepare('SELECT * FROM continuous_review_notice_close WHERE spreadsheet_id=? AND operation_token=?').bind(book,token).first<Intent>();}

/** Resolve only positively recorded D1 milestones after a lost D1 reply.
 * This never queries or replays a provider mutation. */
async function handoffMilestone(env:Env,book:string,job:SheetsSyncJob,expected:Intent,state:'TIME_VERIFIED'|'STATUS_ACKED'|'FINAL_COMMITTED'):Promise<boolean>{
 if(expected.claim_mode!=='HANDOFF'||env.GOOGLE_SPREADSHEET_ID!==book)return false;
 const db=env.DB;
 const row=await db.prepare(`SELECT 1 AS ok FROM continuous_review_notice_close n
  JOIN stable_workbook_claims c ON c.spreadsheet_id=n.spreadsheet_id AND c.operation_token=n.operation_token
  JOIN stable_recovery_epochs e ON e.epoch_id=n.epoch_id AND e.spreadsheet_id=n.spreadsheet_id
  JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=n.operation_token
  JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=n.expense_id AND j.entity_version=n.source_version
  JOIN continuous_normal_notice_handoffs h ON h.spreadsheet_id=n.spreadsheet_id AND h.operation_token=n.operation_token AND h.expense_id=n.expense_id AND h.source_version=n.source_version AND h.projection=n.projection AND h.journal_entity=n.journal_entity AND h.operation_kind=n.operation_kind
  WHERE n.spreadsheet_id=? AND n.operation_token=? AND n.epoch_id=? AND n.expense_id=? AND n.source_version=? AND n.projection=? AND n.journal_entity=? AND n.operation_kind=? AND n.claim_mode='HANDOFF' AND n.notice_identity=? AND n.paused_stamp=? AND n.next_stamp=? AND n.style_digest=? AND n.state=? AND c.state='HELD' AND c.phase='END_NOTICE_PENDING' AND c.notice_stamp=n.next_stamp AND c.notice_identity=n.notice_identity AND e.target_type='EXPENSE' AND e.target_key=n.expense_id AND e.target_version=n.source_version
  AND ((? IN ('TIME_VERIFIED','STATUS_ACKED') AND e.state='ARMED' AND o.state='ADMITTED' AND j.status='PENDING' AND j.lease_token IS NULL AND j.lease_until IS NULL) OR (?='FINAL_COMMITTED' AND n.projection='FINAL' AND e.state='COMPLETE' AND o.state='VERIFIED' AND j.status='COMPLETED' AND EXISTS(SELECT 1 FROM continuous_final_notice_evidence z WHERE z.spreadsheet_id=n.spreadsheet_id AND z.operation_token=n.operation_token AND z.epoch_id=n.epoch_id AND z.expense_id=n.expense_id AND z.source_version=n.source_version AND z.operation_kind=n.operation_kind))) AND ${integrity}`).bind(book,expected.operation_token,expected.epoch_id,job.entityKey,job.entityVersion,expected.projection,expected.journal_entity,expected.operation_kind,expected.notice_identity,expected.paused_stamp,expected.next_stamp,expected.style_digest,state,state,state).first<{ok:number}>();
 return row?.ok===1&&env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book;
}

const cleanupIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_final_notice_cleanup' AND name IN ('continuous_final_notice_cleanup_insert','continuous_final_notice_cleanup_no_update','continuous_final_notice_cleanup_no_delete','continuous_final_notice_cleanup_no_replace'))=4";
type Cleanup={find_status:string;replacement_status:string;notice_stamp:string};
async function finishFinalCleanup(env:Env,job:SheetsSyncJob,token:string,budget:ReviewRequestBudget,intent:Intent):Promise<ReviewCloseOutcome>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env),identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]),stable=()=>env.DB===db&&scope(env)===initial&&identity===JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 if(!book||intent.claim_mode!=='HANDOFF'||intent.projection!=='FINAL'||intent.expense_id!==job.entityKey||intent.source_version!==job.entityVersion||!/^[0-9a-f]{32}$/.test(intent.next_stamp.slice(-32))||!intent.ready_status.endsWith(` • รหัส ${intent.next_stamp.slice(-32)}`))return 'HELD';
 if(intent.state==='FINAL_COMMITTED'){
  const replacement=await expectedReady(env,'REVIEW');if(!replacement||await stableNoticeStyleFingerprint(env,intent.notice_identity,intent.ready_status,intent.next_stamp,budget)!==intent.style_digest||!stable())return 'HELD';
  if(!budget.reserveMutation())return 'HELD';
  try{
   await batchUpdateSpreadsheetWithReply(env,[request(1,intent.ready_status,replacement)],async()=>{
    if(await expectedReady(env,'REVIEW')!==replacement||await stableNoticeStyleFingerprint(env,intent.notice_identity,intent.ready_status,intent.next_stamp,budget)!==intent.style_digest||!stable())throw Error('FINAL_CLEANUP_PREIMAGE');
    const saved=await db.batch([
     db.prepare(`INSERT INTO continuous_final_notice_cleanup(operation_token,spreadsheet_id,find_status,replacement_status,notice_stamp,created_at) SELECT ?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${integrity} AND ${cleanupIntegrity}`).bind(token,book,intent.ready_status,replacement,intent.next_stamp),
     db.prepare(`UPDATE continuous_review_notice_close SET state='CLEANUP_IN_FLIGHT',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='FINAL_COMMITTED' AND changes()=1 AND ${integrity} AND ${cleanupIntegrity}`).bind(book,token),
     db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
    ]);
    if(!stable()||saved.length!==3||saved.some(x=>x.success!==true)||saved[0]!.meta?.changes!==1||saved[1]!.meta?.changes!==1)throw Error('FINAL_CLEANUP_INTENT');
   },budget);
  }catch(error){throw error;}finally{budget.releaseMutation();}
  const pending=await readIntent(env,book,token);
  return stable()&&pending?.state==='CLEANUP_IN_FLIGHT'?'IN_PROGRESS':'HELD';
 }
 if(intent.state!=='CLEANUP_IN_FLIGHT')return 'HELD';
 const receipt=await db.prepare('SELECT find_status,replacement_status,notice_stamp FROM continuous_final_notice_cleanup WHERE spreadsheet_id=? AND operation_token=?').bind(book,token).first<Cleanup>();
 if(!receipt||receipt.find_status!==intent.ready_status||receipt.notice_stamp!==intent.next_stamp||await expectedReady(env,'REVIEW')!==receipt.replacement_status||await stableNoticeStyleFingerprint(env,intent.notice_identity,receipt.replacement_status,intent.next_stamp,budget)!==intent.style_digest||!stable())return 'HELD';
 const released=await db.batch([
  db.prepare(`DELETE FROM stable_workbook_claims AS c WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND phase='END_NOTICE_PENDING' AND notice_stamp=? AND notice_identity=? AND EXISTS(SELECT 1 FROM continuous_review_notice_close n JOIN continuous_final_notice_cleanup a ON a.spreadsheet_id=n.spreadsheet_id AND a.operation_token=n.operation_token JOIN stable_recovery_epochs e ON e.epoch_id=n.epoch_id AND e.spreadsheet_id=n.spreadsheet_id JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=n.operation_token JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=n.expense_id AND j.entity_version=n.source_version WHERE n.spreadsheet_id=c.spreadsheet_id AND n.operation_token=c.operation_token AND n.state='CLEANUP_IN_FLIGHT' AND n.projection='FINAL' AND n.claim_mode='HANDOFF' AND n.next_stamp=a.notice_stamp AND n.ready_status=a.find_status AND a.replacement_status=? AND e.state='COMPLETE' AND o.state='VERIFIED' AND j.status='COMPLETED') AND ((?='พร้อมแก้ไข' AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW')) OR (?='พร้อมแก้ไข • มีรายการรอตรวจ' AND EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW'))) AND ${integrity} AND ${cleanupIntegrity}`).bind(book,token,intent.next_stamp,intent.notice_identity,receipt.replacement_status,receipt.replacement_status,receipt.replacement_status),
  db.prepare(`UPDATE continuous_review_notice_close SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='CLEANUP_IN_FLIGHT' AND changes()=1 AND ${integrity} AND ${cleanupIntegrity}`).bind(book,token),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(!stable()||released.length!==3||released.some(x=>x.success!==true)||released[0]!.meta?.changes!==1||released[1]!.meta?.changes!==1)throw Error('FINAL_CLEANUP_RELEASE_UNCERTAIN');
 return 'RESUMED';
}


async function finishRevokeReviewCleanup(env:Env,job:SheetsSyncJob,token:string,budget:ReviewRequestBudget,intent:Intent):Promise<ReviewCloseOutcome>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env),identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]),stable=()=>env.DB===db&&scope(env)===initial&&identity===JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 if(!book||env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED!=='true'||intent.claim_mode!=='REVIEW'||intent.projection!=='PUBLICATION'||intent.operation_kind!=='CANCEL'||intent.expense_id!==job.entityKey||intent.source_version!==job.entityVersion||!/^[0-9a-f]{32}$/.test(intent.next_stamp.slice(-32))||!intent.ready_status.endsWith(` • รหัส ${intent.next_stamp.slice(-32)}`))return 'HELD';
 if(intent.state==='FINAL_COMMITTED'){
  const replacement=await expectedReady(env,'REVIEW');if(!replacement||await stableNoticeStyleFingerprint(env,intent.notice_identity,intent.ready_status,intent.next_stamp,budget)!==intent.style_digest||!stable())return 'HELD';
  if(!budget.reserveMutation())return 'HELD';
  try{
   await batchUpdateSpreadsheetWithReply(env,[request(1,intent.ready_status,replacement)],async()=>{
    if(await expectedReady(env,'REVIEW')!==replacement||await stableNoticeStyleFingerprint(env,intent.notice_identity,intent.ready_status,intent.next_stamp,budget)!==intent.style_digest||!stable())throw Error('REVOKE_REVIEW_CLEANUP_PREIMAGE');
    const saved=await db.batch([
     db.prepare(`INSERT INTO continuous_final_notice_cleanup(operation_token,spreadsheet_id,find_status,replacement_status,notice_stamp,created_at) SELECT ?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${integrity} AND ${cleanupIntegrity}`).bind(token,book,intent.ready_status,replacement,intent.next_stamp),
     db.prepare(`UPDATE continuous_review_notice_close SET state='CLEANUP_IN_FLIGHT',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='FINAL_COMMITTED' AND changes()=1 AND ${integrity} AND ${cleanupIntegrity}`).bind(book,token),
     db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
    ]);
    if(!stable()||saved.length!==3||saved.some(x=>x.success!==true)||saved[0]!.meta?.changes!==1||saved[1]!.meta?.changes!==1)throw Error('REVOKE_REVIEW_CLEANUP_INTENT');
   },budget);
  }catch(error){throw error;}finally{budget.releaseMutation();}
  const pending=await readIntent(env,book,token);
  return stable()&&pending?.state==='CLEANUP_IN_FLIGHT'?'IN_PROGRESS':'HELD';
 }
 if(intent.state!=='CLEANUP_IN_FLIGHT')return 'HELD';
 const receipt=await db.prepare('SELECT find_status,replacement_status,notice_stamp FROM continuous_final_notice_cleanup WHERE spreadsheet_id=? AND operation_token=?').bind(book,token).first<Cleanup>();
 if(!receipt||receipt.find_status!==intent.ready_status||receipt.notice_stamp!==intent.next_stamp||await stableNoticeStyleFingerprint(env,intent.notice_identity,receipt.replacement_status,intent.next_stamp,budget)!==intent.style_digest||!stable())return 'HELD';
 const latestReady=await expectedReady(env,'REVIEW');if(!latestReady||!stable())return 'HELD';
 if(latestReady!==receipt.replacement_status){
  // The exact cleanup value is visible, but the count changed while the POST
  // was in flight. Hold the claim and emit one durable, actionable incident;
  // never replay a POST or silently release with an incorrect status.
  const reason='REVOKE_REVIEW_CLEANUP_COUNT_CHANGED';
  const alerted=await db.batch([
   db.prepare(`UPDATE stable_workbook_claims SET review_reason=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='REVIEW' AND phase='OPERATION' AND COALESCE(review_reason,'')<>? AND EXISTS(SELECT 1 FROM continuous_review_notice_close n WHERE n.spreadsheet_id=? AND n.operation_token=? AND n.state='CLEANUP_IN_FLIGHT' AND n.claim_mode='REVIEW' AND n.projection='PUBLICATION' AND n.operation_kind='CANCEL')`).bind(reason,book,token,reason,book,token),
   db.prepare(`UPDATE sync_alert_incidents SET state='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='WORKBOOK' AND state='OPEN' AND source_id=(SELECT CAST(rowid AS TEXT) FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND review_reason=?) AND changes()=1`).bind(book,token,reason),
   db.prepare(`INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at) SELECT 'WORKBOOK',CAST(c.rowid AS TEXT),'WORKBOOK_REVIEW','OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='REVIEW' AND c.review_reason=? AND NOT EXISTS(SELECT 1 FROM sync_alert_incidents i WHERE i.kind='WORKBOOK' AND i.source_id=CAST(c.rowid AS TEXT) AND i.state='OPEN') ON CONFLICT DO NOTHING`).bind(book,token,reason)
  ]);
  if(!stable()||alerted.length!==3||alerted.some(x=>x.success!==true))throw Error('REVOKE_REVIEW_CLEANUP_ALERT_UNCERTAIN');await wakeSyncFailureAlerts(env);return 'HELD';
 }
 const released=await db.batch([
  db.prepare(`DELETE FROM stable_workbook_claims AS c WHERE spreadsheet_id=? AND operation_token=? AND state='REVIEW' AND phase='OPERATION' AND notice_stamp=? AND notice_identity=? AND EXISTS(SELECT 1 FROM continuous_review_notice_close n JOIN continuous_final_notice_cleanup a ON a.spreadsheet_id=n.spreadsheet_id AND a.operation_token=n.operation_token JOIN stable_recovery_epochs e ON e.epoch_id=n.epoch_id AND e.spreadsheet_id=n.spreadsheet_id JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=n.operation_token JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=n.expense_id AND j.entity_version=n.source_version WHERE n.spreadsheet_id=c.spreadsheet_id AND n.operation_token=c.operation_token AND n.state='CLEANUP_IN_FLIGHT' AND n.projection='PUBLICATION' AND n.operation_kind='CANCEL' AND n.claim_mode='REVIEW' AND n.next_stamp=a.notice_stamp AND n.ready_status=a.find_status AND a.replacement_status=? AND e.state='ARMED' AND o.state='VERIFIED' AND j.status='PENDING' AND j.lease_token IS NULL AND j.lease_until IS NULL) AND ((?='พร้อมแก้ไข' AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW')) OR (?='พร้อมแก้ไข • มีรายการรอตรวจ' AND EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW'))) AND ${integrity} AND ${cleanupIntegrity}`).bind(book,token,intent.next_stamp,intent.notice_identity,receipt.replacement_status,receipt.replacement_status,receipt.replacement_status),
  db.prepare(`UPDATE continuous_review_notice_close SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='CLEANUP_IN_FLIGHT' AND changes()=1 AND ${integrity} AND ${cleanupIntegrity}`).bind(book,token),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(!stable()||released.length!==3||released.some(x=>x.success!==true)||released[0]!.meta?.changes!==1||released[1]!.meta?.changes!==1)throw Error('REVOKE_REVIEW_CLEANUP_RELEASE_UNCERTAIN');
 // A failed/ambiguous wake cannot reverse the durable PENDING job. Existing
 // scheduled recoverArmedSheetJob re-enqueues this exact target if still stale.
 try{await env.JOB_QUEUE.send(job);}catch{/* durable ARMED/PENDING sweep is the fallback */}
 return 'RESUMED';
}

/** Positive-only, exact-target close for one verified expense operation.
 * Missing proof, an unmatched cell, uncertain writes or any source drift
 * leave the job and claim in REVIEW. This is not an external writer fence. */
export async function closeReviewedContinuousExpense(env:Env,job:SheetsSyncJob,token:string,budget?:ReviewRequestBudget,authority:NormalNoticeAuthority='REVIEW'):Promise<ReviewCloseOutcome>{
 if(env.CONTINUOUS_REVIEW_CLOSE_ENABLED!=='true')return 'DISABLED';
 if(!(budget instanceof ReviewRequestBudget)||!['REVIEW','HANDOFF'].includes(authority))return 'HELD';
 if(authority==='HANDOFF'&&!normalNoticeHandoffEnabled(env))return 'DISABLED';
 try{return await closePhase(env,job,token,budget,authority);}catch(error){if(error instanceof ReviewRequestBudgetError&&authority!=='HANDOFF')return 'HELD';throw error;}
}

/** Only the one synthetic #296 DAILY insert with a positively verified
 * extra blank tail. No IDs are accepted from callers and no generic review
 * dispatcher is enabled. One explicit phase per invocation. */
export async function closeExactCanaryDailyIncident(env:Env & {CANARY_UNWRITTEN_RECOVERY_ENABLED?:string;CONTINUOUS_CANARY_OPERATOR_ENABLED?:string},phase:'VERIFY'|'TIME'|'TIME_READBACK'|'PROBE_STATUS'|'STATUS'|'COMMIT',diagnostic?:{stage:string;remaining:number}):Promise<ReviewCloseOutcome|'READY'>{
 if(env.CANARY_UNWRITTEN_RECOVERY_ENABLED!=='true'||env.CONTINUOUS_CANARY_OPERATOR_ENABLED!=='true'||env.CONTINUOUS_PUBLICATION_ENABLED==='true'||env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED==='true')return 'DISABLED';
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book)return 'HELD';
 const expected={VERIFY:null,TIME:null,TIME_READBACK:'TIME_IN_FLIGHT',PROBE_STATUS:'TIME_VERIFIED',STATUS:'TIME_VERIFIED',COMMIT:'STATUS_ACKED'} as const;
 if(!Object.hasOwn(expected,phase))return 'HELD';
 const rows=await db.prepare(`SELECT c.expense_id,c.trace_id,w.operation_token,p.state projection_state,n.state notice_state
 FROM continuous_canary_operator c JOIN expense_events src ON src.expense_id=c.expense_id AND src.status='CONFIRMED' AND src.version=1
 JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=c.expense_id AND j.entity_version=1 AND j.status='REVIEW' AND j.last_error='STABLE_SYNC_REVIEW' AND j.lease_token IS NULL AND j.lease_until IS NULL
 JOIN stable_workbook_claims w ON w.spreadsheet_id=c.spreadsheet_id AND w.state='REVIEW' AND w.phase='OPERATION' AND w.review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED'
 JOIN stable_recovery_epochs e ON e.spreadsheet_id=c.spreadsheet_id AND e.target_type='EXPENSE' AND e.target_key=c.expense_id AND e.target_version=1 AND e.state='ARMED'
 JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=w.operation_token AND o.state='ADMITTED'
 JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=c.expense_id AND p.projection='DAILY' AND p.source_version=1 AND p.operation_token=w.operation_token AND p.state IN ('IN_FLIGHT','VERIFIED')
 JOIN continuous_daily_write_evidence d ON d.spreadsheet_id=p.spreadsheet_id AND d.entity_id=p.entity_id AND d.source_version=p.source_version AND d.operation_token=p.operation_token AND d.source_digest=p.source_digest
 JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=d.spreadsheet_id AND m.entity_id=d.entity_id AND m.sheet_id=d.sheet_id AND m.source_version=d.source_version AND m.operation_token=d.operation_token AND m.marker=d.marker
 JOIN canary_unwritten_recovery previous ON previous.spreadsheet_id=c.spreadsheet_id AND previous.expense_id=c.expense_id AND previous.state='COMPLETE'
 LEFT JOIN continuous_review_notice_close n ON n.spreadsheet_id=c.spreadsheet_id AND n.operation_token=w.operation_token
 WHERE c.spreadsheet_id=? AND c.state='ARMED_CONFIRM' AND src.description='[SYSTEM TEST] Synthetic expense - cancel after verification' AND src.amount_satang=100 AND src.trace_id=c.trace_id AND src.line_user_id=c.line_user_id
 AND (n.operation_token IS NULL OR (n.expense_id=c.expense_id AND n.source_version=1 AND n.epoch_id=e.epoch_id AND n.projection='DAILY' AND n.journal_entity=c.expense_id AND n.operation_kind='CONFIRM' AND n.claim_mode='REVIEW'))
 AND (SELECT count(*) FROM continuous_canary_operator)=1 AND (SELECT count(*) FROM stable_workbook_claims)=1 AND (SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW'))=1 AND (SELECT count(*) FROM stable_recovery_operations WHERE state='ADMITTED')=1
 AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=c.expense_id AND other.entity_version<>1)
 AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='PROCESSING') AND NOT EXISTS(SELECT 1 FROM staff_config_sync_outbox WHERE status='PROCESSING')
 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes other WHERE other.state<>'VERIFIED' AND NOT(other.spreadsheet_id=p.spreadsheet_id AND other.entity_type='EXPENSE' AND other.entity_id=p.entity_id AND other.projection='DAILY' AND other.operation_token=p.operation_token))
 AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED')
 AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||c.expense_id||':1' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')`).bind(book).all<{expense_id:string;trace_id:string;operation_token:string;projection_state:string;notice_state:string|null}>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||rows.success!==true||rows.results?.length!==1)return 'HELD';
 const x=rows.results[0]!;
 if(!/^exp_canary_[a-f0-9]{32}$/.test(x.expense_id)||!/^trace_canary_[a-f0-9]{32}$/.test(x.trace_id)||!x.operation_token||x.notice_state!==expected[phase]||x.projection_state!==(phase==='VERIFY'?'IN_FLIGHT':'VERIFIED'))return 'HELD';
 const job:SheetsSyncJob={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:x.expense_id,entityVersion:1,traceId:x.trace_id},budget=new ReviewRequestBudget(40);
 if(phase==='VERIFY')return await verifyReviewedDailyProjection(env,job,x.operation_token,'PAUSED',{kind:'continuous-expense',budget},'REVIEW',true)?'IN_PROGRESS':'HELD';
 if(phase==='PROBE_STATUS'){
  const proof={stage:'AUTH'};let ticket:{release:()=>void}|undefined;
  try{
   const intent=await readIntent(env,book,x.operation_token),revision=await sourceRevision(env),selected=await expectedReady(env,'REVIEW');
   if(!intent||revision===null||!selected||!budget.reserveMutation())return 'HELD';
   await getGoogleAccessToken(env,budget);ticket=budget.claimMutation();
   const ok=await verifyReviewedDailyProjection(env,job,x.operation_token,'PAUSED',{kind:'continuous-expense',budget},'REVIEW',true,proof);
   if(!ok)return 'HELD';
   proof.stage='NOTICE_STYLE';
   if(await expectedReady(env,'REVIEW')!==selected||revision!==await sourceRevision(env)||await stableNoticeStyleFingerprint(env,intent.notice_identity,paused,intent.next_stamp,budget)!==intent.style_digest||revision!==await sourceRevision(env)||env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)return 'HELD';
   proof.stage='COMPLETE';return 'READY';
  }finally{ticket?.release();budget.releaseMutation();if(diagnostic){diagnostic.stage=proof.stage;diagnostic.remaining=budget.remaining;}}
 }
 return closePhase(env,job,x.operation_token,budget,'REVIEW',true);
}
/** Narrow positive-only recovery for the synthetic v1 RAW timeout. No caller
 * chooses an identity and no uncertain provider request is ever re-sent. */
export async function closeExactCanaryRawIncident(env:Env & {CANARY_UNWRITTEN_RECOVERY_ENABLED?:string;CONTINUOUS_CANARY_OPERATOR_ENABLED?:string},phase:'VERIFY'|'TIME'|'TIME_READBACK'|'PROBE_STATUS'|'STATUS'|'COMMIT'):Promise<ReviewCloseOutcome|'READY'>{
 if(env.CANARY_UNWRITTEN_RECOVERY_ENABLED!=='true'||env.CONTINUOUS_CANARY_OPERATOR_ENABLED!=='true'||env.CONTINUOUS_PUBLICATION_ENABLED==='true'||env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED==='true')return 'DISABLED';
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;if(!book)return 'HELD';
 const expected={VERIFY:null,TIME:null,TIME_READBACK:'TIME_IN_FLIGHT',PROBE_STATUS:'TIME_VERIFIED',STATUS:'TIME_VERIFIED',COMMIT:'STATUS_ACKED'} as const;
 if(!Object.hasOwn(expected,phase))return 'HELD';
 const rows=await db.prepare(`SELECT c.expense_id,c.trace_id,w.operation_token,p.state projection_state,n.state notice_state
 FROM continuous_canary_operator c JOIN expense_events src ON src.expense_id=c.expense_id AND src.status='CONFIRMED' AND src.version=1
 JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=c.expense_id AND j.entity_version=1 AND j.status='REVIEW' AND j.last_error='STABLE_SYNC_REVIEW' AND j.lease_token IS NULL AND j.lease_until IS NULL
 JOIN stable_workbook_claims w ON w.spreadsheet_id=c.spreadsheet_id AND w.state='REVIEW' AND w.phase='OPERATION' AND w.review_reason='TIMEOUT'
 JOIN stable_recovery_epochs e ON e.spreadsheet_id=c.spreadsheet_id AND e.target_type='EXPENSE' AND e.target_key=c.expense_id AND e.target_version=1 AND e.state='ARMED'
 JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=w.operation_token AND o.state='ADMITTED'
 JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=c.expense_id AND p.projection='EXPENSE_RAW' AND p.source_version=1 AND p.operation_token=w.operation_token AND p.state IN ('IN_FLIGHT','VERIFIED')
 JOIN continuous_ledger_write_evidence d ON d.spreadsheet_id=p.spreadsheet_id AND d.entity_id=p.entity_id AND d.projection=p.projection AND d.operation_kind='CONFIRM' AND d.source_version=p.source_version AND d.operation_token=p.operation_token AND d.sheet_id=p.sheet_id AND d.sheet_name=p.sheet_name AND d.sheet_id=2026111901 AND d.sheet_name='V52_EXPENSE_RAW_ต่อเนื่อง' AND d.target_row=2 AND d.before_rows=1000 AND d.write_mode='REPLACE'
 JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=d.spreadsheet_id AND m.entity_id=d.entity_id AND m.sheet_id=d.sheet_id AND m.source_version=d.source_version AND m.operation_token=d.operation_token
 JOIN stable_projection_writes daily ON daily.spreadsheet_id=c.spreadsheet_id AND daily.entity_type='EXPENSE' AND daily.entity_id=c.expense_id AND daily.projection='DAILY' AND daily.source_version=1 AND daily.state='VERIFIED'
 JOIN continuous_review_notice_close previous ON previous.spreadsheet_id=c.spreadsheet_id AND previous.expense_id=c.expense_id AND previous.projection='DAILY' AND previous.source_version=1 AND previous.state='COMPLETE'
 LEFT JOIN continuous_review_notice_close n ON n.spreadsheet_id=c.spreadsheet_id AND n.operation_token=w.operation_token
 WHERE c.spreadsheet_id=? AND c.state='ARMED_CONFIRM' AND src.description='[SYSTEM TEST] Synthetic expense - cancel after verification' AND src.amount_satang=100 AND src.trace_id=c.trace_id AND src.line_user_id=c.line_user_id
 AND (n.operation_token IS NULL OR (n.expense_id=c.expense_id AND n.source_version=1 AND n.epoch_id=e.epoch_id AND n.projection='EXPENSE_RAW' AND n.journal_entity=c.expense_id AND n.operation_kind='CONFIRM' AND n.claim_mode='REVIEW'))
 AND (SELECT count(*) FROM continuous_canary_operator)=1 AND (SELECT count(*) FROM stable_workbook_claims)=1 AND (SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW'))=1 AND (SELECT count(*) FROM stable_recovery_operations WHERE state='ADMITTED')=1
 AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=c.expense_id AND other.entity_version<>1)
 AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='PROCESSING') AND NOT EXISTS(SELECT 1 FROM staff_config_sync_outbox WHERE status='PROCESSING')
 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes other WHERE other.state<>'VERIFIED' AND NOT(other.spreadsheet_id=p.spreadsheet_id AND other.entity_type='EXPENSE' AND other.entity_id=p.entity_id AND other.projection='EXPENSE_RAW' AND other.operation_token=p.operation_token))
 AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED')
 AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||c.expense_id||':1' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')`).bind(book).all<{expense_id:string;trace_id:string;operation_token:string;projection_state:string;notice_state:string|null}>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||rows.success!==true||rows.results?.length!==1)return 'HELD';
 const x=rows.results[0]!;
 if(!/^exp_canary_[a-f0-9]{32}$/.test(x.expense_id)||!/^trace_canary_[a-f0-9]{32}$/.test(x.trace_id)||!x.operation_token||x.notice_state!==expected[phase]||x.projection_state!==(phase==='VERIFY'?'IN_FLIGHT':'VERIFIED'))return 'HELD';
 const job:SheetsSyncJob={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:x.expense_id,entityVersion:1,traceId:x.trace_id},budget=new ReviewRequestBudget(40),policy:ContinuousSheetsReadPolicy={kind:'continuous-expense',budget};
 if(phase==='VERIFY')return await verifyReviewedLedgerProjection(env,job,x.operation_token,'EXPENSE_RAW','CONFIRM',undefined,'PAUSED',policy,'REVIEW')?'IN_PROGRESS':'HELD';
 if(phase==='PROBE_STATUS'){
  let ticket:{release:()=>void}|undefined;
  try{const intent=await readIntent(env,book,x.operation_token),revision=await sourceRevision(env),selected=await expectedReady(env,'REVIEW');
   if(!intent||revision===null||!selected||!budget.reserveMutation())return 'HELD';
   await getGoogleAccessToken(env,budget);ticket=budget.claimMutation();
   if(!await verifyReviewedLedgerProjection(env,job,x.operation_token,'EXPENSE_RAW','CONFIRM',undefined,'PAUSED',policy,'REVIEW'))return 'HELD';
   if(await expectedReady(env,'REVIEW')!==selected||revision!==await sourceRevision(env)||await stableNoticeStyleFingerprint(env,intent.notice_identity,paused,intent.next_stamp,budget)!==intent.style_digest||revision!==await sourceRevision(env)||env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)return 'HELD';
   return 'READY';
  }finally{ticket?.release();budget.releaseMutation();}
 }
 return closePhase(env,job,x.operation_token,budget,'REVIEW');
}

async function closePhase(env:Env,job:SheetsSyncJob,token:string,budget:ReviewRequestBudget,authority:NormalNoticeAuthority,allowExtraBlankTail=false):Promise<ReviewCloseOutcome>{
 const policy:ContinuousSheetsReadPolicy={kind:'continuous-expense',budget};
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env),identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]),stable=()=>env.DB===db&&scope(env)===initial&&JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion])===identity;
 if(env.SHEETS_SYNC_ENABLED!=='true'||!book||env.SHEET_EXPENSE_DAILY!=='รายวัน'||env.STABLE_PHASE1_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||env.STABLE_SHEETS_PACING_ENABLED!=='true'||env.CONTINUOUS_DAILY_ENABLED!=='true'||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<1||!token)return 'HELD';
 let intent=await readIntent(env,book,token);if(!stable())return 'HELD';
 if(intent&&(intent.state==='FINAL_COMMITTED'||intent.state==='CLEANUP_IN_FLIGHT')&&intent.claim_mode!==authority)return 'HELD';
 if(intent&&(intent.state==='FINAL_COMMITTED'||intent.state==='CLEANUP_IN_FLIGHT'))return intent.claim_mode==='REVIEW'&&intent.projection==='PUBLICATION'&&intent.operation_kind==='CANCEL'?finishRevokeReviewCleanup(env,job,token,budget,intent):finishFinalCleanup(env,job,token,budget,intent);
 if(intent?.state==='COMPLETE')return intent.expense_id===job.entityKey&&intent.source_version===job.entityVersion&&intent.claim_mode===authority?'ALREADY_COMPLETED':'HELD';
 const stage=await findStage(env,job,token,authority);if(!stage||!stable())return 'HELD';
 const reviewPublication=authority==='REVIEW'&&stage.projection==='PUBLICATION'&&stage.operation_kind==='CANCEL'&&env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED==='true';
 const readyAuthority=reviewPublication?'HANDOFF':authority,needsNonce=stage.projection==='FINAL'||reviewPublication;
 if(intent&&(intent.expense_id!==job.entityKey||intent.source_version!==job.entityVersion||intent.epoch_id!==stage.epoch_id||intent.projection!==stage.projection||intent.journal_entity!==stage.journal_entity||intent.operation_kind!==stage.operation_kind||intent.claim_mode!==authority||intent.notice_identity!==stage.notice_identity))return 'HELD';
 if(!intent){
  const nonce=crypto.getRandomValues(new Uint8Array(16)),nonceHex=Array.from(nonce,x=>x.toString(16).padStart(2,'0')).join(''),next=`${timestamp()} • ${nonceHex}`;
  const ready=await expectedReady(env,readyAuthority,needsNonce?nonceHex:undefined);if(!ready||next===stage.notice_stamp||!stable())return 'HELD';
  if(!budget.reserveMutation())return 'HELD';
  try{
   await batchUpdateSpreadsheetWithReply(env,[request(2,stage.notice_stamp,next)],async()=>{
    const revision=await sourceRevision(env);
    if(revision===null||await expectedReady(env,readyAuthority,needsNonce?nonceHex:undefined)!==ready||!await verifyStage(env,job,token,stage,'PAUSED',policy,authority,allowExtraBlankTail)||revision!==await sourceRevision(env)||!stable())throw Error('REVIEW_CLOSE_TIME_PREIMAGE');
    const style=await stableNoticeStyleFingerprint(env,stage.notice_identity,paused,stage.notice_stamp,budget);
    if(!style||revision!==await sourceRevision(env)||!stable())throw Error('REVIEW_CLOSE_TIME_NOTICE');
    const created=await db.prepare(`INSERT INTO continuous_review_notice_close(operation_token,spreadsheet_id,epoch_id,expense_id,source_version,projection,journal_entity,operation_kind,claim_mode,ready_status,notice_identity,paused_stamp,next_stamp,style_digest,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'TIME_IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${integrity} AND EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1 AND revision=?)`).bind(token,book,stage.epoch_id,job.entityKey,job.entityVersion,stage.projection,stage.journal_entity,stage.operation_kind,authority,ready,stage.notice_identity,stage.notice_stamp,next,style,revision).run();
    if(created.success!==true||created.meta?.changes!==1||!stable())throw Error('REVIEW_CLOSE_TIME_INTENT');
   },budget);
  }catch(error){if(authority==='HANDOFF')throw error;/* REVIEW callers preserve positive-only readback behavior. */}finally{budget.releaseMutation();}
  intent=await readIntent(env,book,token);
  return stable()&&intent?.state==='TIME_IN_FLIGHT'?'IN_PROGRESS':'HELD';
 }
 if(intent.state==='TIME_IN_FLIGHT'){
  if(await stableNoticeStyleFingerprint(env,intent.notice_identity,paused,intent.next_stamp,budget)!==intent.style_digest||!stable())return 'HELD';
  let changed:D1Result[];
  try{changed=await db.batch([
   db.prepare(`UPDATE stable_workbook_claims AS c SET notice_stamp=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND ${reviewedClaimState('c',authority)} AND notice_stamp=? AND notice_identity=? AND EXISTS(SELECT 1 FROM continuous_review_notice_close x WHERE x.operation_token=? AND x.state='TIME_IN_FLIGHT' AND x.spreadsheet_id=?)`).bind(intent.next_stamp,book,token,intent.paused_stamp,intent.notice_identity,token,book),
   db.prepare(`UPDATE continuous_review_notice_close SET state='TIME_VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='TIME_IN_FLIGHT' AND changes()=1 AND ${integrity}`).bind(book,token),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);}catch(error){if(authority==='HANDOFF'&&stable()&&await handoffMilestone(env,book,job,intent,'TIME_VERIFIED'))return 'IN_PROGRESS';throw error;}
  if(!stable()||changed.length!==3||changed.some(x=>x.success!==true)||changed[0]!.meta?.changes!==1||changed[1]!.meta?.changes!==1){if(authority==='HANDOFF'&&stable()&&await handoffMilestone(env,book,job,intent,'TIME_VERIFIED'))return 'IN_PROGRESS';return 'HELD';}
  return stable()?'IN_PROGRESS':'HELD';
 }
 if(intent.state==='TIME_VERIFIED'){
  const selected=await expectedReady(env,readyAuthority,needsNonce?intent.next_stamp.slice(-32):undefined);if(!selected||!stable())return 'HELD';
  if(!budget.reserveMutation())return 'HELD';
  try{
   const reply=await batchUpdateSpreadsheetWithReply(env,[request(1,paused,selected)],async()=>{
    const revision=await sourceRevision(env);
    if(revision===null||await expectedReady(env,readyAuthority,needsNonce?intent!.next_stamp.slice(-32):undefined)!==selected||!await verifyStage(env,job,token,stage,'PAUSED',policy,authority,allowExtraBlankTail)||revision!==await sourceRevision(env)||await stableNoticeStyleFingerprint(env,intent!.notice_identity,paused,intent!.next_stamp,budget)!==intent!.style_digest||revision!==await sourceRevision(env)||!stable())throw Error('REVIEW_CLOSE_STATUS_PREIMAGE');
    const updated=await db.batch([
     db.prepare(`INSERT INTO continuous_notice_status_attempts(operation_token,spreadsheet_id,initial_ready_status,dispatch_ready_status,next_stamp,source_revision,created_at) SELECT ?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${integrity}`).bind(token,book,intent!.ready_status,selected,intent!.next_stamp,revision),
     db.prepare(`UPDATE continuous_review_notice_close SET state='STATUS_IN_FLIGHT',ready_status=?,source_revision=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='TIME_VERIFIED' AND changes()=1 AND ${integrity} AND EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1 AND revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE spreadsheet_id=? AND operation_token=? AND ${reviewedClaimState('c',authority)} AND notice_stamp=? AND notice_identity=?)`).bind(selected,revision,book,token,revision,book,token,intent!.next_stamp,intent!.notice_identity),
     db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
    ]);
    if(updated.length!==3||updated.some(x=>x.success!==true)||updated[0]!.meta?.changes!==1||updated[1]!.meta?.changes!==1||!stable())throw Error('REVIEW_CLOSE_STATUS_INTENT');
   },budget);
   if(!oneChange(reply)||!stable())return 'HELD';
   // A matching readback alone cannot rule out an earlier delayed POST to a
   // constant status preimage. Only a positive provider reply may be saved.
   let acknowledged:D1Result;
   try{acknowledged=await db.prepare(`UPDATE continuous_review_notice_close SET state='STATUS_ACKED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_IN_FLIGHT' AND ${integrity}`).bind(book,token).run();}
   catch(error){if(authority==='HANDOFF'&&stable()&&await handoffMilestone(env,book,job,intent,'STATUS_ACKED'))return 'IN_PROGRESS';throw error;}
   if(acknowledged.success!==true||acknowledged.meta?.changes!==1||!stable()){if(authority==='HANDOFF'&&stable()&&await handoffMilestone(env,book,job,intent,'STATUS_ACKED'))return 'IN_PROGRESS';return 'HELD';}
  }catch(error){if(authority==='HANDOFF')throw error;/* Never replay an uncertain POST. */}finally{budget.releaseMutation();}
  const pending=await readIntent(env,book,token);
  return stable()&&pending?.state==='STATUS_ACKED'?'IN_PROGRESS':'HELD';
 }
 if(intent.state!=='STATUS_ACKED'||intent.source_revision===null||stage.notice_stamp!==intent.next_stamp&&stage.notice_stamp!==intent.paused_stamp)return 'HELD';
  const publicationEnabled=stage.projection==='FINAL'&&env.CONTINUOUS_PUBLICATION_ENABLED==='true';
  const marker=publicationEnabled?await db.prepare(`SELECT m.marker,m.transition_id,m.row_number FROM continuous_publication_markers m JOIN continuous_publication_intents i ON i.transition_id=m.transition_id AND i.spreadsheet_id=m.spreadsheet_id AND i.entity_id=m.entity_id AND i.source_version=m.version AND i.sheet_id=m.sheet_id AND i.sheet_name=m.sheet_name AND i.row_number=m.row_number AND i.after_value=m.marker AND i.state='VERIFIED' JOIN continuous_publication_targets t ON t.spreadsheet_id=m.spreadsheet_id AND t.sheet_id=m.sheet_id AND t.sheet_name=m.sheet_name JOIN continuous_final_notice_evidence z ON z.spreadsheet_id=m.spreadsheet_id AND z.expense_id=m.entity_id AND z.source_version=m.version AND z.source_digest=i.source_digest WHERE z.operation_token=? AND z.operation_kind=? AND m.spreadsheet_id=? AND m.entity_id=? AND m.version=? AND ${publicationGuardIntegrity} AND m.state=CASE z.operation_kind WHEN 'CONFIRM' THEN 'PUBLISHED' ELSE 'REVOKED' END AND i.kind=CASE z.operation_kind WHEN 'CONFIRM' THEN 'PUBLISH' ELSE 'REVOKE' END AND NOT EXISTS(SELECT 1 FROM continuous_publication_intents p WHERE p.spreadsheet_id=m.spreadsheet_id AND p.entity_id=m.entity_id AND p.state IN ('IN_FLIGHT','REVIEW'))`).bind(token,stage.operation_kind,book,job.entityKey,job.entityVersion).first<{marker:string;transition_id:string;row_number:number}>():null;
  if(publicationEnabled&&(!marker||!stable()))return 'HELD';
  const markerGuard=publicationEnabled?finalPublicationCommitGuard:'';
 const currentRevision=await sourceRevision(env);
 if(currentRevision===null||await expectedReady(env,readyAuthority,needsNonce?intent.next_stamp.slice(-32):undefined)!==intent.ready_status||await stableNoticeStyleFingerprint(env,intent.notice_identity,intent.ready_status,intent.next_stamp,budget)!==intent.style_digest||!await verifyStage(env,job,token,stage,'REVIEW_READY',policy,authority,allowExtraBlankTail)||currentRevision!==await sourceRevision(env)||await stableNoticeStyleFingerprint(env,intent.notice_identity,intent.ready_status,intent.next_stamp,budget)!==intent.style_digest||!stable())return 'HELD';
 if(stage.projection==='FINAL'){
  let finished:D1Result[];
  try{finished=await db.batch([
   db.prepare(`UPDATE stable_recovery_operations SET state='VERIFIED',verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_token=? AND epoch_id=? AND state='ADMITTED' AND EXISTS(SELECT 1 FROM continuous_review_notice_close x JOIN continuous_final_notice_evidence z ON z.spreadsheet_id=x.spreadsheet_id AND z.operation_token=x.operation_token AND z.epoch_id=x.epoch_id JOIN stable_workbook_claims c ON c.spreadsheet_id=x.spreadsheet_id AND c.operation_token=x.operation_token JOIN stable_recovery_epochs e ON e.epoch_id=x.epoch_id AND e.spreadsheet_id=x.spreadsheet_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=x.expense_id AND j.entity_version=x.source_version JOIN expense_events src ON src.expense_id=x.expense_id AND src.version=x.source_version WHERE x.operation_token=? AND x.spreadsheet_id=? AND x.state='STATUS_ACKED' AND x.claim_mode='HANDOFF' AND x.projection='FINAL' AND x.source_revision=? AND z.expense_id=x.expense_id AND z.source_version=x.source_version AND z.operation_kind=x.operation_kind AND ${reviewedClaimState('c',authority)} AND c.notice_stamp=x.next_stamp AND c.notice_identity=x.notice_identity AND substr(x.ready_status,-32)=substr(x.next_stamp,-32) AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=x.expense_id AND e.target_version=x.source_version AND ${reviewedJobState('j',authority)} AND (x.operation_kind='CONFIRM' AND src.status='CONFIRMED' OR x.operation_kind='CANCEL' AND src.status='CANCELLED')) AND EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1 AND revision=?) AND ((substr(?,1,length('พร้อมแก้ไข • กำลังซิงก์ • รหัส '))='พร้อมแก้ไข • กำลังซิงก์ • รหัส ' AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW')) OR (substr(?,1,length('พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ • รหัส '))='พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ • รหัส ' AND EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW'))) AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=? AND p.state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||?||':'||? AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') AND ${integrity}${markerGuard}`).bind(token,intent.epoch_id,token,book,intent.source_revision,currentRevision,intent.ready_status,intent.ready_status,book,book,job.entityKey,job.entityVersion,...(marker?[token,stage.operation_kind,book,job.entityKey,job.entityVersion,marker.marker,marker.transition_id,marker.row_number]:[])),
   db.prepare(`UPDATE sync_jobs AS j SET status='COMPLETED',last_error=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND ${reviewedJobState('j',authority)} AND changes()=1`).bind(job.entityKey,job.entityVersion),
   db.prepare("UPDATE stable_recovery_epochs SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE epoch_id=? AND spreadsheet_id=? AND state='ARMED' AND changes()=1").bind(intent.epoch_id,book),
   db.prepare(`UPDATE continuous_review_notice_close SET state='FINAL_COMMITTED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_ACKED' AND changes()=1 AND ${integrity}`).bind(book,token),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);}catch(error){if(stable()&&await handoffMilestone(env,book,job,intent,'FINAL_COMMITTED'))return 'IN_PROGRESS';throw error;}
  if(!stable()||finished.length!==5||finished.some(x=>x.success!==true)||finished.slice(0,4).some(x=>x.meta?.changes!==1)){if(stable()&&await handoffMilestone(env,book,job,intent,'FINAL_COMMITTED'))return 'IN_PROGRESS';throw Error('FINAL_NOTICE_COMMIT_UNCERTAIN');}
  return 'IN_PROGRESS';
 }
 const reviewPublicationCommit=env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED==='true'?"x.claim_mode='REVIEW' AND x.operation_kind='CANCEL' AND EXISTS(SELECT 1 FROM continuous_revoke_review_close_activation a WHERE a.singleton=1)":'0';
 const outcome=await db.batch([
  db.prepare(`UPDATE stable_recovery_operations SET state='VERIFIED',verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_token=? AND epoch_id=? AND state='ADMITTED' AND EXISTS(SELECT 1 FROM continuous_review_notice_close x JOIN stable_workbook_claims c ON c.spreadsheet_id=x.spreadsheet_id AND c.operation_token=x.operation_token JOIN stable_recovery_epochs e ON e.epoch_id=x.epoch_id AND e.spreadsheet_id=x.spreadsheet_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=x.expense_id AND j.entity_version=x.source_version JOIN expense_events src ON src.expense_id=x.expense_id AND src.version=x.source_version WHERE x.operation_token=? AND x.spreadsheet_id=? AND x.state='STATUS_ACKED' AND x.source_revision=? AND ${reviewedClaimState('c',authority)} AND c.notice_stamp=x.next_stamp AND c.notice_identity=x.notice_identity AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=x.expense_id AND e.target_version=x.source_version AND ${reviewedJobState('j',authority)} AND (x.operation_kind='CONFIRM' AND src.status='CONFIRMED' AND EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=x.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=x.journal_entity AND p.projection=x.projection AND p.source_version=x.source_version AND p.operation_token=x.operation_token AND p.state='VERIFIED') OR x.operation_kind='CANCEL' AND src.status='CANCELLED' AND EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=x.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=x.journal_entity AND p.projection=x.projection AND p.cancellation_version=x.source_version AND p.operation_token=x.operation_token AND p.state='VERIFIED') OR x.projection='PUBLICATION' AND (x.claim_mode='HANDOFF' OR (${reviewPublicationCommit})) AND EXISTS(SELECT 1 FROM continuous_publication_intents i JOIN continuous_publication_markers m ON m.spreadsheet_id=i.spreadsheet_id AND m.entity_id=i.entity_id AND m.transition_id=i.transition_id AND m.sheet_id=i.sheet_id AND m.sheet_name=i.sheet_name AND m.row_number=i.row_number AND m.version=i.source_version AND m.marker=i.after_value AND m.state=CASE WHEN i.kind='STAGE' THEN 'STAGED' WHEN i.kind='PUBLISH' THEN 'PUBLISHED' ELSE 'REVOKED' END WHERE ((x.claim_mode='HANDOFF' AND EXISTS(SELECT 1 FROM continuous_normal_notice_handoffs h WHERE h.spreadsheet_id=i.spreadsheet_id AND h.operation_token=i.claim_token AND h.expense_id=i.entity_id AND h.source_version=i.source_version AND h.projection='PUBLICATION' AND h.journal_entity=i.transition_id AND h.operation_kind=x.operation_kind)) OR (x.claim_mode='REVIEW' AND i.kind='REVOKE' AND EXISTS(SELECT 1 FROM continuous_publication_review_evidence p WHERE p.transition_id=i.transition_id AND p.source_digest=i.source_digest))) AND i.transition_id=x.journal_entity AND i.spreadsheet_id=x.spreadsheet_id AND i.entity_id=x.expense_id AND i.source_version=x.source_version AND i.claim_token=x.operation_token AND i.state='VERIFIED' AND ((i.kind IN ('STAGE','PUBLISH') AND x.operation_kind='CONFIRM' AND src.status='CONFIRMED') OR (i.kind='REVOKE' AND x.operation_kind='CANCEL' AND src.status='CANCELLED'))) AND (SELECT count(*) FROM continuous_publication_intents i WHERE i.spreadsheet_id=x.spreadsheet_id AND i.claim_token=x.operation_token)=1)) AND EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1 AND revision=?) AND (((? IN ('พร้อมแก้ไข','พร้อมแก้ไข • กำลังซิงก์') OR substr(?,1,length('พร้อมแก้ไข • กำลังซิงก์ • รหัส '))='พร้อมแก้ไข • กำลังซิงก์ • รหัส ') AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW')) OR ((? IN ('พร้อมแก้ไข • มีรายการรอตรวจ','พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ') OR substr(?,1,length('พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ • รหัส '))='พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ • รหัส ') AND EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW'))) AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=? AND p.state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||?||':'||? AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') AND ${integrity}`).bind(token,intent.epoch_id,token,book,intent.source_revision,currentRevision,intent.ready_status,intent.ready_status,intent.ready_status,intent.ready_status,book,book,job.entityKey,job.entityVersion),
  db.prepare(`UPDATE sync_jobs AS j SET status='PENDING',last_error='STABLE_RECOVERY_VERIFIED_CONTINUE',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND ${reviewedJobState('j',authority)} AND changes()=1`).bind(job.entityKey,job.entityVersion),
  reviewPublication?db.prepare(`UPDATE continuous_review_notice_close SET state='FINAL_COMMITTED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_ACKED' AND changes()=1 AND ${integrity}`).bind(book,token):db.prepare(`DELETE FROM stable_workbook_claims AS c WHERE spreadsheet_id=? AND operation_token=? AND ${reviewedClaimState('c',authority)} AND notice_stamp=? AND notice_identity=? AND changes()=1`).bind(book,token,intent.next_stamp,intent.notice_identity),
  reviewPublication?db.prepare(`SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok`):db.prepare(`UPDATE continuous_review_notice_close SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_ACKED' AND changes()=1 AND ${integrity}`).bind(book,token),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 // D1 counts changes made by AFTER DELETE triggers too. Releasing one
 // REVIEW claim can also close its one open sync-alert incident. The next
 // guarded statement still requires SQLite changes()=1 for the claim itself.
 const countsValid=outcome.slice(0,reviewPublication?3:4).every((x,i)=>i===2&&!reviewPublication?(x.meta?.changes===1||x.meta?.changes===2):x.meta?.changes===1);
 if(!stable()||outcome.length!==5||outcome.some(x=>x.success!==true)||!countsValid)throw Error('REVIEW_CLOSE_COMMIT_UNCERTAIN');
 return reviewPublication?'IN_PROGRESS':'RESUMED';
}
