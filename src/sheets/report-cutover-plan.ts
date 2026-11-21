import {continuousCashReconciliationFormula,continuousCleanFormula,continuousFlowCountFormula,continuousFlowTotalFormula,continuousOwnerCashFormula} from '../../scripts/continuous-daily-report-formulas.mjs';
import {rewriteLedgerConsumerFormula,type LedgerReportTitles} from '../../scripts/combined-ledger-report-formulas.mjs';
import {continuousDailyHelperFormulas} from './continuous-daily-plan';
import {appendDailyRowFormulas} from './append-daily-template';

/** An exact formula change is safe to request only with provider-side matching.
 * This planner does not read Sheets, acquire a claim, or authorize a write. */
export type ReportFormulaChange={sheetId:number;sheetName:string;row:number;column:number;before:string;after:string};
export type ReportSheetSnapshot={sheetId:number;sheetName:string;rowCount:number;columnCount:number;formula:unknown[][]};
export type ReportCutoverSnapshots={monthClose:ReportSheetSnapshot;clean:ReportSheetSnapshot;formulaReview:ReportSheetSnapshot;ownerCash:ReportSheetSnapshot;flow:ReportSheetSnapshot;recon:ReportSheetSnapshot};

function checkedSheet(s:ReportSheetSnapshot,name:string,minRows:number,minColumns:number):void{
 if(!s||s.sheetName!==name||!Number.isSafeInteger(s.sheetId)||s.sheetId<0||!Number.isSafeInteger(s.rowCount)||s.rowCount<minRows||s.rowCount>5000||!Number.isSafeInteger(s.columnCount)||s.columnCount<minColumns||s.columnCount>100||!Array.isArray(s.formula)||s.formula.length>s.rowCount||s.formula.some(row=>!Array.isArray(row)||row.length>s.columnCount))throw Error('REPORT_SNAPSHOT_UNVERIFIED');
}
function formula(s:ReportSheetSnapshot,row:number,column:number):string{
 const value=s.formula[row-1]?.[column-1];
 if(typeof value!=='string'||!value.startsWith('='))throw Error('REPORT_FORMULA_PREIMAGE_MISMATCH');
 return value;
}
function directLedgerReference(value:string):boolean{return /(?:'V52_EXPENSE_RAW'|V52_EXPENSE_RAW|'รายละเอียดการซื้อ'|รายละเอียดการซื้อ)!/.test(value);}

/** Produce the known affected report edits from complete, freshly read
 * formula snapshots. An independent workbook-wide consumer inventory is
 * required before using this plan for a production cutover. */
