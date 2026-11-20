import {continuousSheetsReadPolicy} from './client';
import type {Env} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,batchGetSheetValues,batchUpdateSpreadsheetWithReply,getSpreadsheetSheetProperties} from './client';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';
import {ledgerCarrierBootstrapRequests,ledgerCarrierFormulas,rawCarrierHeaders,detailCarrierHeaders,type CarrierLedger} from './atomic-expense-ledger-template';
import {combinedLedgerSpillFormulas} from '../../scripts/combined-ledger-report-formulas.mjs';

type ReportEnv=Env & {CONTINUOUS_REPORT_CUTOVER_ENABLED?:string;CONTINUOUS_RAW_VIEW_ID?:string;CONTINUOUS_DETAIL_VIEW_ID?:string};
type Sheet={sheetId:number;title:string;rowCount:number;columnCount:number};
const rawView='V52_EXPENSE_RAW_ALL',detailView='V52_PURCHASE_DETAIL_ALL',count=1000,viewCapacity=9999;
const quote=(s:string)=>`'${s.replace(/'/g,"''")}'`;
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),x=>x.toString(16).padStart(2,'0')).join('');
const blank=(x:unknown)=>x===undefined||x===null||x==='';
/** Google canonicalizes quoted ASCII-only tab names without changing meaning.
 * Allow only this exact provider normalization, not arbitrary formula changes. */
const canonicalizeKnownProviderSheetQuotes=(value:string)=>value.replace(/'(V52_EXPENSE_RAW|V52_EXPENSE_RAW_ALL|V52_PURCHASE_DETAIL_ALL)'!/g,'$1!');
export function viewFormulaEquivalent(observed:unknown,expected:string):boolean{
 return typeof observed==='string'&&canonicalizeKnownProviderSheetQuotes(observed)===canonicalizeKnownProviderSheetQuotes(expected);
}
const triggerIntegrity="(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_report_cutover_attempts' AND name IN ('continuous_report_attempt_insert','continuous_report_attempt_transition','continuous_report_attempt_no_delete','continuous_report_attempt_no_replace'))=4";
const identifier=(v:string|undefined):number=>{if(!v||!/^(0|[1-9]\d*)$/.test(v)||!Number.isSafeInteger(Number(v))||Number(v)>2147483647)throw Error('REPORT_VIEW_TARGET_INVALID');return Number(v);};
function sameSheet(a:Sheet,b:Sheet|undefined):boolean{return !!b&&a.sheetId===b.sheetId&&a.title===b.title&&a.rowCount===b.rowCount&&a.columnCount===b.columnCount;}
function expectedMarkers(requests:unknown[]):string[]{
 const value=requests[2] as {updateCells?:{rows?:Array<{values?:Array<{userEnteredValue?:{stringValue?:unknown}}>}>}};
 const rows=value.updateCells?.rows;if(!Array.isArray(rows)||rows.length!==count-1)throw Error('REPORT_VIEW_BOOTSTRAP_INVALID');
 return rows.map((row,i)=>{const marker=row.values?.[0]?.userEnteredValue?.stringValue;if(typeof marker!=='string'||!new RegExp(`^MPL1_EMPTY_${i+2}_[0-9a-f]{32}$`).test(marker))throw Error('REPORT_VIEW_BOOTSTRAP_INVALID');return marker;});
}
export function verifyEmptyLedger(formula:unknown[][],effective:unknown[][],projection:CarrierLedger,markers:readonly string[]):boolean{
 const headers=projection==='EXPENSE_RAW'?[...rawCarrierHeaders,'Sales_Addback_Basis']:detailCarrierHeaders;
 if(headers.some((h,i)=>formula[0]?.[i]!==h||effective[0]?.[i]!==h)||formula.length>count||effective.length>count)return false;
 for(let row=2;row<=count;row++){
  const f=formula[row-1]??[],e=effective[row-1]??[],template=ledgerCarrierFormulas(projection,row);
  if(f.length>26||e.length>26||f[25]!==markers[row-2]||e[25]!==markers[row-2])return false;
  for(let c=0;c<25;c++)if(Object.hasOwn(template,c)){if(f[c]!==template[c]||!blank(e[c]))return false;}else if(!blank(f[c])||!blank(e[c]))return false;
 }
 return true;
}

