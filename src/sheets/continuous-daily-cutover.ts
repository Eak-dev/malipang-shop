import type {Env,SheetsSyncJob} from '../types';
import {stableSourceIntegrity} from './stable-source-cutover';

export type ContinuousDailyCutoverChoice =
 | {status:'CONTINUOUS';sheet:string;sheetId:number}
 | {status:'LEGACY';sheet:string;sheetId:number}
 | {status:'HOLD';reason:string};

/** Safe for embedding into the same transaction as an intent reservation. */
export const continuousDailyCutoverIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('continuous_daily_cutover_prepared','continuous_daily_cutover_no_delete','continuous_daily_cutover_no_replace','continuous_daily_cutover_transition','continuous_daily_snapshot_prepared','continuous_daily_snapshot_no_delete','continuous_daily_snapshot_no_update','continuous_daily_snapshot_no_replace','continuous_daily_record_post_cutover','continuous_daily_post_no_delete','continuous_daily_post_no_update','continuous_daily_post_no_replace','continuous_expense_projection_target_fence','continuous_expense_cutover_no_processing'))=14";
export const continuousReportCutoverIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('continuous_report_attempt_insert','continuous_report_attempt_transition','continuous_report_attempt_no_delete','continuous_report_attempt_no_replace'))=4";
export const continuousAdmissionIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('continuous_daily_admission_insert','continuous_daily_admission_no_delete','continuous_daily_admission_no_update','continuous_daily_admission_no_replace'))=4";

/** Builds one atomic D1 batch only; it does not dispatch it. The caller must
 * first prove legacy writers/provider requests settled, correct workbook and
 * sheets, report readiness, and the cancelled receipts' current status.
 * It does not delete records or evidence. D1 state/claim/revision alone
 * cannot establish provider settlement or control external writers. */
export function continuousDailyCutoverStatements(env:Env,input:{book:string;legacySheetId:number;legacySheetName:string;continuousSheetId:number;continuousSheetName:string;rawSheetId:number;rawSheetName:string;detailSheetId:number;detailSheetName:string;claim:string;revision:number;mustBeCancelledOrAbsentExpenseIds:readonly [string,string]}):D1PreparedStatement[]{
 const {book,legacySheetId,legacySheetName,continuousSheetId,continuousSheetName,rawSheetId,rawSheetName,detailSheetId,detailSheetName,claim,revision,mustBeCancelledOrAbsentExpenseIds}=input;
 const names=[legacySheetName,continuousSheetName,rawSheetName,detailSheetName],ids=[legacySheetId,continuousSheetId,rawSheetId,detailSheetId];
 if(!book||book!==env.GOOGLE_SPREADSHEET_ID||!claim||names.some(n=>!n||n!==n.trim())||new Set(names).size!==names.length||ids.some(n=>!Number.isSafeInteger(n)||n<0)||new Set(ids).size!==ids.length||!Number.isSafeInteger(revision)||revision<0||!Array.isArray(mustBeCancelledOrAbsentExpenseIds)||mustBeCancelledOrAbsentExpenseIds.length!==2||mustBeCancelledOrAbsentExpenseIds[0]===mustBeCancelledOrAbsentExpenseIds[1]||mustBeCancelledOrAbsentExpenseIds.some(id=>!/^exp_[A-Za-z0-9_-]{1,128}$/.test(id)))throw Error('CONTINUOUS_DAILY_CUTOVER_INVALID');
 const guard=`${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND NOT EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id IN (?,?) AND e.status<>'CANCELLED') AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.status='PROCESSING')`;
 const guardArgs=[book,claim,revision,...mustBeCancelledOrAbsentExpenseIds];
 return [
  env.DB.prepare(`INSERT INTO continuous_daily_cutovers(spreadsheet_id,legacy_sheet_id,legacy_sheet_name,continuous_sheet_id,continuous_sheet_name,raw_sheet_id,raw_sheet_name,detail_sheet_id,detail_sheet_name,claim_token,source_revision,state,prepared_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,'PREPARED',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${guard}`).bind(book,legacySheetId,legacySheetName,continuousSheetId,continuousSheetName,rawSheetId,rawSheetName,detailSheetId,detailSheetName,claim,revision,...guardArgs),
  env.DB.prepare(`INSERT INTO continuous_daily_pre_cutover_expenses(spreadsheet_id,expense_id) SELECT ?,e.expense_id FROM expense_events e WHERE e.status<>'CANCELLED' AND EXISTS(SELECT 1 FROM continuous_daily_cutovers c WHERE c.spreadsheet_id=? AND c.claim_token=? AND c.source_revision=? AND c.state='PREPARED') AND ${guard}`).bind(book,book,claim,revision,...guardArgs),
  env.DB.prepare(`UPDATE continuous_daily_cutovers SET state='ACTIVE',activated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND claim_token=? AND source_revision=? AND state='PREPARED' AND ${guard}`).bind(book,claim,revision,...guardArgs),
  env.DB.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ];
}

