import {continuousSheetsReadPolicy} from '../sheets/client';
import type {Env} from '../types';
import {beginStableNotice,stableNoticePaused} from '../sheets/stable-edit-notice';
import {releaseContinuousCutoverNotice} from './continuous-cutover-notice';
import {stableWorkbookClaimOwned} from '../sheets/stable-workbook-claim';
import {bootstrapContinuousReportViews} from '../sheets/report-view-bootstrap';
import {reconcileContinuousViewsIncident} from '../sheets/continuous-views-incident-recovery';
import {captureContinuousReportInputs,runContinuousReportCutoverStage} from '../sheets/report-cutover-controller';
import {continuousDailyCutoverStatements} from '../sheets/continuous-daily-cutover';
import {batchGetSheetFormulaValues,getSpreadsheetSheetProperties} from '../sheets/client';
import {columnName} from '../sheets/daily-expense';
import {STABLE_DAILY_REVIEW_REASONS} from '../sheets/stable-daily-writer';

type OperatorEnv=Env & {CONTINUOUS_CUTOVER_OPERATOR_ENABLED?:string;CONTINUOUS_CUTOVER_PREWRITE_REVIEW_ENABLED?:string;CONTINUOUS_CUTOVER_REVIEW_FINGERPRINT?:string;CONTINUOUS_REPORT_CUTOVER_ENABLED?:string;CONTINUOUS_RAW_VIEW_ID?:string;CONTINUOUS_DETAIL_VIEW_ID?:string};
type Action='START'|'START_REVIEW'|'RECONCILE_VIEWS'|'VIEWS'|'DAILY_J'|'REPORTS'|'ACTIVATE'|'RELEASE';
type Marker={operation_token:string;state:string};
const integrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_cutover_operator' AND name IN ('continuous_operator_insert','continuous_operator_update','continuous_operator_no_delete','continuous_operator_no_replace'))=4";
const noUnknown="NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.state<>'VERIFIED') AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=? AND p.state<>'VERIFIED')";
const hash=async(x:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(x))),b=>b.toString(16).padStart(2,'0')).join('');
/** Google's FORMULA readback may remove optional quotes from these three
 * ASCII-only sheet references. The incident's stored after-hash is still
 * required to match exactly after the single known provider rewrite. */