export function planContinuousReportCutover(s:ReportCutoverSnapshots,titles:LedgerReportTitles):ReportFormulaChange[]{
 checkedSheet(s.monthClose,'04_OWNER_MONTH_CLOSE',5,1);checkedSheet(s.clean,'97_EXPENSE_CLEAN',2,8);
 checkedSheet(s.formulaReview,'98_FORMULA_REVIEW',3,6);checkedSheet(s.ownerCash,'34_OWNER_DAILY_CASH',76,6);
 checkedSheet(s.flow,'35_EXPENSE_FLOW_CHECK',65,6);checkedSheet(s.recon,'30_RECON_DAILY',4,20);
 const sheets=Object.values(s);if(new Set(sheets.map(x=>x.sheetId)).size!==sheets.length)throw Error('REPORT_SHEET_ALIAS');
 const changes:ReportFormulaChange[]=[];
 const add=(sheet:ReportSheetSnapshot,row:number,column:number,after:(before:string)=>string)=>{
  const before=formula(sheet,row,column),next=after(before);
  if(typeof next!=='string'||!next.startsWith('=')||next===before)throw Error('REPORT_FORMULA_PLAN_UNVERIFIED');
  changes.push({sheetId:sheet.sheetId,sheetName:sheet.sheetName,row,column,before,after:next});
 };
 add(s.clean,2,1,before=>rewriteLedgerConsumerFormula(continuousCleanFormula(before),titles));
 add(s.clean,2,8,before=>rewriteLedgerConsumerFormula(before,titles));
 add(s.formulaReview,3,6,before=>rewriteLedgerConsumerFormula(before,titles));
 let monthCloseCount=0;
 for(let i=0;i<s.monthClose.formula.length;i++)for(let j=0;j<(s.monthClose.formula[i]?.length||0);j++){
  const value=s.monthClose.formula[i]?.[j];
  if(typeof value==='string'&&value.startsWith('=')&&directLedgerReference(value)){
   add(s.monthClose,i+1,j+1,before=>rewriteLedgerConsumerFormula(before,titles));monthCloseCount++;
  }
 }
 if(monthCloseCount===0)throw Error('REPORT_CONSUMER_INVENTORY_UNVERIFIED');
 for(let row=46;row<=76;row++)for(const [column,name] of [[2,'B'],[3,'C'],[4,'D'],[6,'F']] as const)add(s.ownerCash,row,column,before=>continuousOwnerCashFormula(before,row,name));
 for(let row=5;row<=65;row++){
  add(s.flow,row,2,before=>continuousFlowTotalFormula(before,row));
  add(s.flow,row,6,before=>continuousFlowCountFormula(before,row));
 }
 add(s.recon,4,20,continuousCashReconciliationFormula);
 if(new Set(changes.map(x=>`${x.sheetId}:${x.row}:${x.column}`)).size!==changes.length)throw Error('REPORT_FORMULA_DUPLICATE');
 return changes;
}

/** Upgrade only the exact default J formula in each existing draft row.
 * Values entered in other cells and owner-customized formulas are never
 * overwritten. A changed J stops the entire plan before any request. */
export function planManualDailyBudgetUpgrade(sheet:ReportSheetSnapshot):ReportFormulaChange[]{
 checkedSheet(sheet,'รายวันต่อเนื่อง_แบบร่าง',4,29);
 const result:ReportFormulaChange[]=[],updated=appendDailyRowFormulas()[9];
 if(!updated)throw Error('REPORT_FORMULA_PLAN_UNVERIFIED');
 for(let row=4;row<=sheet.rowCount;row++){
  const before=formula(sheet,row,10),expected=continuousDailyHelperFormulas(row)[9];
  if(before!==expected)throw Error('REPORT_FORMULA_PREIMAGE_MISMATCH');
  result.push({sheetId:sheet.sheetId,sheetName:sheet.sheetName,row,column:10,before,after:updated});
 }
 return result;
}

/** Each request targets one exact prior formula in one cell. A zero-match,
 * partial reply, timeout or failed readback is not permission to retry. */
export function reportFormulaCompareAndSwapRequests(changes:readonly ReportFormulaChange[]):unknown[]{
 if(!Array.isArray(changes)||changes.length===0||changes.length>1000)throw Error('REPORT_FORMULA_PLAN_UNVERIFIED');
 const seen=new Set<string>();
 return changes.map(change=>{
  if(!Number.isSafeInteger(change.sheetId)||change.sheetId<0||!Number.isSafeInteger(change.row)||change.row<1||!Number.isSafeInteger(change.column)||change.column<1||typeof change.before!=='string'||!change.before.startsWith('=')||typeof change.after!=='string'||!change.after.startsWith('=')||change.before===change.after)throw Error('REPORT_FORMULA_PLAN_UNVERIFIED');
  const key=`${change.sheetId}:${change.row}:${change.column}`;if(seen.has(key))throw Error('REPORT_FORMULA_DUPLICATE');seen.add(key);
  return {findReplace:{range:{sheetId:change.sheetId,startRowIndex:change.row-1,endRowIndex:change.row,startColumnIndex:change.column-1,endColumnIndex:change.column},find:change.before,replacement:change.after,matchCase:true,matchEntireCell:true,searchByRegex:false,includeFormulas:true}};
 });
}