/** Read-only selection from an independently activated cutover. The cutover
 * snapshot is an identity boundary, not proof that Google has settled a
 * previous request or that non-cooperating writers are stopped. The caller
 * must hold its claim, verify source and retain all write/readback guards. */
export async function chooseContinuousDailyCutover(env:Env,job:SheetsSyncJob,sourceDigest?:string):Promise<ContinuousDailyCutoverChoice>{
 const hold=(reason:string):ContinuousDailyCutoverChoice=>({status:'HOLD',reason});
 const book=env.GOOGLE_SPREADSHEET_ID,db=env.DB,identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
 if(!book||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<1)return hold('INVALID_INPUT');
 const result=await db.prepare(`SELECT c.state,c.legacy_sheet_id,c.legacy_sheet_name,c.continuous_sheet_id,c.continuous_sheet_name,
  EXISTS(SELECT 1 FROM continuous_daily_pre_cutover_expenses b WHERE b.spreadsheet_id=c.spreadsheet_id AND b.expense_id=?) AS pre_cutover,
  EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses b WHERE b.spreadsheet_id=c.spreadsheet_id AND b.expense_id=?) AS post_cutover,
  EXISTS(SELECT 1 FROM continuous_daily_source_admissions a WHERE a.spreadsheet_id=c.spreadsheet_id AND a.expense_id=? AND a.source_version=? AND a.source_digest=?) AS admitted,
  e.version AS expense_version,e.status AS expense_status,p.sheet_id AS journal_sheet_id,p.sheet_name AS journal_sheet_name,p.state AS journal_state,p.source_version AS journal_source_version
  FROM continuous_daily_cutovers c LEFT JOIN expense_events e ON e.expense_id=? LEFT JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=? AND p.projection='DAILY'
  WHERE c.spreadsheet_id=? AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=c.spreadsheet_id AND a.stage IN ('VIEWS','DAILY_J','REPORTS') AND a.state='VERIFIED')=3`).bind(job.entityKey,job.entityKey,job.entityKey,job.entityVersion,sourceDigest??'',job.entityKey,job.entityKey,book).first<{state:string;legacy_sheet_id:number;legacy_sheet_name:string;continuous_sheet_id:number;continuous_sheet_name:string;pre_cutover:number;post_cutover:number;admitted:number;expense_version:number|null;expense_status:string|null;journal_sheet_id:number|null;journal_sheet_name:string|null;journal_state:string|null;journal_source_version:number|null}>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||identity!==JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]))return hold('SCOPE_CHANGED');
 if(!result||result.state!=='ACTIVE')return hold('CUTOVER_NOT_ACTIVE');
 if(result.expense_version!==job.entityVersion||result.expense_status!=='CONFIRMED')return hold('SOURCE_UNVERIFIED');
 const legacy=result.journal_sheet_id===result.legacy_sheet_id&&result.journal_sheet_name===result.legacy_sheet_name;
 const continuous=result.journal_sheet_id===result.continuous_sheet_id&&result.journal_sheet_name===result.continuous_sheet_name;
 if(result.journal_state!==null){
  if(result.journal_state!=='VERIFIED'||result.journal_source_version!==job.entityVersion)return hold('PREVIOUS_INTENT_UNRESOLVED');
  if(legacy&&Number(result.pre_cutover)===1)return{status:'LEGACY',sheet:result.legacy_sheet_name,sheetId:result.legacy_sheet_id};
  if(continuous)return{status:'CONTINUOUS',sheet:result.continuous_sheet_name,sheetId:result.continuous_sheet_id};
  return hold('JOURNAL_TARGET_CONFLICT');
 }
 if(Number(result.pre_cutover)===1&&Number(result.admitted)!==1)return hold('PRE_CUTOVER_UNJOURNALED');
 if(Number(result.admitted)===1)return{status:'CONTINUOUS',sheet:result.continuous_sheet_name,sheetId:result.continuous_sheet_id};
 if(Number(result.post_cutover)===1)return{status:'CONTINUOUS',sheet:result.continuous_sheet_name,sheetId:result.continuous_sheet_id};
 return hold('SOURCE_ORIGIN_UNPROVEN');
}