/** Create the four NEW carrier/view tabs in one provider request. Existing
 * sheets are never renamed or overwritten. Unknown response or incomplete
 * readback leaves the durable VIEWS attempt IN_FLIGHT for reconciliation. */
export async function bootstrapContinuousReportViews(env:ReportEnv,claim:string):Promise<{stage:'VIEWS';verifiedSheets:number}>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,raw=env.CONTINUOUS_RAW_SHEET,detail=env.CONTINUOUS_DETAIL_SHEET;
 const ids=[identifier(env.CONTINUOUS_RAW_SHEET_ID),identifier(env.CONTINUOUS_DETAIL_SHEET_ID),identifier(env.CONTINUOUS_RAW_VIEW_ID),identifier(env.CONTINUOUS_DETAIL_VIEW_ID)];
 const titles=[raw,detail,rawView,detailView];
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_RECOVERY_GATE_ENABLED,env.STABLE_SHEETS_PACING_ENABLED,env.CONTINUOUS_REPORT_CUTOVER_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.CONTINUOUS_RAW_VIEW_ID,env.CONTINUOUS_DETAIL_VIEW_ID,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS]);const initial=scope(),stable=()=>env.DB===db&&scope()===initial;
 if(!book||!claim||!raw||!detail||raw!==raw.trim()||detail!==detail.trim()||raw.length>80||detail.length>80||new Set(titles).size!==4||new Set(ids).size!==4||env.SHEET_EXPENSE_RAW!=='V52_EXPENSE_RAW'||(env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ')!=='รายละเอียดการซื้อ'||env.STABLE_PHASE1_ENABLED!=='true'||env.STABLE_RECOVERY_GATE_ENABLED!=='true'||env.STABLE_SHEETS_PACING_ENABLED!=='true'||env.CONTINUOUS_REPORT_CUTOVER_ENABLED!=='true')throw Error('REPORT_VIEW_BOOTSTRAP_DISABLED');
 const initialSheets=await getSpreadsheetSheetProperties(env,continuousSheetsReadPolicy),oldRaw=initialSheets.filter(s=>s.title===env.SHEET_EXPENSE_RAW),oldDetail=initialSheets.filter(s=>s.title===(env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ')),daily=initialSheets.filter(s=>s.title===env.CONTINUOUS_DAILY_SHEET);
 if(oldRaw.length!==1||oldDetail.length!==1||daily.length!==1||daily[0]!.sheetId!==identifier(env.CONTINUOUS_DAILY_SHEET_ID)||oldRaw[0]!.rowCount>4000||oldDetail[0]!.rowCount>4000||initialSheets.some(s=>ids.includes(s.sheetId)||titles.includes(s.title))||!stable()||!await stableWorkbookClaimOwned(env,claim))throw Error('REPORT_VIEW_TARGET_UNVERIFIED');
 const formula=combinedLedgerSpillFormulas({rawNew:raw,detailNew:detail,rawCombined:rawView,detailCombined:detailView,rawOldRows:oldRaw[0]!.rowCount,detailOldRows:oldDetail[0]!.rowCount,rawNewRows:count,detailNewRows:count});
 const rawRequests=ledgerCarrierBootstrapRequests('EXPENSE_RAW',ids[0]!,raw,count),detailRequests=ledgerCarrierBootstrapRequests('DETAIL',ids[1]!,detail,count),markers=[expectedMarkers(rawRequests),expectedMarkers(detailRequests)];
 const requests=[...rawRequests,...detailRequests,
  {addSheet:{properties:{sheetId:ids[2],title:rawView,gridProperties:{rowCount:viewCapacity,columnCount:18,frozenRowCount:1}}}},
  {addSheet:{properties:{sheetId:ids[3],title:detailView,gridProperties:{rowCount:viewCapacity,columnCount:20,frozenRowCount:1}}}},
  {updateCells:{start:{sheetId:ids[2],rowIndex:0,columnIndex:0},rows:[{values:[{userEnteredValue:{formulaValue:formula.raw}}]}],fields:'userEnteredValue'}},
  {updateCells:{start:{sheetId:ids[3],rowIndex:0,columnIndex:0},rows:[{values:[{userEnteredValue:{formulaValue:formula.detail}}]}],fields:'userEnteredValue'}}];
 const manifest=await Promise.all(titles.map(async(title,i)=>({sheetId:ids[i],title,kind:i<2?'LEDGER':'VIEW',requestDigest:await hash(JSON.stringify(i===0?rawRequests:i===1?detailRequests:i===2?formula.raw:formula.detail))})));
 const manifestJson=JSON.stringify(manifest),digest=await hash(manifestJson);
 const intent=await db.prepare(`INSERT INTO continuous_report_cutover_attempts(spreadsheet_id,stage,operation_token,manifest_digest,manifest_json,cell_count,state,created_at,updated_at)
  SELECT ?,'VIEWS',?,?,?,?, 'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${triggerIntegrity}
  AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')`).bind(book,claim,digest,manifestJson,4,book,claim).run();
 if(!stable()||intent.success!==true||Number(intent.meta?.changes)!==1)throw Error('REPORT_VIEW_INTENT_UNCERTAIN');
 const reply=await batchUpdateSpreadsheetWithReply(env,requests,async()=>{
  const current=await getSpreadsheetSheetProperties(env,continuousSheetsReadPolicy);
  if(!stable()||!await stableWorkbookClaimOwned(env,claim)||current.some(s=>ids.includes(s.sheetId)||titles.includes(s.title))||!initialSheets.every(s=>sameSheet(s,current.find(x=>x.sheetId===s.sheetId))))throw Error('REPORT_VIEW_PRE_DISPATCH_CHANGED');
 });
 const replies=reply&&typeof reply==='object'?(reply as {replies?:unknown[]}).replies:undefined;
 if(!Array.isArray(replies)||replies.length!==requests.length)throw Error('REPORT_VIEW_OUTCOME_UNKNOWN');
 const after=await getSpreadsheetSheetProperties(env,continuousSheetsReadPolicy);
 if(!stable()||!initialSheets.every(s=>sameSheet(s,after.find(x=>x.sheetId===s.sheetId)))||titles.some((title,i)=>{const s=after.find(x=>x.sheetId===ids[i]);return !s||s.title!==title||s.rowCount<(i<2?count:viewCapacity)||s.columnCount<(i<2?26:i===2?18:20);}))throw Error('REPORT_VIEW_READBACK_UNVERIFIED');
 const ranges=[`${quote(raw)}!A1:Z${count}`,`${quote(detail)}!A1:Z${count}`,`${quote(rawView)}!A1`,`${quote(detailView)}!A1`];
 const [f,e,viewValues]=await Promise.all([batchGetSheetFormulaValues(env,ranges,continuousSheetsReadPolicy),batchGetSheetEffectiveSerialValues(env,ranges.slice(0,2),continuousSheetsReadPolicy),batchGetSheetValues(env,ranges.slice(2),continuousSheetsReadPolicy)]);
 if(f.length!==4||e.length!==2||viewValues.length!==2||!verifyEmptyLedger(f[0]!,e[0]!,'EXPENSE_RAW',markers[0]!)||!verifyEmptyLedger(f[1]!,e[1]!,'DETAIL',markers[1]!)||!viewFormulaEquivalent(f[2]?.[0]?.[0],formula.raw)||!viewFormulaEquivalent(f[3]?.[0]?.[0],formula.detail)||viewValues[0]?.[0]?.[0]!=='Expense_ID'||viewValues[1]?.[0]?.[0]!=='Purchase_Item_ID'||!stable()||!await stableWorkbookClaimOwned(env,claim))throw Error('REPORT_VIEW_READBACK_UNVERIFIED');
 const verified=await db.prepare(`UPDATE continuous_report_cutover_attempts SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND stage='VIEWS' AND operation_token=? AND manifest_digest=? AND state='IN_FLIGHT' AND ${triggerIntegrity} AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')`).bind(book,claim,digest,book,claim).run();
 if(!stable()||verified.success!==true||Number(verified.meta?.changes)!==1)throw Error('REPORT_VIEW_VERIFICATION_UNCERTAIN');
 return{stage:'VIEWS',verifiedSheets:4};
}
