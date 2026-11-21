import type {Env} from '../types';
import type {MonthlyExpenseRow} from './monthly-d1-preview';
import type {ReportReceipt} from './monthly-report-baseline';
import {monthlyIncidentGuard,type MonthlyIncidentAuthority} from './monthly-incident-authority';

// Journal functions perform D1 metadata writes only. They never authorize a
// Sheets dispatch: the operator must separately prove and keep the external
// writer fence, current grid/base overlay, version and request budget.
const hex32=(x:string)=>/^[0-9a-f]{32}$/.test(x),hex64=(x:string)=>/^[0-9a-f]{64}$/.test(x);
type Scope={incidentFingerprint:string;workerHash:string;sheetId:number;incident:MonthlyIncidentAuthority};
async function hash(s:string):Promise<string>{const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return Array.from(new Uint8Array(d),x=>x.toString(16).padStart(2,'0')).join('');}
async function scopeValid(env:Env,scope:Scope):Promise<boolean>{const v=env.CF_VERSION_METADATA?.id,a=scope.incident;if(!v||!a||a.fingerprint!==scope.incidentFingerprint||!Number.isSafeInteger(a.revision)||a.revision<0||a.row.sheet_id!==scope.sheetId||!hex64(scope.incidentFingerprint)||!hex64(scope.workerHash)||!Number.isSafeInteger(scope.sheetId)||scope.sheetId<0||env.CONTINUOUS_DAILY_SHEET!=='รายวันต่อเนื่อง_แบบร่าง'||env.CONTINUOUS_DAILY_SHEET_ID!==String(scope.sheetId))return false;return await hash(v)===scope.workerHash&&await hash(JSON.stringify(a.row))===scope.incidentFingerprint;}
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND ((tbl_name='monthly_report_runs' AND name IN ('monthly_report_run_insert','monthly_report_run_transition','monthly_report_run_no_delete','monthly_report_run_no_replace')) OR (tbl_name='monthly_report_intents' AND name IN ('monthly_report_intent_insert','monthly_report_intent_transition','monthly_report_intent_no_delete','monthly_report_intent_no_replace')) OR (tbl_name='monthly_report_receipts' AND name IN ('monthly_report_receipt_insert','monthly_report_receipt_no_update','monthly_report_receipt_no_delete','monthly_report_receipt_no_replace'))))=12";
const sourceSql="EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND e.transaction_date=? AND e.description=? AND e.amount_satang=? AND e.payment_key=? AND e.source_wallet=? AND e.category=?)";
function sourceArgs(s:MonthlyExpenseRow):unknown[]{return [s.expense_id,s.version,s.transaction_date,s.description,s.amount_satang,s.payment_key,s.source_wallet,s.category];}
function validSource(s:MonthlyExpenseRow):boolean{
 if(typeof s.transaction_date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s.transaction_date))return false;
 const [year,month,day]=s.transaction_date.split('-').map(Number),date=new Date(Date.UTC(year!,month!-1,day!));
 return year!>=1900&&year!<=9999&&date.getUTCFullYear()===year&&date.getUTCMonth()===month!-1&&date.getUTCDate()===day&&typeof s.expense_id==='string'&&/^exp_[A-Za-z0-9_-]{1,128}$/.test(s.expense_id)&&Number.isSafeInteger(s.version)&&Number(s.version)>0&&s.status==='CONFIRMED'&&typeof s.description==='string'&&Number.isSafeInteger(s.amount_satang)&&Number(s.amount_satang)>0&&typeof s.payment_key==='string'&&typeof s.source_wallet==='string'&&typeof s.category==='string';
}
export async function monthlySourceDigest(s:MonthlyExpenseRow):Promise<string>{
 if(!validSource(s))throw Error('MONTHLY_SOURCE_INVALID');const bytes=new TextEncoder().encode(JSON.stringify(sourceArgs(s))),hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
}
/** A lost D1 response is UNCERTAIN, never authority to dispatch or retry. */
export async function reserveMonthlyReportIntent(env:Env,input:{runId:string;operationId:string;marker:string;source:MonthlyExpenseRow;beforeRows:number;period:string;scope:Scope}):Promise<'RESERVED'|'HELD'|'UNCERTAIN'>{
 const {runId,operationId,marker,source,beforeRows,period,scope}=input,db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(!book||!hex32(runId)||!hex32(operationId)||!/^MRP1_[0-9a-f]{32}$/.test(marker)||!validSource(source)||!/^\d{4}-\d{2}$/.test(period)||!String(source.transaction_date).startsWith(`${period}-`)||!Number.isSafeInteger(beforeRows)||beforeRows<5||beforeRows>4998||!await scopeValid(env,scope))return 'HELD';
 const digest=await monthlySourceDigest(source),incident=monthlyIncidentGuard(scope.incident,book);if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)return 'HELD';
 try{
  const r=await db.prepare(`INSERT INTO monthly_report_intents(operation_id,run_id,expense_id,source_version,source_digest,marker,before_rows,target_row,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${integrity} AND ${sourceSql} AND EXISTS(SELECT 1 FROM monthly_report_runs WHERE run_id=? AND spreadsheet_id=? AND period=? AND sheet_id=? AND incident_fingerprint=? AND worker_hash=? AND state='OPEN') AND ${incident.sql} RETURNING operation_id`).bind(operationId,runId,source.expense_id,source.version,digest,marker,beforeRows,beforeRows+1,...sourceArgs(source),runId,book,period,scope.sheetId,scope.incidentFingerprint,scope.workerHash,...incident.args).all<{operation_id:string}>();
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||!await scopeValid(env,scope)||r.success!==true||!Array.isArray(r.results))return 'UNCERTAIN';
  if(r.results.length===0){
   const prior=await db.prepare("SELECT count(*) n FROM monthly_report_intents WHERE operation_id=? OR state IN ('IN_FLIGHT','RECEIPT_IN_FLIGHT','REVIEW')").bind(operationId).first<{n:number}>();
   return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&await scopeValid(env,scope)&&prior?.n===0?'HELD':'UNCERTAIN';
  }
  return r.results.length===1&&r.results[0]?.operation_id===operationId?'RESERVED':'UNCERTAIN';
 }catch{return 'UNCERTAIN';}
}
/** Caller must have positively verified the full provider overlay, marker
 * uniqueness and row digests before this atomic receipt/transition. */
