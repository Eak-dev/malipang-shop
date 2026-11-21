import {appendDailyRowFormulas} from './append-daily-template';
import {continuousDailyHelperFormulas} from './continuous-daily-plan';
import type {MonthlyReady} from './monthly-d1-preview';

/** Builds a native-row candidate after the old grid plus a spare row.
 * The known index is unsafe if another writer can add rows concurrently;
 * this pure planner never dispatches or establishes the required fence. */
export function manualReportNativeRowRequests(sheetId:number,oldRows:number,formatSourceRow:number,row:MonthlyReady,marker:string):unknown[]{
 const date=new Date(Date.UTC(row.postingYear,row.postingMonth-1,row.postingDay));
 if(!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(oldRows)||oldRows<5||oldRows>4998||!Number.isSafeInteger(formatSourceRow)||formatSourceRow<4||formatSourceRow>oldRows||!/^MRP1_[0-9a-f]{32}$/.test(marker)||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(row.expenseId)||!Number.isSafeInteger(row.sourceVersion)||row.sourceVersion<1||!Number.isSafeInteger(row.amountSatang)||row.amountSatang<=0||!Number.isInteger(row.postingYear)||row.postingYear<1900||row.postingYear>9999||date.getUTCFullYear()!==row.postingYear||date.getUTCMonth()+1!==row.postingMonth||date.getUTCDate()!==row.postingDay||[row.description,row.category,row.wallet].some(x=>typeof x!=='string'||!x.trim()||x!==x.trim()||x.length>1000))throw Error('MONTHLY_REPORT_REQUEST_INVALID');
 const amountColumns:Record<string,number>={F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16},col=amountColumns[row.amountColumn];if(col===undefined)throw Error('MONTHLY_REPORT_PAYMENT_INVALID');
 const text=(value:string)=>({userEnteredValue:{stringValue:value}}),number=(value:number)=>({userEnteredValue:{numberValue:value}}),formulas={...continuousDailyHelperFormulas(oldRows+1),9:appendDailyRowFormulas()[9]!};
 const values:Array<Record<string,unknown>>=Array.from({length:25},()=>({}));
 values[0]=number(row.postingYear);values[1]=number(row.postingMonth);values[2]=number(row.postingDay);values[3]=text(row.description);values[col]=number(row.amountSatang/100);
 values[21]=text(row.category);values[22]=text(row.wallet);
 for(const [key,value] of Object.entries(formulas))values[Number(key)]={userEnteredValue:{formulaValue:value}};
 return [
  {appendDimension:{sheetId,dimension:'ROWS',length:2}},
  {copyPaste:{source:{sheetId,startRowIndex:formatSourceRow-1,endRowIndex:formatSourceRow,startColumnIndex:0,endColumnIndex:25},destination:{sheetId,startRowIndex:oldRows,endRowIndex:oldRows+1,startColumnIndex:0,endColumnIndex:25},pasteType:'PASTE_FORMAT',pasteOrientation:'NORMAL'}},
  {updateCells:{start:{sheetId,rowIndex:oldRows,columnIndex:0},rows:[{values}],fields:'userEnteredValue'}},
  {updateCells:{start:{sheetId,rowIndex:oldRows,columnIndex:19},rows:[{values:[{note:marker}]}],fields:'note'}}
 ];
}
