import type {Env} from '../types';
import {batchGetSheetFormulaValues,batchGetSheetValues,getSheetGridInfo} from './client';
import {executeContinuousReportCutover} from './report-cutover-executor';
import type {ReportCutoverSnapshots,ReportSheetSnapshot} from './report-cutover-plan';
import {combinedLedgerSpillFormulas,type LedgerReportTitles} from '../../scripts/combined-ledger-report-formulas.mjs';

type ReportEnv=Env & {CONTINUOUS_REPORT_CUTOVER_ENABLED?:string;CONTINUOUS_RAW_VIEW_ID?:string;CONTINUOUS_DETAIL_VIEW_ID?:string};
type Grid={sheetId:number;rowCount:number;columnCount:number};
const rawView='V52_EXPENSE_RAW_ALL',detailView='V52_PURCHASE_DETAIL_ALL';
const quote=(name:string)=>`'${name.replace(/'/g,"''")}'`;
const hash=async(s:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))),x=>x.toString(16).padStart(2,'0')).join('');
function snapshot(name:string,grid:Grid,rows:unknown[][],startRow:number,startColumn:number):ReportSheetSnapshot{
 const formula:unknown[][]=[];
 for(let i=0;i<rows.length;i++)for(let j=0;j<(rows[i]?.length||0);j++){
  const value=rows[i]?.[j];if(typeof value!=='string'||!value.startsWith('='))continue;
  const row=startRow-1+i,column=startColumn-1+j;while(formula.length<=row)formula.push([]);formula[row]![column]=value;
 }
 return{sheetId:grid.sheetId,sheetName:name,rowCount:grid.rowCount,columnCount:grid.columnCount,formula};
}
async function checkedGrid(env:Env,name:string,minRows:number,minColumns:number,maxRows=5000):Promise<Grid>{
 const g=await getSheetGridInfo(env,name);
 if(g.rowCount<minRows||g.rowCount>maxRows||g.columnCount<minColumns||g.columnCount>100)throw Error('REPORT_GRID_UNVERIFIED');return g;
}

/** Read the formula preimages in one bounded provider read. Data cells are
 * discarded; only formulas are retained in memory and never returned by an
 * HTTP diagnostic. The caller must also validate a fresh workbook-wide
 * inventory of external consumers and settle earlier provider requests. */
