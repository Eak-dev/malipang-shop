import type {Env} from '../types';
import {batchGetSheetFormulaValues,batchUpdateSpreadsheetWithReply,getSheetGridInfo} from './client';
import {columnName} from './daily-expense';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';
import {planContinuousReportCutover,planManualDailyBudgetUpgrade,reportFormulaCompareAndSwapRequests,type ReportCutoverSnapshots,type ReportFormulaChange,type ReportSheetSnapshot} from './report-cutover-plan';
import type {LedgerReportTitles} from '../../scripts/combined-ledger-report-formulas.mjs';

type ReportEnv=Env & {CONTINUOUS_REPORT_CUTOVER_ENABLED?:string;CONTINUOUS_RAW_VIEW_ID?:string;CONTINUOUS_DETAIL_VIEW_ID?:string};
type ReportInput={stage:'REPORTS';snapshots:ReportCutoverSnapshots;titles:LedgerReportTitles}|{stage:'DAILY_J';snapshot:ReportSheetSnapshot};
type TargetGroup={sheetId:number;sheetName:string;minRow:number;maxRow:number;minColumn:number;maxColumn:number};
const triggerIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_report_cutover_attempts' AND name IN ('continuous_report_attempt_insert','continuous_report_attempt_transition','continuous_report_attempt_no_delete','continuous_report_attempt_no_replace'))=4";
const hash=async(value:string):Promise<string>=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
const q=(name:string)=>`'${name.replace(/'/g,"''")}'`;

function groupsFor(changes:readonly ReportFormulaChange[]):TargetGroup[]{
 const byId=new Map<number,TargetGroup>();
 for(const c of changes){
  const old=byId.get(c.sheetId);
  if(old){if(old.sheetName!==c.sheetName)throw Error('REPORT_TARGET_ALIAS');old.minRow=Math.min(old.minRow,c.row);old.maxRow=Math.max(old.maxRow,c.row);old.minColumn=Math.min(old.minColumn,c.column);old.maxColumn=Math.max(old.maxColumn,c.column);}
  else byId.set(c.sheetId,{sheetId:c.sheetId,sheetName:c.sheetName,minRow:c.row,maxRow:c.row,minColumn:c.column,maxColumn:c.column});
 }
 return [...byId.values()].sort((a,b)=>a.sheetId-b.sheetId);
}
async function readCurrent(env:Env,changes:readonly ReportFormulaChange[],groups:readonly TargetGroup[]):Promise<unknown[]>{
 const grids=await Promise.all(groups.map(g=>getSheetGridInfo(env,g.sheetName)));
 if(grids.some((g,i)=>g.sheetId!==groups[i]!.sheetId||g.rowCount<groups[i]!.maxRow||g.columnCount<groups[i]!.maxColumn))throw Error('REPORT_TARGET_CHANGED');
 const ranges=groups.map(g=>`${q(g.sheetName)}!${columnName(g.minColumn)}${g.minRow}:${columnName(g.maxColumn)}${g.maxRow}`);
 const values=await batchGetSheetFormulaValues(env,ranges);
 if(values.length!==groups.length||values.some((rows,i)=>rows.length>groups[i]!.maxRow-groups[i]!.minRow+1||rows.some(row=>!Array.isArray(row)||row.length>groups[i]!.maxColumn-groups[i]!.minColumn+1)))throw Error('REPORT_READ_UNVERIFIED');
 const index=new Map(groups.map((g,i)=>[g.sheetId,i]));
 return changes.map(c=>{const i=index.get(c.sheetId);if(i===undefined)throw Error('REPORT_TARGET_CHANGED');const g=groups[i]!;return values[i]?.[c.row-g.minRow]?.[c.column-g.minColumn]??null;});
}

/** Execute one preplanned stage against exactly matched formula cells. This
 * function is not exposed as an admin route and must be invoked only by the
 * reviewed cutover controller after a fresh workbook-wide consumer inventory,
 * helper-view verification and external-writer/old-request reconciliation.
 * A partial or unknown provider response leaves a durable IN_FLIGHT record;
 * no caller may automatically retry it. */
