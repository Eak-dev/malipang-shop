import type {Env,SheetsSyncJob} from '../types';
import {verifyPublicationHandoff} from './continuous-publication-handoff';
import {verifyFinalHandoff} from './continuous-final-positive-recovery';
import {normalNoticeHandoffEnabled} from './continuous-normal-notice-handoff';
import {reviewedJobState,reviewedClaimState,type NormalNoticeAuthority} from './normal-notice-authority';
import {ReviewRequestBudget,ReviewRequestBudgetError} from './review-request-budget';
import type {ContinuousSheetsReadPolicy} from './client';
import {batchUpdateSpreadsheetWithReply} from './client';
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
const scope=(e:Env)=>JSON.stringify([e.GOOGLE_SPREADSHEET_ID,e.SHEET_EXPENSE_DAILY,e.GOOGLE_SERVICE_ACCOUNT_EMAIL,e.GOOGLE_PRIVATE_KEY_BASE64,e.STABLE_PHASE1_ENABLED,e.STABLE_RECOVERY_GATE_ENABLED,e.STABLE_SHEETS_PACING_ENABLED,e.CONTINUOUS_DAILY_ENABLED,e.CONTINUOUS_DAILY_SHEET,e.CONTINUOUS_DAILY_SHEET_ID,e.CONTINUOUS_REVIEW_CLOSE_ENABLED,e.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED,e.CONTINUOUS_NOTICE_DISPATCH_ENABLED,e.SHEETS_SYNC_ENABLED,e.APP_ENV,e.RUNTIME_MODE]);
function timestamp():string{const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date()),v=(name:string)=>p.find(x=>x.type===name)?.value;return `${v('year')}-${v('month')}-${v('day')} ${v('hour')}:${v('minute')}:${v('second')}`;}
const request=(column:number,find:string,replacement:string)=>({findReplace:{range:{sheetId:dailySheetId,startRowIndex:0,endRowIndex:1,startColumnIndex:column,endColumnIndex:column+1},find,replacement,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:false}});

const oneChange=(reply:unknown):boolean=>{const r=reply&&typeof reply==='object'?(reply as {replies?:Array<{findReplace?:{valuesChanged?:unknown;occurrencesChanged?:unknown;formulasChanged?:unknown}}>}).replies:undefined;return Array.isArray(r)&&r.length===1&&r[0]?.findReplace?.valuesChanged===1&&r[0].findReplace.occurrencesChanged===1&&Number(r[0].findReplace.formulasChanged??0)===0;};