export async function captureContinuousReportInputs(env:ReportEnv,stage:'DAILY_J'|'REPORTS'):Promise<{stage:'DAILY_J';snapshot:ReportSheetSnapshot}|{stage:'REPORTS';snapshots:ReportCutoverSnapshots;titles:LedgerReportTitles}>{
 if(env.CONTINUOUS_REPORT_CUTOVER_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||env.SHEET_EXPENSE_RAW!=='V52_EXPENSE_RAW'||(env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ')!=='รายละเอียดการซื้อ')throw Error('REPORT_CUTOVER_DISABLED');
 const db=env.DB,scope=JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.CONTINUOUS_RAW_VIEW_ID,env.CONTINUOUS_DETAIL_VIEW_ID,env.CONTINUOUS_REPORT_CUTOVER_ENABLED]);
 const stable=()=>env.DB===db&&scope===JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.CONTINUOUS_RAW_VIEW_ID,env.CONTINUOUS_DETAIL_VIEW_ID,env.CONTINUOUS_REPORT_CUTOVER_ENABLED]);
 if(env.CONTINUOUS_DAILY_SHEET!=='รายวันต่อเนื่อง_แบบร่าง'||!/^\d+$/.test(env.CONTINUOUS_DAILY_SHEET_ID||''))throw Error('REPORT_TARGET_UNVERIFIED');
 const daily=await checkedGrid(env,env.CONTINUOUS_DAILY_SHEET,4,29);
 if(daily.sheetId!==Number(env.CONTINUOUS_DAILY_SHEET_ID)||!stable())throw Error('REPORT_TARGET_UNVERIFIED');
 if(stage==='DAILY_J'){
  const values=await batchGetSheetFormulaValues(env,[`${quote(env.CONTINUOUS_DAILY_SHEET)}!J4:J${daily.rowCount}`]);
  if(values.length!==1||!stable())throw Error('REPORT_READ_UNVERIFIED');
  return{stage,snapshot:snapshot(env.CONTINUOUS_DAILY_SHEET,daily,values[0]!,4,10)};
 }
 if(stage!=='REPORTS'||!env.CONTINUOUS_RAW_SHEET||!env.CONTINUOUS_DETAIL_SHEET||!/^\d+$/.test(env.CONTINUOUS_RAW_SHEET_ID||'')||!/^\d+$/.test(env.CONTINUOUS_DETAIL_SHEET_ID||'')||!/^\d+$/.test(env.CONTINUOUS_RAW_VIEW_ID||'')||!/^\d+$/.test(env.CONTINUOUS_DETAIL_VIEW_ID||''))throw Error('REPORT_TARGET_UNVERIFIED');
 const names=['04_OWNER_MONTH_CLOSE','97_EXPENSE_CLEAN','98_FORMULA_REVIEW','34_OWNER_DAILY_CASH','35_EXPENSE_FLOW_CHECK','30_RECON_DAILY'] as const;
 const minima=[[5,1],[2,8],[3,6],[76,6],[65,6],[4,20]] as const;
 const grids=await Promise.all(names.map((name,i)=>checkedGrid(env,name,minima[i]![0],minima[i]![1])));
 const ledgerNames=[env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_DETAIL_SHEET,rawView,detailView];
 if(ledgerNames.some(x=>!x)||new Set([...ledgerNames,...names,env.CONTINUOUS_DAILY_SHEET]).size!==ledgerNames.length+names.length+1)throw Error('REPORT_TARGET_ALIAS');
 const ledgers=await Promise.all(ledgerNames.map((name,i)=>checkedGrid(env,name,2,i===1||i===3||i===5?20:18,i>=4?9999:5000)));
 if(ledgers[2]!.sheetId!==Number(env.CONTINUOUS_RAW_SHEET_ID)||ledgers[3]!.sheetId!==Number(env.CONTINUOUS_DETAIL_SHEET_ID)||ledgers[4]!.sheetId!==Number(env.CONTINUOUS_RAW_VIEW_ID)||ledgers[5]!.sheetId!==Number(env.CONTINUOUS_DETAIL_VIEW_ID)||new Set([...grids,...ledgers,daily].map(g=>g.sheetId)).size!==grids.length+ledgers.length+1||!stable())throw Error('REPORT_TARGET_UNVERIFIED');
 const journal=await db.prepare("SELECT state,manifest_digest,manifest_json,cell_count FROM continuous_report_cutover_attempts WHERE spreadsheet_id=? AND stage='VIEWS'").bind(env.GOOGLE_SPREADSHEET_ID).first<{state:string;manifest_digest:string;manifest_json:string;cell_count:number}>();
 if(!journal||journal.state!=='VERIFIED'||journal.cell_count!==4||typeof journal.manifest_json!=='string'||await hash(journal.manifest_json)!==journal.manifest_digest||!stable())throw Error('REPORT_VIEW_IDENTITY_UNVERIFIED');
 let manifest:unknown;try{manifest=JSON.parse(journal.manifest_json);}catch{throw Error('REPORT_VIEW_IDENTITY_UNVERIFIED');}
 const expected=ledgerNames.slice(2).map((title,i)=>({title,sheetId:ledgers[i+2]!.sheetId,kind:i<2?'LEDGER':'VIEW'}));
 if(!Array.isArray(manifest)||manifest.length!==4||manifest.some((entry,i)=>!entry||typeof entry!=='object'||entry.title!==expected[i]!.title||entry.sheetId!==expected[i]!.sheetId||entry.kind!==expected[i]!.kind||typeof entry.requestDigest!=='string'||!/^[0-9a-f]{64}$/.test(entry.requestDigest)))throw Error('REPORT_VIEW_IDENTITY_UNVERIFIED');
 const titles:LedgerReportTitles={rawNew:ledgerNames[2]!,detailNew:ledgerNames[3]!,rawCombined:rawView,detailCombined:detailView};
 const view=combinedLedgerSpillFormulas({...titles,rawOldRows:ledgers[0]!.rowCount,detailOldRows:ledgers[1]!.rowCount,rawNewRows:ledgers[2]!.rowCount,detailNewRows:ledgers[3]!.rowCount});
 if(ledgers[4]!.rowCount<view.rawRows||ledgers[5]!.rowCount<view.detailRows)throw Error('REPORT_VIEW_CAPACITY_UNVERIFIED');
 const ranges=[`${quote(names[0])}!A1:W${grids[0]!.rowCount}`,`${quote(names[1])}!A2:H2`,`${quote(names[2])}!F3:F3`,`${quote(names[3])}!B46:F76`,`${quote(names[4])}!B5:F65`,`${quote(names[5])}!T4:T4`,`${quote(rawView)}!A1:A1`,`${quote(detailView)}!A1:A1`];
 const [values,effective]=await Promise.all([batchGetSheetFormulaValues(env,ranges),batchGetSheetValues(env,[ranges[6]!,ranges[7]!])]);
 if(values.length!==8||effective.length!==2||values[6]?.[0]?.[0]!==view.raw||values[7]?.[0]?.[0]!==view.detail||effective[0]?.[0]?.[0]!=='Expense_ID'||effective[1]?.[0]?.[0]!=='Purchase_Item_ID'||!stable())throw Error('REPORT_VIEW_UNVERIFIED');
 const snapshots:ReportCutoverSnapshots={monthClose:snapshot(names[0],grids[0]!,values[0]!,1,1),clean:snapshot(names[1],grids[1]!,values[1]!,2,1),formulaReview:snapshot(names[2],grids[2]!,values[2]!,3,6),ownerCash:snapshot(names[3],grids[3]!,values[3]!,46,2),flow:snapshot(names[4],grids[4]!,values[4]!,5,2),recon:snapshot(names[5],grids[5]!,values[5]!,4,20)};
 return{stage,snapshots,titles};
}

/** Run one phase while an operator-owned HELD claim and the recovery gate
 * fence cooperating writers. This function is not exposed over HTTP. */
export async function runContinuousReportCutoverStage(env:ReportEnv,claim:string,stage:'DAILY_J'|'REPORTS'){
 const input=await captureContinuousReportInputs(env,stage);
 return executeContinuousReportCutover(env,claim,input);
}
