import type {Env} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,batchGetSheetValues,continuousSheetsReadPolicy,getSpreadsheetSheetProperties} from './client';
import {ledgerCarrierBootstrapRequests} from './atomic-expense-ledger-template';
import {verifyEmptyLedger,viewFormulaEquivalent} from './report-view-bootstrap';
import {stableNoticePaused} from './stable-edit-notice';
import {combinedLedgerSpillFormulas} from '../../scripts/combined-ledger-report-formulas.mjs';

type IncidentEnv=Env & {CONTINUOUS_VIEWS_INCIDENT_RECOVERY_ENABLED?:string;CONTINUOUS_CUTOVER_OPERATOR_ENABLED?:string;CONTINUOUS_REPORT_CUTOVER_ENABLED?:string;CONTINUOUS_DAILY_SHEET_ID?:string;CONTINUOUS_RAW_VIEW_ID?:string;CONTINUOUS_DETAIL_VIEW_ID?:string};
type Claim={operation_token:string;state:string;phase:string;review_reason:string;notice_stamp:string;notice_identity:string};
type Operator={operation_token:string;origin:string;state:string;original_fingerprint:string};
type Attempt={operation_token:string;stage:string;state:string;manifest_json:string;manifest_digest:string;cell_count:number};
type ManifestEntry={sheetId:number;title:string;kind:string;requestDigest:string};
type Sheet={sheetId:number;title:string;rowCount:number;columnCount:number};

const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
const quote=(s:string)=>"'"+s.replaceAll("'","''")+"'";
const hardFail=():never=>{throw Error('VIEWS_INCIDENT_RECOVERY_NOT_VERIFIED')};
const matches=(a:Sheet,b:Sheet|undefined)=>!!b&&a.sheetId===b.sheetId&&a.title===b.title&&a.rowCount===b.rowCount&&a.columnCount===b.columnCount;
const markerAt=(value:unknown,row:number)=>typeof value==='string'&&new RegExp('^MPL1_EMPTY_'+row+'_[0-9a-f]{32}$').test(value);

