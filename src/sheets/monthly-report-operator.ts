import type {Env} from '../types';
import {batchUpdateSpreadsheetWithReply,getSheetGridInfo,readMonthlyReportGrid} from './client';
import {ReviewRequestBudget} from './review-request-budget';
import {stableNoticePaused} from './stable-edit-notice';
import {bangkokMonth,planMonthlyD1Preview,type MonthlyExpenseRow} from './monthly-d1-preview';
import {readMonthlyIncidentAuthority,monthlyIncidentGuard,type MonthlyIncidentAuthority} from './monthly-incident-authority';
import {reportBaselineDigest,reconstructReportBaseline,reportRowDigests,spareReportRowDigests,type ReportGrid,type ReportReceipt} from './monthly-report-baseline';
import {verifyMonthlyIncidentOverlay} from './monthly-incident-overlay';
import {manualReportNativeRowRequests} from './monthly-report-template';
import {verifyMonthlyReportRow} from './monthly-report-row-proof';
import {monthlySourceDigest,reserveMonthlyReportIntent,recordMonthlyReportReceipt} from './monthly-report-journal';
import {createGoogleOAuthLease,type GoogleOAuthLease} from './google-auth';

type OperatorEnv=Env&{MONTHLY_REPORT_OPERATOR_ENABLED?:string};
type Run={run_id:string;sheet_id:number;period:string;base_rows:number;base_columns:number;base_digest:string;incident_fingerprint:string;worker_hash:string;state:string};
type Result={status:'READY'|'DONE'|'HELD'|'UNCERTAIN';ready?:number;held?:number;candidate?:string;unresolved?:number;verified?:number;markerMatches?:number;stale?:number;unassignedDate?:number;heldReasons?:Record<string,number>;heldItems?:Array<{expenseId:string|null;reason:string}>};
const triggerIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND ((tbl_name='monthly_report_runs' AND name IN ('monthly_report_run_insert','monthly_report_run_transition','monthly_report_run_no_delete','monthly_report_run_no_replace')) OR (tbl_name='monthly_report_intents' AND name IN ('monthly_report_intent_insert','monthly_report_intent_transition','monthly_report_intent_no_delete','monthly_report_intent_no_replace')) OR (tbl_name='monthly_report_receipts' AND name IN ('monthly_report_receipt_insert','monthly_report_receipt_no_update','monthly_report_receipt_no_delete','monthly_report_receipt_no_replace'))))=12";
const hex=(s:string,n:number)=>new RegExp(`^[0-9a-f]{${n}}$`).test(s);
async function sha(s:string):Promise<string>{const d=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s));return Array.from(new Uint8Array(d),x=>x.toString(16).padStart(2,'0')).join('');}
const nonce=()=>crypto.randomUUID().replaceAll('-','').toLowerCase();
function config(env:OperatorEnv):string{return JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.SHEET_EXPENSE_DAILY,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_RECOVERY_GATE_ENABLED,env.STABLE_SHEETS_PACING_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.MONTHLY_REPORT_OPERATOR_ENABLED,env.CF_VERSION_METADATA?.id]);}
function sourceRowValid(row:MonthlyExpenseRow):boolean{return typeof row.expense_id==='string'&&typeof row.transaction_date==='string';}
function matchingFormats(g:ReportGrid):boolean{const row=g.formats[5]??[];for(let c=4;c<=18;c++){const f=row[c] as {numberFormat?:{type?:string;pattern?:string}}|null|undefined;if(f?.numberFormat?.type!=='NUMBER'||f.numberFormat.pattern!=='#,##0.00')return false;}const d=row[20] as {numberFormat?:{type?:string;pattern?:string}}|null|undefined;return d?.numberFormat?.type==='DATE'&&d.numberFormat.pattern==='dd/MM/yyyy'&&(g.validations[5]??[]).every(x=>x===null||x===undefined);}
async function receiptRows(env:Env,runId:string):Promise<ReportReceipt[]|null>{
 const r=await env.DB.prepare(`SELECT p.target_row row,p.marker,p.formula_digest formulaDigest,p.effective_digest effectiveDigest,p.notes_digest notesDigest,p.format_digest formatDigest,p.validation_digest validationDigest,p.extras_digest extrasDigest,p.spare_formula_digest spareFormulaDigest,p.spare_effective_digest spareEffectiveDigest,p.spare_notes_digest spareNotesDigest,p.spare_format_digest spareFormatDigest,p.spare_validation_digest spareValidationDigest,p.spare_extras_digest spareExtrasDigest FROM monthly_report_receipts p JOIN monthly_report_intents i ON i.operation_id=p.operation_id AND i.run_id=p.run_id AND i.marker=p.marker AND i.target_row=p.target_row AND i.state='VERIFIED' WHERE p.run_id=? AND ${triggerIntegrity} ORDER BY p.target_row`).bind(runId).all<ReportReceipt>();
 return r.success===true&&Array.isArray(r.results)?r.results:null;
}
async function oneRun(env:Env,period:string,workerHash:string,incident:MonthlyIncidentAuthority):Promise<Run|null>{
 const r=await env.DB.prepare(`SELECT run_id,sheet_id,period,base_rows,base_columns,base_digest,incident_fingerprint,worker_hash,state FROM monthly_report_runs WHERE spreadsheet_id=? AND state IN ('OPEN','REVIEW') AND ${triggerIntegrity}`).bind(env.GOOGLE_SPREADSHEET_ID).all<Run>();
 if(r.success!==true||!Array.isArray(r.results)||r.results.length>1)throw Error('MONTHLY_RUN_UNVERIFIED');const run=r.results[0];
 if(!run)return null;if(run.state!=='OPEN'||run.period!==period||run.worker_hash!==workerHash||run.incident_fingerprint!==incident.fingerprint||run.sheet_id!==incident.row.sheet_id)throw Error('MONTHLY_RUN_HELD');return run;
}
async function journalStatus(env:Env):Promise<{unresolved:number;verified:number;marker:string|null}|null>{
 const r=await env.DB.prepare(`SELECT (SELECT count(*) FROM monthly_report_intents WHERE state IN ('IN_FLIGHT','RECEIPT_IN_FLIGHT','REVIEW')) unresolved,(SELECT count(*) FROM monthly_report_intents WHERE state='VERIFIED') verified,(SELECT marker FROM monthly_report_intents WHERE state IN ('IN_FLIGHT','RECEIPT_IN_FLIGHT','REVIEW') LIMIT 1) marker,${triggerIntegrity} integrity`).first<{unresolved:number;verified:number;marker:string|null;integrity:number}>();
 return r&&r.integrity===1&&Number.isSafeInteger(r.unresolved)&&r.unresolved>=0&&r.unresolved<=1&&Number.isSafeInteger(r.verified)&&r.verified>=0?{unresolved:r.unresolved,verified:r.verified,marker:r.marker}:null;
}
async function incidentProof(env:Env,base:ReportGrid,grid:ReportGrid,receipts:ReportReceipt[],digest:string,incident:MonthlyIncidentAuthority,policy:{kind:'continuous-expense';budget:ReviewRequestBudget;oauthLease:GoogleOAuthLease}):Promise<boolean>{
 const x=incident.row,payload=base.formula[x.target_row-1]?.[24];if(typeof payload!=='string'||!await stableNoticePaused(env,x.notice_stamp,x.notice_identity,policy.budget,policy.oauthLease))return false;
 return verifyMonthlyIncidentOverlay({base,current:grid,baselineDigest:digest,receipts,coords:{sheetId:x.sheet_id,row:x.target_row,rowCount:x.before_rows,columnCount:x.before_columns},payload,beforeDigest:x.before_digest,payloadDigest:x.payload_digest});
}
async function currentSource(env:Env,period:string):Promise<MonthlyExpenseRow[]|null>{
 const r=await env.DB.prepare("SELECT expense_id,version,status,transaction_date,description,amount_satang,payment_key,source_wallet,category FROM expense_events WHERE status='CONFIRMED' AND substr(transaction_date,1,7)=? ORDER BY transaction_date,expense_id LIMIT 501").bind(period).all<MonthlyExpenseRow>();
 return r.success===true&&Array.isArray(r.results)&&r.results.length<=500?r.results:null;
}
async function createRun(env:Env,incident:MonthlyIncidentAuthority,period:string,workerHash:string,base:ReportGrid,digest:string):Promise<Run|null>{
 const id=nonce(),x=incident.row,book=env.GOOGLE_SPREADSHEET_ID,guard=monthlyIncidentGuard(incident,book);
 const result=await env.DB.prepare(`INSERT INTO monthly_report_runs(run_id,spreadsheet_id,sheet_id,sheet_name,period,base_rows,base_columns,base_digest,incident_fingerprint,worker_hash,state,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,'OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${triggerIntegrity} AND ${guard.sql} RETURNING run_id`).bind(id,book,x.sheet_id,x.sheet_name,period,base.rows,base.columns,digest,incident.fingerprint,workerHash,...guard.args).all<{run_id:string}>();
 if(result.success!==true||result.results?.length!==1||result.results[0]?.run_id!==id)return null;
 return {run_id:id,sheet_id:x.sheet_id,period,base_rows:base.rows,base_columns:base.columns,base_digest:digest,incident_fingerprint:incident.fingerprint,worker_hash:workerHash,state:'OPEN'};
}