async function sourceRevision(env:Env):Promise<number|null>{const r=await env.DB.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').first<{revision:number}>();return r&&Number.isSafeInteger(r.revision)&&r.revision>=0?r.revision:null;}
async function findStage(env:Env,job:SheetsSyncJob,token:string,authority:NormalNoticeAuthority):Promise<Stage|null>{
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
  JOIN continuous_normal_notice_handoffs h ON h.spreadsheet_id=i.spreadsheet_id AND h.operation_token=i.claim_token AND h.expense_id=i.entity_id AND h.source_version=i.source_version AND h.projection='PUBLICATION' AND h.journal_entity=i.transition_id AND h.operation_kind=CASE WHEN i.kind='REVOKE' THEN 'CANCEL' ELSE 'CONFIRM' END
  WHERE c.spreadsheet_id=? AND c.operation_token=? AND ${reviewedClaimState('c',authority)} AND ?='HANDOFF'
  UNION ALL
  SELECT e.epoch_id,'FINAL' AS projection,z.expense_id AS journal_entity,z.operation_kind,c.notice_stamp,c.notice_identity,'VERIFIED' AS state
  FROM stable_workbook_claims c JOIN stable_recovery_epochs e ON e.spreadsheet_id=c.spreadsheet_id AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=? AND e.target_version=?
  JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED'
  JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.target_key AND j.entity_version=e.target_version AND ${reviewedJobState('j',authority)}
  JOIN continuous_final_notice_evidence z ON z.spreadsheet_id=c.spreadsheet_id AND z.operation_token=c.operation_token AND z.epoch_id=e.epoch_id AND z.expense_id=e.target_key AND z.source_version=e.target_version
  WHERE c.spreadsheet_id=? AND c.operation_token=? AND ${reviewedClaimState('c',authority)} AND ?='HANDOFF'`).bind(job.entityKey,job.entityVersion,env.GOOGLE_SPREADSHEET_ID,token,job.entityKey,job.entityVersion,env.GOOGLE_SPREADSHEET_ID,token,job.entityKey,job.entityVersion,env.GOOGLE_SPREADSHEET_ID,token,authority,job.entityKey,job.entityVersion,env.GOOGLE_SPREADSHEET_ID,token,authority).all<Stage>();
 if(rows.success!==true||!Array.isArray(rows.results)||rows.results.length!==1)return null;
 const s=rows.results[0]!;if(!s.notice_stamp||!s.notice_identity||!['DAILY','EXPENSE_RAW','DETAIL','FINAL','PUBLICATION'].includes(s.projection)||!['CONFIRM','CANCEL'].includes(s.operation_kind)||(s.projection==='PUBLICATION'?!s.journal_entity:s.projection==='DETAIL'?!s.journal_entity.startsWith(`${job.entityKey}|`):s.journal_entity!==job.entityKey))return null;
 return s;
}
async function verifyStage(env:Env,job:SheetsSyncJob,token:string,s:Stage,mode:'PAUSED'|'REVIEW_READY',policy:ContinuousSheetsReadPolicy,authority:NormalNoticeAuthority):Promise<boolean>{
 if(s.projection==='PUBLICATION')return authority==='HANDOFF'&&verifyPublicationHandoff(env,job,token,s.journal_entity,mode,policy,authority);
 if(s.projection==='FINAL')return authority==='HANDOFF'&&verifyFinalHandoff(env,job,token,mode,policy);
 if(s.projection==='DAILY')return s.operation_kind==='CONFIRM'?verifyReviewedDailyProjection(env,job,token,mode,policy,authority):verifyReviewedDailyCancellation(env,job,token,mode,policy,authority);
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

/** Positive-only, exact-target close for one verified expense operation.
 * Missing proof, an unmatched cell, uncertain writes or any source drift
 * leave the job and claim in REVIEW. This is not an external writer fence. */
export async function closeReviewedContinuousExpense(env:Env,job:SheetsSyncJob,token:string,budget?:ReviewRequestBudget,authority:NormalNoticeAuthority='REVIEW'):Promise<ReviewCloseOutcome>{
 if(env.CONTINUOUS_REVIEW_CLOSE_ENABLED!=='true')return 'DISABLED';
 if(!(budget instanceof ReviewRequestBudget)||!['REVIEW','HANDOFF'].includes(authority))return 'HELD';
 if(authority==='HANDOFF'&&!normalNoticeHandoffEnabled(env))return 'DISABLED';
 try{return await closePhase(env,job,token,budget,authority);}catch(error){if(error instanceof ReviewRequestBudgetError&&authority!=='HANDOFF')return 'HELD';throw error;}
}
async function closePhase(env:Env,job:SheetsSyncJob,token:string,budget:ReviewRequestBudget,authority:NormalNoticeAuthority):Promise<ReviewCloseOutcome>{
 const policy:ContinuousSheetsReadPolicy={kind:'continuous-expense',budget};
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=scope(env),identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]),stable=()=>env.DB===db&&scope(env)===initial&&JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion])===identity;
 if(env.SHEETS_SYNC_ENABLED!=='true'||!book||env.SHEET_EXPENSE_DAILY!=='รายวัน'||env.STABLE_PHASE1_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||env.STABLE_SHEETS_PACING_ENABLED!=='true'||env.CONTINUOUS_DAILY_ENABLED!=='true'||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<1||!token)return 'HELD';
 let intent=await readIntent(env,book,token);if(!stable())return 'HELD';
 if(intent&&(intent.state==='FINAL_COMMITTED'||intent.state==='CLEANUP_IN_FLIGHT'))return finishFinalCleanup(env,job,token,budget,intent);
 if(intent?.state==='COMPLETE')return intent.expense_id===job.entityKey&&intent.source_version===job.entityVersion&&intent.claim_mode===authority?'ALREADY_COMPLETED':'HELD';
 const stage=await findStage(env,job,token,authority);if(!stage||!stable())return 'HELD';
 if(intent&&(intent.expense_id!==job.entityKey||intent.source_version!==job.entityVersion||intent.epoch_id!==stage.epoch_id||intent.projection!==stage.projection||intent.journal_entity!==stage.journal_entity||intent.operation_kind!==stage.operation_kind||intent.claim_mode!==authority||intent.notice_identity!==stage.notice_identity))return 'HELD';
 if(!intent){
  const nonce=crypto.getRandomValues(new Uint8Array(16)),nonceHex=Array.from(nonce,x=>x.toString(16).padStart(2,'0')).join(''),next=`${timestamp()} • ${nonceHex}`;
  const ready=await expectedReady(env,authority,stage.projection==='FINAL'?nonceHex:undefined);if(!ready||next===stage.notice_stamp||!stable())return 'HELD';
  if(!budget.reserveMutation())return 'HELD';
  try{
   await batchUpdateSpreadsheetWithReply(env,[request(2,stage.notice_stamp,next)],async()=>{
    const revision=await sourceRevision(env);
    if(revision===null||await expectedReady(env,authority,stage.projection==='FINAL'?nonceHex:undefined)!==ready||!await verifyStage(env,job,token,stage,'PAUSED',policy,authority)||revision!==await sourceRevision(env)||!stable())throw Error('REVIEW_CLOSE_TIME_PREIMAGE');
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
  const selected=await expectedReady(env,authority,stage.projection==='FINAL'?intent.next_stamp.slice(-32):undefined);if(!selected||!stable())return 'HELD';
  if(!budget.reserveMutation())return 'HELD';
  try{
   const reply=await batchUpdateSpreadsheetWithReply(env,[request(1,paused,selected)],async()=>{
    const revision=await sourceRevision(env);
    if(revision===null||await expectedReady(env,authority,stage.projection==='FINAL'?intent!.next_stamp.slice(-32):undefined)!==selected||!await verifyStage(env,job,token,stage,'PAUSED',policy,authority)||revision!==await sourceRevision(env)||await stableNoticeStyleFingerprint(env,intent!.notice_identity,paused,intent!.next_stamp,budget)!==intent!.style_digest||revision!==await sourceRevision(env)||!stable())throw Error('REVIEW_CLOSE_STATUS_PREIMAGE');
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
 const currentRevision=await sourceRevision(env);
 if(currentRevision===null||await expectedReady(env,authority,stage.projection==='FINAL'?intent.next_stamp.slice(-32):undefined)!==intent.ready_status||await stableNoticeStyleFingerprint(env,intent.notice_identity,intent.ready_status,intent.next_stamp,budget)!==intent.style_digest||!await verifyStage(env,job,token,stage,'REVIEW_READY',policy,authority)||currentRevision!==await sourceRevision(env)||await stableNoticeStyleFingerprint(env,intent.notice_identity,intent.ready_status,intent.next_stamp,budget)!==intent.style_digest||!stable())return 'HELD';
 if(stage.projection==='FINAL'){
  let finished:D1Result[];
  try{finished=await db.batch([
   db.prepare(`UPDATE stable_recovery_operations SET state='VERIFIED',verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_token=? AND epoch_id=? AND state='ADMITTED' AND EXISTS(SELECT 1 FROM continuous_review_notice_close x JOIN continuous_final_notice_evidence z ON z.spreadsheet_id=x.spreadsheet_id AND z.operation_token=x.operation_token AND z.epoch_id=x.epoch_id JOIN stable_workbook_claims c ON c.spreadsheet_id=x.spreadsheet_id AND c.operation_token=x.operation_token JOIN stable_recovery_epochs e ON e.epoch_id=x.epoch_id AND e.spreadsheet_id=x.spreadsheet_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=x.expense_id AND j.entity_version=x.source_version JOIN expense_events src ON src.expense_id=x.expense_id AND src.version=x.source_version WHERE x.operation_token=? AND x.spreadsheet_id=? AND x.state='STATUS_ACKED' AND x.claim_mode='HANDOFF' AND x.projection='FINAL' AND x.source_revision=? AND z.expense_id=x.expense_id AND z.source_version=x.source_version AND z.operation_kind=x.operation_kind AND ${reviewedClaimState('c',authority)} AND c.notice_stamp=x.next_stamp AND c.notice_identity=x.notice_identity AND substr(x.ready_status,-32)=substr(x.next_stamp,-32) AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=x.expense_id AND e.target_version=x.source_version AND ${reviewedJobState('j',authority)} AND (x.operation_kind='CONFIRM' AND src.status='CONFIRMED' OR x.operation_kind='CANCEL' AND src.status='CANCELLED')) AND EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1 AND revision=?) AND ((? GLOB 'พร้อมแก้ไข • กำลังซิงก์ • รหัส *' AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW')) OR (? GLOB 'พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ • รหัส *' AND EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW'))) AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=? AND p.state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||?||':'||? AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') AND ${integrity}`).bind(token,intent.epoch_id,token,book,intent.source_revision,currentRevision,intent.ready_status,intent.ready_status,book,book,job.entityKey,job.entityVersion),
   db.prepare(`UPDATE sync_jobs AS j SET status='COMPLETED',last_error=NULL,next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND ${reviewedJobState('j',authority)} AND changes()=1`).bind(job.entityKey,job.entityVersion),
   db.prepare("UPDATE stable_recovery_epochs SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE epoch_id=? AND spreadsheet_id=? AND state='ARMED' AND changes()=1").bind(intent.epoch_id,book),
   db.prepare(`UPDATE continuous_review_notice_close SET state='FINAL_COMMITTED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_ACKED' AND changes()=1 AND ${integrity}`).bind(book,token),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);}catch(error){if(stable()&&await handoffMilestone(env,book,job,intent,'FINAL_COMMITTED'))return 'IN_PROGRESS';throw error;}
  if(!stable()||finished.length!==5||finished.some(x=>x.success!==true)||finished.slice(0,4).some(x=>x.meta?.changes!==1)){if(stable()&&await handoffMilestone(env,book,job,intent,'FINAL_COMMITTED'))return 'IN_PROGRESS';throw Error('FINAL_NOTICE_COMMIT_UNCERTAIN');}
  return 'IN_PROGRESS';
 }
 const outcome=await db.batch([
  db.prepare(`UPDATE stable_recovery_operations SET state='VERIFIED',verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_token=? AND epoch_id=? AND state='ADMITTED' AND EXISTS(SELECT 1 FROM continuous_review_notice_close x JOIN stable_workbook_claims c ON c.spreadsheet_id=x.spreadsheet_id AND c.operation_token=x.operation_token JOIN stable_recovery_epochs e ON e.epoch_id=x.epoch_id AND e.spreadsheet_id=x.spreadsheet_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=x.expense_id AND j.entity_version=x.source_version JOIN expense_events src ON src.expense_id=x.expense_id AND src.version=x.source_version WHERE x.operation_token=? AND x.spreadsheet_id=? AND x.state='STATUS_ACKED' AND x.source_revision=? AND ${reviewedClaimState('c',authority)} AND c.notice_stamp=x.next_stamp AND c.notice_identity=x.notice_identity AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=x.expense_id AND e.target_version=x.source_version AND ${reviewedJobState('j',authority)} AND (x.operation_kind='CONFIRM' AND src.status='CONFIRMED' AND EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=x.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=x.journal_entity AND p.projection=x.projection AND p.source_version=x.source_version AND p.operation_token=x.operation_token AND p.state='VERIFIED') OR x.operation_kind='CANCEL' AND src.status='CANCELLED' AND EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=x.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=x.journal_entity AND p.projection=x.projection AND p.cancellation_version=x.source_version AND p.operation_token=x.operation_token AND p.state='VERIFIED') OR x.projection='PUBLICATION' AND x.claim_mode='HANDOFF' AND EXISTS(SELECT 1 FROM continuous_publication_intents i JOIN continuous_publication_markers m ON m.spreadsheet_id=i.spreadsheet_id AND m.entity_id=i.entity_id AND m.transition_id=i.transition_id AND m.sheet_id=i.sheet_id AND m.sheet_name=i.sheet_name AND m.row_number=i.row_number AND m.version=i.source_version AND m.marker=i.after_value AND m.state=CASE WHEN i.kind='STAGE' THEN 'STAGED' WHEN i.kind='PUBLISH' THEN 'PUBLISHED' ELSE 'REVOKED' END JOIN continuous_normal_notice_handoffs h ON h.spreadsheet_id=i.spreadsheet_id AND h.operation_token=i.claim_token AND h.expense_id=i.entity_id AND h.source_version=i.source_version AND h.projection='PUBLICATION' AND h.journal_entity=i.transition_id AND h.operation_kind=x.operation_kind WHERE i.transition_id=x.journal_entity AND i.spreadsheet_id=x.spreadsheet_id AND i.entity_id=x.expense_id AND i.source_version=x.source_version AND i.claim_token=x.operation_token AND i.state='VERIFIED' AND ((i.kind IN ('STAGE','PUBLISH') AND x.operation_kind='CONFIRM' AND src.status='CONFIRMED') OR (i.kind='REVOKE' AND x.operation_kind='CANCEL' AND src.status='CANCELLED'))) AND (SELECT count(*) FROM continuous_publication_intents i WHERE i.spreadsheet_id=x.spreadsheet_id AND i.claim_token=x.operation_token)=1)) AND EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1 AND revision=?) AND (((? IN ('พร้อมแก้ไข','พร้อมแก้ไข • กำลังซิงก์') OR ? GLOB 'พร้อมแก้ไข • กำลังซิงก์ • รหัส *') AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW')) OR ((? IN ('พร้อมแก้ไข • มีรายการรอตรวจ','พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ') OR ? GLOB 'พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ • รหัส *') AND EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW'))) AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=? AND p.state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||?||':'||? AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') AND ${integrity}`).bind(token,intent.epoch_id,token,book,intent.source_revision,currentRevision,intent.ready_status,intent.ready_status,intent.ready_status,intent.ready_status,book,book,job.entityKey,job.entityVersion),
  db.prepare(`UPDATE sync_jobs AS j SET status='PENDING',last_error='STABLE_RECOVERY_VERIFIED_CONTINUE',next_attempt_at=NULL,lease_token=NULL,lease_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND ${reviewedJobState('j',authority)} AND changes()=1`).bind(job.entityKey,job.entityVersion),
  db.prepare(`DELETE FROM stable_workbook_claims AS c WHERE spreadsheet_id=? AND operation_token=? AND ${reviewedClaimState('c',authority)} AND notice_stamp=? AND notice_identity=? AND changes()=1`).bind(book,token,intent.next_stamp,intent.notice_identity),
  db.prepare(`UPDATE continuous_review_notice_close SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='STATUS_ACKED' AND changes()=1 AND ${integrity}`).bind(book,token),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(!stable()||outcome.length!==5||outcome.some(x=>x.success!==true)||outcome.slice(0,4).some(x=>x.meta?.changes!==1))throw Error('REVIEW_CLOSE_COMMIT_UNCERTAIN');
 return 'RESUMED';
}