export async function recordMonthlyReportReceipt(env:Env,input:{runId:string;operationId:string;source:MonthlyExpenseRow;receipt:ReportReceipt;scope:Scope}):Promise<'RECORDED'|'UNCERTAIN'>{
 const {runId,operationId,source,receipt,scope}=input,db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(!book||!hex32(runId)||!hex32(operationId)||!validSource(source)||!/^MRP1_[0-9a-f]{32}$/.test(receipt.marker)||!Number.isSafeInteger(receipt.row)||![receipt.formulaDigest,receipt.effectiveDigest,receipt.notesDigest,receipt.formatDigest,receipt.validationDigest,receipt.extrasDigest,receipt.spareFormulaDigest,receipt.spareEffectiveDigest,receipt.spareNotesDigest,receipt.spareFormatDigest,receipt.spareValidationDigest,receipt.spareExtrasDigest].every(hex64)||!await scopeValid(env,scope))return 'UNCERTAIN';
 const digest=await monthlySourceDigest(source),values=[runId,operationId,source.expense_id,source.version,digest,receipt.marker,receipt.row],incident=monthlyIncidentGuard(scope.incident,book);if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book)return 'UNCERTAIN';
 try{
  const claimed=await db.prepare(`UPDATE monthly_report_intents SET state='RECEIPT_IN_FLIGHT',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id=? AND operation_id=? AND expense_id=? AND source_version=? AND source_digest=? AND marker=? AND target_row=? AND state='IN_FLIGHT' AND ${integrity} AND EXISTS(SELECT 1 FROM monthly_report_runs WHERE run_id=? AND spreadsheet_id=? AND sheet_id=? AND incident_fingerprint=? AND worker_hash=? AND state='OPEN') RETURNING operation_id`).bind(...values,runId,book,scope.sheetId,scope.incidentFingerprint,scope.workerHash).all<{operation_id:string}>();
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||!await scopeValid(env,scope)||claimed.success!==true||claimed.results?.length!==1||claimed.results[0]?.operation_id!==operationId)return 'UNCERTAIN';
  const result=await db.batch([
   db.prepare(`INSERT INTO monthly_report_receipts(operation_id,run_id,marker,target_row,formula_digest,effective_digest,notes_digest,format_digest,validation_digest,extras_digest,spare_formula_digest,spare_effective_digest,spare_notes_digest,spare_format_digest,spare_validation_digest,spare_extras_digest,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${integrity} AND ${sourceSql} AND EXISTS(SELECT 1 FROM monthly_report_intents i JOIN monthly_report_runs r ON r.run_id=i.run_id WHERE i.run_id=? AND i.operation_id=? AND i.expense_id=? AND i.source_version=? AND i.source_digest=? AND i.marker=? AND i.target_row=? AND i.state='RECEIPT_IN_FLIGHT' AND r.spreadsheet_id=? AND r.sheet_id=? AND r.incident_fingerprint=? AND r.worker_hash=? AND r.state='OPEN') AND ${incident.sql} RETURNING operation_id`).bind(operationId,runId,receipt.marker,receipt.row,receipt.formulaDigest,receipt.effectiveDigest,receipt.notesDigest,receipt.formatDigest,receipt.validationDigest,receipt.extrasDigest,receipt.spareFormulaDigest,receipt.spareEffectiveDigest,receipt.spareNotesDigest,receipt.spareFormatDigest,receipt.spareValidationDigest,receipt.spareExtrasDigest,...sourceArgs(source),...values,book,scope.sheetId,scope.incidentFingerprint,scope.workerHash,...incident.args),
   db.prepare(`UPDATE monthly_report_intents SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE run_id=? AND operation_id=? AND expense_id=? AND source_version=? AND source_digest=? AND marker=? AND target_row=? AND state='RECEIPT_IN_FLIGHT' AND changes()=1 AND ${integrity} AND ${sourceSql} AND ${incident.sql} RETURNING operation_id`).bind(...values,...sourceArgs(source),...incident.args),
   db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
  ]);
  return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&await scopeValid(env,scope)&&result.length===3&&result.every(x=>x.success===true)&&result[0]?.results?.length===1&&result[1]?.results?.length===1?'RECORDED':'UNCERTAIN';
 }catch{return 'UNCERTAIN';}
}