export async function reconcileContinuousViewsIncident(env:IncidentEnv):Promise<{stage:'VIEWS';reconciled:true}>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_RECOVERY_GATE_ENABLED,env.STABLE_SHEETS_PACING_ENABLED,env.CONTINUOUS_REPORT_CUTOVER_ENABLED,env.CONTINUOUS_CUTOVER_OPERATOR_ENABLED,env.CONTINUOUS_VIEWS_INCIDENT_RECOVERY_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.CONTINUOUS_RAW_VIEW_ID,env.CONTINUOUS_DETAIL_VIEW_ID]);
 const original=scope(),stable=()=>env.DB===db&&scope()===original;
 if(!book||env.CONTINUOUS_VIEWS_INCIDENT_RECOVERY_ENABLED!=='true'||env.CONTINUOUS_CUTOVER_OPERATOR_ENABLED!=='true'||env.CONTINUOUS_REPORT_CUTOVER_ENABLED!=='true'||env.STABLE_PHASE1_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||env.STABLE_SHEETS_PACING_ENABLED!=='true'||![undefined,'','false'].includes(env.CONTINUOUS_DAILY_ENABLED))hardFail();
 const [claim,operator,attempt,counts]=await Promise.all([
  db.prepare("SELECT operation_token,state,phase,review_reason,notice_stamp,notice_identity FROM stable_workbook_claims WHERE spreadsheet_id=?").bind(book).first<Claim>(),
  db.prepare("SELECT operation_token,origin,state,original_fingerprint FROM continuous_cutover_operator WHERE spreadsheet_id=?").bind(book).first<Operator>(),
  db.prepare("SELECT operation_token,stage,state,manifest_json,manifest_digest,cell_count FROM continuous_report_cutover_attempts WHERE spreadsheet_id=?").bind(book).first<Attempt>(),
  db.prepare("SELECT (SELECT COUNT(*) FROM continuous_report_cutover_attempts WHERE spreadsheet_id=?) AS attempts,(SELECT COUNT(*) FROM continuous_daily_cutovers WHERE spreadsheet_id=?) AS cutovers,(SELECT COUNT(*) FROM continuous_views_incident_recovery WHERE spreadsheet_id=?) AS existing,(SELECT COUNT(*) FROM sync_jobs WHERE status='PROCESSING') AS processing,(SELECT COUNT(*) FROM staff_config_sync_outbox WHERE status='PROCESSING') AS staff,(SELECT COUNT(*) FROM stable_projection_writes WHERE state<>'VERIFIED') AS projections,(SELECT COUNT(*) FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED') AS cancellations,(SELECT COUNT(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW')) AS epochs,(SELECT COUNT(*) FROM stable_recovery_operations WHERE state='ADMITTED') AS admitted").bind(book,book,book).first<Record<string,number>>()
 ]);
 if(!claim||!operator||!attempt||!counts)throw Error('VIEWS_INCIDENT_RECOVERY_NOT_VERIFIED');
 if(!stable()||counts.attempts!==1||counts.cutovers!==0||counts.existing!==0||counts.processing!==0||counts.staff!==0||counts.projections!==0||counts.cancellations!==0||counts.epochs!==0||counts.admitted!==0||claim.state!=='REVIEW'||claim.phase!=='OPERATION'||claim.review_reason!=='CONTINUOUS_CUTOVER_REVIEW'||!claim.notice_stamp||!claim.notice_identity||operator.operation_token!==claim.operation_token||operator.origin!=='PREWRITE_REVIEW'||operator.state!=='REVIEW'||!/^[0-9a-f]{64}$/.test(operator.original_fingerprint)||attempt.operation_token!==claim.operation_token||attempt.stage!=='VIEWS'||attempt.state!=='IN_FLIGHT'||attempt.cell_count!==4)hardFail();
 let entries:ManifestEntry[];try{entries=JSON.parse(attempt.manifest_json) as ManifestEntry[]}catch{hardFail()}
 if(!Array.isArray(entries!)||entries!.length!==4||await hash(attempt.manifest_json)!==attempt.manifest_digest)hardFail();
 const ids=[env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET_ID,env.CONTINUOUS_RAW_VIEW_ID,env.CONTINUOUS_DETAIL_VIEW_ID].map(x=>Number(x));
 const titles=[env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET,'V52_EXPENSE_RAW_ALL','V52_PURCHASE_DETAIL_ALL'];
 if(ids.some(x=>!Number.isSafeInteger(x)||x<0)||new Set(ids).size!==4||titles.some(x=>typeof x!=='string'||!x)||new Set(titles).size!==4||entries!.some((x,i)=>x.sheetId!==ids[i]||x.title!==titles[i]||x.kind!==(i<2?'LEDGER':'VIEW')||!/^[0-9a-f]{64}$/.test(x.requestDigest)))hardFail();
 const before=await getSpreadsheetSheetProperties(env,continuousSheetsReadPolicy),oldRaw=before.find(x=>x.title==='V52_EXPENSE_RAW'),oldDetail=before.find(x=>x.title==='รายละเอียดการซื้อ'),daily=before.find(x=>x.title===env.CONTINUOUS_DAILY_SHEET);
 if(!oldRaw||!oldDetail||!daily)throw Error('VIEWS_INCIDENT_RECOVERY_NOT_VERIFIED');
 if(before.length!==100||daily.sheetId!==Number(env.CONTINUOUS_DAILY_SHEET_ID)||oldRaw.rowCount!==1000||oldDetail.rowCount!==1000||entries!.some((e,i)=>{const p=before.find(x=>x.sheetId===ids[i]);return !p||p.title!==titles[i]||p.rowCount!==(i<2?1000:9999)||p.columnCount!==(i<2?26:i===2?18:20)})||!stable()||!await stableNoticePaused(env,claim.notice_stamp,claim.notice_identity))hardFail();
 const ranges=[quote(titles[0]!)+'!A1:Z1000',quote(titles[1]!)+'!A1:Z1000',quote(titles[2]!)+'!A1',quote(titles[3]!)+'!A1'];
 const [f,e,views]=await Promise.all([batchGetSheetFormulaValues(env,ranges,continuousSheetsReadPolicy),batchGetSheetEffectiveSerialValues(env,ranges.slice(0,2),continuousSheetsReadPolicy),batchGetSheetValues(env,ranges.slice(2),continuousSheetsReadPolicy)]);
 if(f.length!==4||e.length!==2||views.length!==2||f[0]!.length!==1000||f[1]!.length!==1000||e[0]!.length!==1000||e[1]!.length!==1000)hardFail();
 const markers=[f[0]!.slice(1).map(row=>row[25]),f[1]!.slice(1).map(row=>row[25])];
 if(markers.some(ms=>ms.length!==999||new Set(ms).size!==999||ms.some((m,i)=>!markerAt(m,i+2))))hardFail();
 if(!verifyEmptyLedger(f[0]!,e[0]!,'EXPENSE_RAW',markers[0] as string[])||!verifyEmptyLedger(f[1]!,e[1]!,'DETAIL',markers[1] as string[]))hardFail();
 const formulas=combinedLedgerSpillFormulas({rawNew:titles[0]!,detailNew:titles[1]!,rawCombined:titles[2]!,detailCombined:titles[3]!,rawOldRows:oldRaw.rowCount,detailOldRows:oldDetail.rowCount,rawNewRows:1000,detailNewRows:1000});
 const rawRequest=ledgerCarrierBootstrapRequests('EXPENSE_RAW',ids[0]!,titles[0]!,1000,markers[0] as string[]);
 const detailRequest=ledgerCarrierBootstrapRequests('DETAIL',ids[1]!,titles[1]!,1000,markers[1] as string[]);
 const checks=[await hash(JSON.stringify(rawRequest)),await hash(JSON.stringify(detailRequest)),await hash(JSON.stringify(formulas.raw)),await hash(JSON.stringify(formulas.detail))];
 if(checks.some((x,i)=>x!==entries![i]!.requestDigest)||!viewFormulaEquivalent(f[2]?.[0]?.[0],formulas.raw)||!viewFormulaEquivalent(f[3]?.[0]?.[0],formulas.detail)||views[0]?.[0]?.[0]!=='Expense_ID'||views[1]?.[0]?.[0]!=='Purchase_Item_ID')hardFail();
 const after=await getSpreadsheetSheetProperties(env,continuousSheetsReadPolicy);
 if(!stable()||JSON.stringify(before)!==JSON.stringify(after)||!await stableNoticePaused(env,claim.notice_stamp,claim.notice_identity))hardFail();
 const live=await db.prepare("SELECT state,manifest_digest,operation_token FROM continuous_report_cutover_attempts WHERE spreadsheet_id=? AND stage='VIEWS'").bind(book).first<{state:string;manifest_digest:string;operation_token:string}>();
 if(!stable()||live?.state!=='IN_FLIGHT'||live.operation_token!==claim.operation_token||live.manifest_digest!==attempt.manifest_digest)hardFail();
 const proof=await hash(JSON.stringify([attempt.manifest_digest,checks,markers.map(m=>m.length),f[2]?.[0]?.[0],f[3]?.[0]?.[0]]));
 const results=await db.batch([
  db.prepare("INSERT INTO continuous_views_incident_recovery(spreadsheet_id,operation_token,manifest_digest,provider_evidence_digest,verified_at,state) VALUES(?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'VERIFIED')").bind(book,claim.operation_token,attempt.manifest_digest,proof),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok"),
  db.prepare("UPDATE continuous_report_cutover_attempts SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND stage='VIEWS' AND state='IN_FLIGHT' AND manifest_digest=?").bind(book,claim.operation_token,attempt.manifest_digest),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok"),
  db.prepare("UPDATE stable_workbook_claims SET state='HELD',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='REVIEW' AND phase='OPERATION' AND review_reason='CONTINUOUS_CUTOVER_REVIEW' AND notice_stamp=? AND notice_identity=?").bind(book,claim.operation_token,claim.notice_stamp,claim.notice_identity),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok"),
  db.prepare("UPDATE continuous_cutover_operator SET state='HELD',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND origin='PREWRITE_REVIEW' AND state='REVIEW'").bind(book,claim.operation_token),
  db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
 ]);
 if(!stable()||results.length!==8||results.some(x=>x.success!==true))throw Error('VIEWS_INCIDENT_RECOVERY_OUTCOME_UNKNOWN_NO_RETRY');
 const [c,o,a,r]=await Promise.all([
  db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id=?").bind(book).first<{state:string}>(),
  db.prepare("SELECT state FROM continuous_cutover_operator WHERE spreadsheet_id=?").bind(book).first<{state:string}>(),
  db.prepare("SELECT state FROM continuous_report_cutover_attempts WHERE spreadsheet_id=? AND stage='VIEWS'").bind(book).first<{state:string}>(),
  db.prepare("SELECT state FROM continuous_views_incident_recovery WHERE spreadsheet_id=?").bind(book).first<{state:string}>()
 ]);
 if(!stable()||c?.state!=='HELD'||o?.state!=='HELD'||a?.state!=='VERIFIED'||r?.state!=='VERIFIED')throw Error('VIEWS_INCIDENT_RECOVERY_OUTCOME_UNKNOWN_NO_RETRY');
 return{stage:'VIEWS',reconciled:true};
}