/** PREVIEW and INSPECT read only; APPEND_ONE is one-shot and never retries an
 * unclear D1 or provider result. Workflow must independently fence all human
 * and external writers throughout this invocation. */
export async function operateMonthlyReport(env:OperatorEnv,action:'PREVIEW'|'APPEND_ONE'|'INSPECT',workerHash:string,candidateHash?:string):Promise<Result>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,initial=config(env),stable=()=>env.DB===db&&config(env)===initial;let intentRecorded=false;
 if(!['PREVIEW','APPEND_ONE','INSPECT'].includes(action)||!book||env.MONTHLY_REPORT_OPERATOR_ENABLED!=='true'||env.STABLE_PHASE1_ENABLED!=='true'||env.CONTINUOUS_DAILY_ENABLED!=='true'||env.STABLE_SHEETS_PACING_ENABLED!=='true'||!env.CF_VERSION_METADATA?.id||!hex(workerHash,64)||await sha(env.CF_VERSION_METADATA.id)!==workerHash||action==='APPEND_ONE'&&(!candidateHash||!hex(candidateHash,64))||!stable())return {status:'HELD'};
 try{
  const period=bangkokMonth(new Date()),incident=await readMonthlyIncidentAuthority(env);if(!incident||!stable())return {status:'HELD'};
  let run=await oneRun(env,period,workerHash,incident);const journal=await journalStatus(env);if(!journal)return {status:'HELD'};
  if(journal.unresolved){
   if(action!=='INSPECT'||!run||!journal.marker)return {status:'HELD',unresolved:journal.unresolved,verified:journal.verified};
   const budget=new ReviewRequestBudget(40),lease=await createGoogleOAuthLease(env,budget,60000),grid=await readMonthlyReportGrid(env,run.sheet_id,run.base_rows,{kind:'continuous-expense',budget,oauthLease:lease});let matches=0;
   for(const row of grid.notes)if(Array.isArray(row))for(const value of row)if(value===journal.marker)matches++;
   // Observing a note is diagnostic only: it never settles the mutation or
   // permits a retry, even if exactly one match is present.
   return {status:'HELD',unresolved:journal.unresolved,verified:journal.verified,markerMatches:Math.min(matches,2)};
  }
  const budget=new ReviewRequestBudget(48,'invocation'),oauthLease=await createGoogleOAuthLease(env,budget,60000),policy={kind:'continuous-expense' as const,budget,oauthLease},info=await getSheetGridInfo(env,incident.row.sheet_name,policy),baseRows=run?.base_rows??info.rowCount;
  const grid=await readMonthlyReportGrid(env,incident.row.sheet_id,baseRows,policy),digest=run?.base_digest??await reportBaselineDigest(grid),base=run?await reconstructReportBaseline(grid,baseRows,digest):grid,receipts=run?await receiptRows(env,run.run_id):[];
  if(!base||!receipts||base.columns!==(run?.base_columns??base.columns)||!matchingFormats(grid)||!await incidentProof(env,base,grid,receipts,digest,incident,policy)||!stable())return {status:'HELD'};
  const records=await currentSource(env,period);if(!records)return {status:'HELD'};
  // Invalid dates with no current-month prefix cannot be assigned to a month.
  // Count separately; never guess that they belong to this reporting period.
  const unassigned=await db.prepare("SELECT count(*) n FROM expense_events WHERE status='CONFIRMED' AND (transaction_date IS NULL OR substr(transaction_date,1,7)<>?) AND (transaction_date IS NULL OR length(transaction_date)<>10 OR transaction_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' OR date(transaction_date,'+0 days') IS NULL OR date(transaction_date,'+0 days')<>transaction_date)").bind(period).first<{n:number}>();
  if(!unassigned||!Number.isSafeInteger(unassigned.n)||unassigned.n<0)return {status:'HELD'};
  const projected=run?await db.prepare("SELECT i.expense_id AS projected_id,i.source_version,i.source_digest,e.expense_id,e.version,e.status,e.transaction_date,e.description,e.amount_satang,e.payment_key,e.source_wallet,e.category FROM monthly_report_intents i LEFT JOIN expense_events e ON e.expense_id=i.expense_id WHERE i.run_id=? AND i.state='VERIFIED'").bind(run.run_id).all<MonthlyExpenseRow&{projected_id:string;source_version:number;source_digest:string}>():null;
  if(projected&&(projected.success!==true||!Array.isArray(projected.results)))return {status:'HELD'};
  const done=new Set<string>();let stale=0;
  for(const x of projected?.results??[]){done.add(`${x.projected_id}:${x.source_version}`);let current=false;try{current=x.expense_id===x.projected_id&&x.version===x.source_version&&await monthlySourceDigest(x)===x.source_digest;}catch{}if(!current)stale++;}
  const available=records.filter(x=>!done.has(`${x.expense_id}:${x.version}`)),plan=planMonthlyD1Preview(available,grid.formula.slice(0,3),new Date());
  if(plan.period!==period||!stable())return {status:'HELD'};
  const heldReasons:Record<string,number>={};for(const item of plan.held)heldReasons[item.reason]=(heldReasons[item.reason]??0)+1;
  const first=plan.ready[0],raw=first?available.find(x=>x.expense_id===first.expenseId&&x.version===first.sourceVersion):undefined,selected=raw&&sourceRowValid(raw)?await monthlySourceDigest(raw):undefined;
  if(action!=='APPEND_ONE')return {status:'READY',ready:plan.ready.length,held:plan.held.length,heldReasons,heldItems:plan.held,unassignedDate:unassigned.n,stale,...selected?{candidate:selected}:{}};
  if(!first||!raw||selected!==candidateHash||grid.rows>4998||!budget.reserveMutation())return {status:'HELD'};
  // Reserve sufficient budget for full postimage and any cold OAuth refresh.
  if(budget.remaining<17||!budget.reservePost(8)){budget.releaseMutation();return {status:'HELD'};}
  try{
   const reread=await readMonthlyIncidentAuthority(env);if(!reread||reread.fingerprint!==incident.fingerprint||!stable())return {status:'HELD'};
   if(!run){run=await createRun(env,reread,period,workerHash,base,digest);if(!run)return {status:'UNCERTAIN'};}
   const marker=`MRP1_${nonce()}`,operationId=nonce(),scope={sheetId:incident.row.sheet_id,incidentFingerprint:incident.fingerprint,workerHash,incident:reread};
   const reserved=await reserveMonthlyReportIntent(env,{runId:run.run_id,operationId,marker,source:raw,beforeRows:grid.rows,period,scope});if(reserved!=='RESERVED')return {status:reserved==='HELD'?'HELD':'UNCERTAIN'};intentRecorded=true;
   const requests=manualReportNativeRowRequests(incident.row.sheet_id,grid.rows,6,first,marker),preDigest=await reportBaselineDigest(grid);
   let reply:unknown;try{reply=await batchUpdateSpreadsheetWithReply(env,requests,async()=>{
    const live=await readMonthlyIncidentAuthority(env),source=await currentSource(env,period),check=await readMonthlyReportGrid(env,incident.row.sheet_id,baseRows,policy),match=source?.find(x=>x.expense_id===raw.expense_id&&x.version===raw.version);
    if(!live||live.fingerprint!==incident.fingerprint||!match||await monthlySourceDigest(match)!==selected||bangkokMonth(new Date())!==period||await reportBaselineDigest(check)!==preDigest||!await stableNoticePaused(env,incident.row.notice_stamp,incident.row.notice_identity,budget,oauthLease)||!stable())throw Error('MONTHLY_PRE_DISPATCH_CHANGED');
   },budget,oauthLease);}catch{return {status:'UNCERTAIN'};}
   if(!reply||typeof reply!=='object'||!Array.isArray((reply as {replies?:unknown}).replies)||(reply as {replies:unknown[]}).replies.length!==requests.length||!stable())return {status:'UNCERTAIN'};
   budget.releasePost();const after=await readMonthlyReportGrid(env,incident.row.sheet_id,baseRows,policy),spare=await spareReportRowDigests(after,grid.rows+2);if(!spare)return {status:'UNCERTAIN'};const newReceipt={row:grid.rows+1,marker,...await reportRowDigests(after,grid.rows+1),...spare};
   const latest=await readMonthlyIncidentAuthority(env);if(!latest||latest.fingerprint!==incident.fingerprint||!verifyMonthlyReportRow(after,grid.rows,6,first,marker)||!await incidentProof(env,base,after,[...receipts,newReceipt],digest,incident,policy)||!stable())return {status:'UNCERTAIN'};
   const recorded=await recordMonthlyReportReceipt(env,{runId:run.run_id,operationId,source:raw,receipt:newReceipt,scope:{...scope,incident:latest}});return {status:recorded==='RECORDED'?'DONE':'UNCERTAIN'};
  }finally{budget.releasePost();budget.releaseMutation();}
 }catch{return {status:intentRecorded?'UNCERTAIN':'HELD'};}
}