export async function executeContinuousReportCutover(env:ReportEnv,claim:string,input:ReportInput):Promise<{stage:'REPORTS'|'DAILY_J';verifiedCells:number}>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_RECOVERY_GATE_ENABLED,env.STABLE_SHEETS_PACING_ENABLED,env.CONTINUOUS_REPORT_CUTOVER_ENABLED,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.CONTINUOUS_RAW_VIEW_ID,env.CONTINUOUS_DETAIL_VIEW_ID]);const initial=scope();
 if(!book||!claim||env.STABLE_PHASE1_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||env.STABLE_SHEETS_PACING_ENABLED!=='true'||env.CONTINUOUS_REPORT_CUTOVER_ENABLED!=='true')throw Error('REPORT_CUTOVER_DISABLED');
 if(input.stage==='REPORTS'&&(input.titles.rawNew!==env.CONTINUOUS_RAW_SHEET||input.titles.detailNew!==env.CONTINUOUS_DETAIL_SHEET||input.titles.rawCombined!=='V52_EXPENSE_RAW_ALL'||input.titles.detailCombined!=='V52_PURCHASE_DETAIL_ALL'))throw Error('REPORT_CUTOVER_TARGET_UNVERIFIED');
 const changes=input.stage==='REPORTS'?planContinuousReportCutover(input.snapshots,input.titles):planManualDailyBudgetUpgrade(input.snapshot);
 const requests=reportFormulaCompareAndSwapRequests(changes),groups=groupsFor(changes),stable=()=>env.DB===db&&scope()===initial;
 if(!stable()||!await stableWorkbookClaimOwned(env,claim)||!stable())throw Error('REPORT_CUTOVER_CLAIM_UNVERIFIED');
 const before=await readCurrent(env,changes,groups);if(before.some((v,i)=>v!==changes[i]!.before)||!stable()||!await stableWorkbookClaimOwned(env,claim))throw Error('REPORT_CUTOVER_PREIMAGE_CHANGED');
 const manifest=await Promise.all(changes.map(async c=>({sheetId:c.sheetId,sheetName:c.sheetName,row:c.row,column:c.column,before:await hash(c.before),after:await hash(c.after)})));
 const manifestJson=JSON.stringify(manifest),digest=await hash(manifestJson);
 if(!stable()||!await stableWorkbookClaimOwned(env,claim))throw Error('REPORT_CUTOVER_CLAIM_UNVERIFIED');
 const intent=await db.prepare(`INSERT INTO continuous_report_cutover_attempts(spreadsheet_id,stage,operation_token,manifest_digest,manifest_json,cell_count,state,created_at,updated_at)
  SELECT ?,?,?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${triggerIntegrity}
  AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')`)
  .bind(book,input.stage,claim,digest,manifestJson,changes.length,book,claim).run();
 if(!stable()||intent.success!==true||Number(intent.meta?.changes)!==1)throw Error('REPORT_CUTOVER_INTENT_UNCERTAIN');
 const reply=await batchUpdateSpreadsheetWithReply(env,requests,async()=>{
  if(!stable()||!await stableWorkbookClaimOwned(env,claim))throw Error('REPORT_CUTOVER_CLAIM_UNVERIFIED');
  const current=await readCurrent(env,changes,groups);
  if(current.some((v,i)=>v!==changes[i]!.before)||!stable()||!await stableWorkbookClaimOwned(env,claim))throw Error('REPORT_CUTOVER_PRE_DISPATCH_CHANGED');
 });
 const replies=reply&&typeof reply==='object'?(reply as {replies?:Array<{findReplace?:{formulasChanged?:unknown;occurrencesChanged?:unknown}}>}).replies:undefined;
 if(!Array.isArray(replies)||replies.length!==changes.length||replies.some(r=>r?.findReplace?.formulasChanged!==1||r.findReplace.occurrencesChanged!==1))throw Error('REPORT_CUTOVER_PARTIAL_OR_UNKNOWN');
 const after=await readCurrent(env,changes,groups);
 if(after.some((v,i)=>v!==changes[i]!.after)||!stable()||!await stableWorkbookClaimOwned(env,claim))throw Error('REPORT_CUTOVER_READBACK_UNVERIFIED');
 const verified=await db.prepare(`UPDATE continuous_report_cutover_attempts SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE spreadsheet_id=? AND stage=? AND operation_token=? AND manifest_digest=? AND state='IN_FLIGHT' AND ${triggerIntegrity}
  AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')`).bind(book,input.stage,claim,digest,book,claim).run();
 if(!stable()||verified.success!==true||Number(verified.meta?.changes)!==1)throw Error('REPORT_CUTOVER_VERIFICATION_UNCERTAIN');
 return{stage:input.stage,verifiedCells:changes.length};
}