export async function expectedReportFormulaHashMatches(observed:unknown,recordedHash:unknown):Promise<boolean>{
 if(typeof observed!=='string'||!observed.startsWith('=')||typeof recordedHash!=='string'||!/^[0-9a-f]{64}$/.test(recordedHash))return false;
 if(await hash(observed)===recordedHash)return true;
 const requoted=observed.replace(/(?<![A-Za-z0-9_'])(V52_EXPENSE_RAW_ALL|V52_PURCHASE_DETAIL_ALL|V52_EXPENSE_RAW)!/g,(_,name:string)=>"'"+name+"'!");
 return requoted!==observed&&await hash(requoted)===recordedHash;
}
const quote=(s:string)=>`'${s.replace(/'/g,"''")}'`;
// Pinned by fingerprint below; the list only lets the lookup find a claim whose
// reason came from a specific preflight code (STABLE_SCOPED_REVIEW_ENABLED).
const dailyReviewReasons=STABLE_DAILY_REVIEW_REASONS.map(quote).join(',');
function enabled(env:OperatorEnv):boolean{return env.CONTINUOUS_CUTOVER_OPERATOR_ENABLED==='true'&&env.CONTINUOUS_REPORT_CUTOVER_ENABLED==='true'&&env.STABLE_PHASE1_ENABLED==='true'&&env.STABLE_RECOVERY_GATE_ENABLED==='true'&&env.STABLE_SHEETS_PACING_ENABLED==='true'&&[undefined,'','false'].includes(env.CONTINUOUS_DAILY_ENABLED)&&!!env.GOOGLE_SPREADSHEET_ID;}
const scope=(e:OperatorEnv)=>JSON.stringify([e.GOOGLE_SPREADSHEET_ID,e.GOOGLE_SERVICE_ACCOUNT_EMAIL,e.GOOGLE_PRIVATE_KEY_BASE64,e.EXTERNAL_API_TIMEOUT_MS,e.CONTINUOUS_CUTOVER_OPERATOR_ENABLED,e.CONTINUOUS_CUTOVER_PREWRITE_REVIEW_ENABLED,e.CONTINUOUS_CUTOVER_REVIEW_FINGERPRINT,e.CONTINUOUS_REPORT_CUTOVER_ENABLED,e.STABLE_PHASE1_ENABLED,e.STABLE_RECOVERY_GATE_ENABLED,e.STABLE_SHEETS_PACING_ENABLED,e.CONTINUOUS_DAILY_ENABLED,e.SHEET_EXPENSE_DAILY,e.SHEET_EXPENSE_RAW,e.SHEET_PURCHASE_DETAILS,e.CONTINUOUS_DAILY_SHEET,e.CONTINUOUS_DAILY_SHEET_ID,e.CONTINUOUS_RAW_SHEET,e.CONTINUOUS_RAW_SHEET_ID,e.CONTINUOUS_DETAIL_SHEET,e.CONTINUOUS_DETAIL_SHEET_ID,e.CONTINUOUS_RAW_VIEW_ID,e.CONTINUOUS_DETAIL_VIEW_ID]);
async function marker(env:OperatorEnv):Promise<Marker|null>{return env.DB.prepare(`SELECT operation_token,state FROM continuous_cutover_operator WHERE spreadsheet_id=? AND ${integrity}`).bind(env.GOOGLE_SPREADSHEET_ID).first<Marker>();}
async function move(env:OperatorEnv,token:string,from:string,to:string):Promise<void>{
 const r=await env.DB.prepare(`UPDATE continuous_cutover_operator SET state=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state=? AND ${integrity} AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=continuous_cutover_operator.spreadsheet_id AND c.operation_token=continuous_cutover_operator.operation_token AND c.state='HELD')`).bind(to,env.GOOGLE_SPREADSHEET_ID,token,from).run();
 if(r.success!==true||r.meta?.changes!==1)throw Error('CUTOVER_OPERATOR_STATE_UNCERTAIN');
}
async function retain(env:OperatorEnv,token:string,from:string):Promise<void>{
 try{await move(env,token,from,'REVIEW');}catch{/* An in-flight state itself blocks retry. */}
 try{await env.DB.prepare("UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',review_reason='CONTINUOUS_CUTOVER_REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind(env.GOOGLE_SPREADSHEET_ID,token).run();}catch{/* HELD is also a fence. */}
}
async function start(env:OperatorEnv):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID!,token=crypto.randomUUID(),initial=scope(env);
 // The insert is atomic with the operator marker. It can never adopt, delete,
 // or change an existing claim, including the incident's original REVIEW.
 const results=await db.batch([
  db.prepare(`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at)
   SELECT ?,?,'HELD',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${integrity}
   AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=?)
   AND NOT EXISTS(SELECT 1 FROM continuous_cutover_operator WHERE spreadsheet_id=?)
   AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE spreadsheet_id=? AND state IN ('ARMED','REVIEW'))
   AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations o JOIN stable_recovery_epochs e ON e.epoch_id=o.epoch_id WHERE e.spreadsheet_id=? AND o.state='ADMITTED')
   AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='PROCESSING')
   AND NOT EXISTS(SELECT 1 FROM staff_config_sync_outbox WHERE status='PROCESSING')
   AND NOT EXISTS(SELECT 1 FROM continuous_report_cutover_attempts WHERE spreadsheet_id=?) AND ${noUnknown}`).bind(book,token,book,book,book,book,book,book,book),
  db.prepare("INSERT INTO continuous_cutover_operator(spreadsheet_id,operation_token,origin,state,created_at,updated_at) SELECT ?,?,'NEW','STARTING',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD')").bind(book,token,book,token),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(env.DB!==db||scope(env)!==initial||!results.every(x=>x.success===true))throw Error('CUTOVER_OPERATOR_START_UNCERTAIN');
 try{await beginStableNotice(env,token,undefined,undefined,true);if(env.DB!==db||scope(env)!==initial||!await stableWorkbookClaimOwned(env,token))throw Error('CUTOVER_OPERATOR_NOTICE_UNVERIFIED');await move(env,token,'STARTING','HELD');}
 catch(error){await retain(env,token,'STARTING');throw error;}
}
type ReviewClaim={operation_token:string;notice_stamp:string;notice_identity:string;created_at:string;phase:string;review_reason:string};
/** The fingerprint is pinned out of band after verifying the exact deployed
 * prewrite code and claim history. It proves identity, not settlement of any
 * other operation or an external writer fence. */
async function startPrewriteReview(env:OperatorEnv):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID!,initial=scope(env),fingerprint=env.CONTINUOUS_CUTOVER_REVIEW_FINGERPRINT;
 if(env.CONTINUOUS_CUTOVER_PREWRITE_REVIEW_ENABLED!=='true'||!fingerprint||!/^[a-f0-9]{64}$/.test(fingerprint))throw Error('CUTOVER_REVIEW_RECOVERY_DISABLED');
 const c=await db.prepare(`SELECT operation_token,notice_stamp,notice_identity,created_at,phase,review_reason FROM stable_workbook_claims WHERE spreadsheet_id=? AND state='REVIEW' AND phase='OPERATION' AND review_reason IN (${dailyReviewReasons})`).bind(book).first<ReviewClaim>();
 if(!c?.operation_token||!c.notice_stamp||!c.notice_identity||!c.created_at||await hash(JSON.stringify([book,c.operation_token,c.notice_stamp,c.notice_identity,c.created_at,c.phase,c.review_reason]))!==fingerprint||!await stableNoticePaused(env,c.notice_stamp,c.notice_identity)||env.DB!==db||scope(env)!==initial)throw Error('CUTOVER_REVIEW_IDENTITY_UNVERIFIED');
 const token=c.operation_token;
 const results=await db.batch([
  db.prepare(`INSERT INTO continuous_cutover_operator(spreadsheet_id,operation_token,origin,original_fingerprint,state,created_at,updated_at)
   SELECT ?,?,'PREWRITE_REVIEW',?,'STARTING',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${integrity}
   AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='stable_projection_writes' AND name IN ('stable_projection_no_delete','stable_projection_no_replace','stable_projection_transition'))=3
   AND EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='REVIEW' AND phase='OPERATION' AND review_reason IN (${dailyReviewReasons}) AND notice_stamp=? AND notice_identity=? AND created_at=?)
   AND NOT EXISTS(SELECT 1 FROM continuous_cutover_operator WHERE spreadsheet_id=?)
   AND NOT EXISTS(SELECT 1 FROM stable_projection_writes WHERE spreadsheet_id=? AND operation_token=?)
   AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes WHERE spreadsheet_id=? AND operation_token=?)
   AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations WHERE operation_token=?)
   AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE spreadsheet_id=? AND state IN ('ARMED','REVIEW'))
   AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations o JOIN stable_recovery_epochs e ON e.epoch_id=o.epoch_id WHERE e.spreadsheet_id=? AND o.state='ADMITTED')
   AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='PROCESSING') AND NOT EXISTS(SELECT 1 FROM staff_config_sync_outbox WHERE status='PROCESSING')
   AND NOT EXISTS(SELECT 1 FROM continuous_report_cutover_attempts WHERE spreadsheet_id=?) AND ${noUnknown}`).bind(book,token,fingerprint,book,token,c.notice_stamp,c.notice_identity,c.created_at,book,book,token,book,token,token,book,book,book,book,book),
  db.prepare(`UPDATE stable_workbook_claims SET state='HELD',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='REVIEW' AND phase='OPERATION' AND review_reason IN (${dailyReviewReasons}) AND notice_stamp=? AND notice_identity=? AND created_at=? AND EXISTS(SELECT 1 FROM continuous_cutover_operator o WHERE o.spreadsheet_id=stable_workbook_claims.spreadsheet_id AND o.operation_token=stable_workbook_claims.operation_token AND o.origin='PREWRITE_REVIEW' AND o.original_fingerprint=? AND o.state='STARTING')`).bind(book,token,c.notice_stamp,c.notice_identity,c.created_at,fingerprint),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(env.DB!==db||scope(env)!==initial||!results.every(r=>r.success===true))throw Error('CUTOVER_REVIEW_RECOVERY_UNCERTAIN');
 try{if(!await stableWorkbookClaimOwned(env,token)||env.DB!==db||scope(env)!==initial)throw Error('CUTOVER_REVIEW_NOTICE_UNVERIFIED');await move(env,token,'STARTING','HELD');}
 catch(error){await retain(env,token,'STARTING');throw error;}
}
type ManifestEntry={sheetId:number;sheetName:string;row:number;column:number;after:string};
/** Re-read each exact formula after migration; no contents enter the response. */
async function verifyInstalledReports(env:OperatorEnv):Promise<void>{
 await captureContinuousReportInputs(env,'REPORTS');
 const rows=await env.DB.prepare("SELECT stage,state,manifest_json,manifest_digest,cell_count FROM continuous_report_cutover_attempts WHERE spreadsheet_id=? AND stage IN ('DAILY_J','REPORTS')").bind(env.GOOGLE_SPREADSHEET_ID).all<{stage:string;state:string;manifest_json:string;manifest_digest:string;cell_count:number}>();
 if(rows.success!==true||rows.results?.length!==2)throw Error('CUTOVER_REPORT_NOT_VERIFIED');
 const sheets=await getSpreadsheetSheetProperties(env,continuousSheetsReadPolicy);
 for(const row of rows.results){
  if(row.state!=='VERIFIED'||await hash(row.manifest_json)!==row.manifest_digest)throw Error('CUTOVER_REPORT_NOT_VERIFIED');
  let entries:ManifestEntry[];try{entries=JSON.parse(row.manifest_json) as ManifestEntry[];}catch{throw Error('CUTOVER_REPORT_NOT_VERIFIED');}
  if(!Array.isArray(entries)||entries.length!==row.cell_count||entries.length<1||entries.length>1000)throw Error('CUTOVER_REPORT_NOT_VERIFIED');
  const groups=new Map<number,{name:string;minRow:number;maxRow:number;minColumn:number;maxColumn:number;entries:ManifestEntry[]}>();
  for(const e of entries){
   const s=sheets.find(x=>x.sheetId===e.sheetId&&x.title===e.sheetName);if(!s||!Number.isSafeInteger(e.row)||e.row<1||e.row>s.rowCount||!Number.isSafeInteger(e.column)||e.column<1||e.column>s.columnCount||!/^[a-f0-9]{64}$/.test(e.after))throw Error('CUTOVER_REPORT_NOT_VERIFIED');
   const g=groups.get(e.sheetId);if(g){if(g.name!==e.sheetName)throw Error('CUTOVER_REPORT_NOT_VERIFIED');g.minRow=Math.min(g.minRow,e.row);g.maxRow=Math.max(g.maxRow,e.row);g.minColumn=Math.min(g.minColumn,e.column);g.maxColumn=Math.max(g.maxColumn,e.column);g.entries.push(e);}
   else groups.set(e.sheetId,{name:e.sheetName,minRow:e.row,maxRow:e.row,minColumn:e.column,maxColumn:e.column,entries:[e]});
  }
  const grouped=[...groups.values()];if(grouped.length>10)throw Error('CUTOVER_REPORT_NOT_VERIFIED');
  const values=await batchGetSheetFormulaValues(env,grouped.map(g=>`${quote(g.name)}!${columnName(g.minColumn)}${g.minRow}:${columnName(g.maxColumn)}${g.maxRow}`),continuousSheetsReadPolicy);
  if(values.length!==grouped.length)throw Error('CUTOVER_REPORT_NOT_VERIFIED');
  for(let i=0;i<grouped.length;i++){const g=grouped[i]!;for(const e of g.entries){const value=values[i]?.[e.row-g.minRow]?.[e.column-g.minColumn];if(!await expectedReportFormulaHashMatches(value,e.after))throw Error('CUTOVER_REPORT_NOT_VERIFIED');}}
 }
}
async function activate(env:OperatorEnv,token:string,expenseIds:readonly [string,string]):Promise<void>{
 await verifyInstalledReports(env);
 const [sheets,revision]=await Promise.all([getSpreadsheetSheetProperties(env,continuousSheetsReadPolicy),env.DB.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').first<{revision:number}>()]);
 const names=[env.SHEET_EXPENSE_DAILY,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET];
 const found=names.map(n=>sheets.find(s=>s.title===n));
 if(names.some(n=>!n)||found.some(s=>!s)||new Set(found.map(s=>s!.sheetId)).size!==4||!revision||!Number.isSafeInteger(revision.revision)||revision.revision<0||found[1]!.sheetId!==Number(env.CONTINUOUS_DAILY_SHEET_ID)||found[2]!.sheetId!==Number(env.CONTINUOUS_RAW_SHEET_ID)||found[3]!.sheetId!==Number(env.CONTINUOUS_DETAIL_SHEET_ID)||!await stableWorkbookClaimOwned(env,token))throw Error('CUTOVER_TARGET_UNVERIFIED');
 const results=await env.DB.batch(continuousDailyCutoverStatements(env,{book:env.GOOGLE_SPREADSHEET_ID!,legacySheetId:found[0]!.sheetId,legacySheetName:names[0]!,continuousSheetId:found[1]!.sheetId,continuousSheetName:names[1]!,rawSheetId:found[2]!.sheetId,rawSheetName:names[2]!,detailSheetId:found[3]!.sheetId,detailSheetName:names[3]!,claim:token,revision:revision.revision,mustBeCancelledOrAbsentExpenseIds:expenseIds}));
 if(!results.every(r=>r.success===true))throw Error('CUTOVER_ACTIVATION_UNCERTAIN');
 const active=await env.DB.prepare("SELECT 1 AS ok FROM continuous_daily_cutovers WHERE spreadsheet_id=? AND claim_token=? AND state='ACTIVE'").bind(env.GOOGLE_SPREADSHEET_ID,token).first<{ok:number}>();if(active?.ok!==1)throw Error('CUTOVER_ACTIVATION_UNCERTAIN');
}
async function stageReady(env:OperatorEnv,action:Exclude<Action,'START'|'START_REVIEW'>):Promise<boolean>{
 const book=env.GOOGLE_SPREADSHEET_ID!;
 const [stages,cutover]=await Promise.all([
  env.DB.prepare("SELECT stage,state FROM continuous_report_cutover_attempts WHERE spreadsheet_id=?").bind(book).all<{stage:string;state:string}>(),
  env.DB.prepare("SELECT state FROM continuous_daily_cutovers WHERE spreadsheet_id=?").bind(book).first<{state:string}>()
 ]);
 if(stages.success!==true||!Array.isArray(stages.results)||stages.results.some(s=>s.state!=='VERIFIED'))return false;
 const names=stages.results.map(s=>s.stage);if(new Set(names).size!==names.length)return false;
 const contains=(...required:string[])=>required.every(x=>names.includes(x));
 if(action==='VIEWS')return names.length===0&&!cutover;
 if(action==='DAILY_J')return names.length===1&&contains('VIEWS')&&!cutover;
 if(action==='REPORTS')return names.length===2&&contains('VIEWS','DAILY_J')&&!cutover;
 if(action==='ACTIVATE')return names.length===3&&contains('VIEWS','DAILY_J','REPORTS')&&!cutover;
 return names.length===3&&contains('VIEWS','DAILY_J','REPORTS')&&cutover?.state==='ACTIVE';
}

/** Narrow authenticated operator entrypoint. Its prewrite REVIEW operation
 * does not prove other provider requests settled, fence external editors,
 * inventory external consumers or grant production release by itself. Those must be
 * verified independently before enabling this feature flag. Each mutation has
 * an operator-owned durable in-flight state and is never automatically retried. */
export async function operateContinuousCutover(env:OperatorEnv,action:unknown,expenseIds?:unknown):Promise<{action:Action;ok:true}>{
 if(!enabled(env)||!['START','START_REVIEW','RECONCILE_VIEWS','VIEWS','DAILY_J','REPORTS','ACTIVATE','RELEASE'].includes(String(action)))throw Error('CUTOVER_OPERATOR_DISABLED');
 const a=action as Action,db=env.DB,initial=scope(env);if(a==='START'){await start(env);return{action:a,ok:true};}if(a==='START_REVIEW'){await startPrewriteReview(env);return{action:a,ok:true};}if(a==='RECONCILE_VIEWS'){await reconcileContinuousViewsIncident(env);return{action:a,ok:true};}
 if(a==='ACTIVATE'&&(!Array.isArray(expenseIds)||expenseIds.length!==2||expenseIds[0]===expenseIds[1]||expenseIds.some(x=>typeof x!=='string'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(x))))throw Error('CUTOVER_RECEIPTS_INVALID');
 const record=await marker(env);if(!record||record.state!=='HELD'||!await stableWorkbookClaimOwned(env,record.operation_token)||env.DB!==db||scope(env)!==initial)throw Error('CUTOVER_OPERATOR_NOT_HELD');
 if(!await stageReady(env,a)||env.DB!==db||scope(env)!==initial)throw Error('CUTOVER_STAGE_NOT_READY');
 const token=record.operation_token,state=a==='ACTIVATE'?'ACTIVATING':a==='RELEASE'?'RELEASING':a;
 await move(env,token,'HELD',state);
 try{
  if(a==='VIEWS')await bootstrapContinuousReportViews(env,token);
  else if(a==='DAILY_J'||a==='REPORTS')await runContinuousReportCutoverStage(env,token,a);
  else if(a==='ACTIVATE')await activate(env,token,expenseIds as [string,string]);
  else if(a==='RELEASE'){
   await verifyInstalledReports(env);
   const active=await db.prepare(`SELECT 1 AS ok FROM continuous_daily_cutovers WHERE spreadsheet_id=? AND claim_token=? AND state='ACTIVE' AND ${noUnknown} AND NOT EXISTS(SELECT 1 FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=? AND a.state<>'VERIFIED')`).bind(env.GOOGLE_SPREADSHEET_ID,token,env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SPREADSHEET_ID).first<{ok:number}>();
   if(active?.ok!==1||!await stableWorkbookClaimOwned(env,token)||env.DB!==db||scope(env)!==initial)throw Error('CUTOVER_RELEASE_NOT_READY');
   await releaseContinuousCutoverNotice(env,token);
   if(env.DB!==db||scope(env)!==initial)throw Error('CUTOVER_SCOPE_CHANGED');
   const results=await db.batch([
    db.prepare("UPDATE continuous_cutover_operator SET state='COMPLETE',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='RELEASING' AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=continuous_cutover_operator.spreadsheet_id AND c.operation_token=continuous_cutover_operator.operation_token AND c.state='HELD') AND EXISTS(SELECT 1 FROM continuous_cutover_notice_release n WHERE n.spreadsheet_id=continuous_cutover_operator.spreadsheet_id AND n.operation_token=continuous_cutover_operator.operation_token AND n.state='VERIFIED')").bind(env.GOOGLE_SPREADSHEET_ID,token),
    db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND EXISTS(SELECT 1 FROM continuous_cutover_operator o WHERE o.spreadsheet_id=stable_workbook_claims.spreadsheet_id AND o.operation_token=stable_workbook_claims.operation_token AND o.state='COMPLETE')").bind(env.GOOGLE_SPREADSHEET_ID,token),
    db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")]);
   if(!results.every(r=>r.success===true))throw Error('CUTOVER_RELEASE_UNCERTAIN');return{action:a,ok:true};
  }
  if(env.DB!==db||scope(env)!==initial||!await stableWorkbookClaimOwned(env,token))throw Error('CUTOVER_SCOPE_CHANGED');await move(env,token,state,'HELD');return{action:a,ok:true};
 }catch(error){await retain(env,token,state);throw error;}
}
