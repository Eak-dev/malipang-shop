import {atomicDailyRowFormulas,decodeAtomicDailyPayload} from './atomic-daily-template';

/** The request's row is chosen by Google at dispatch, not by a pre-read.
 * ROW()/INDEX references keep the formulas attached to their own row if a
 * collaborator inserts or moves rows. Absolute budget and legacy references
 * remain as supplied by the carrier accounting template. */
export function appendDailyRowFormulas(publication?:{sheet:string;rows:number}):Record<number,string>{
 const sentinel=4999,base=atomicDailyRowFormulas(sentinel,publication),result:Record<number,string>={};
 for(const [column,formula] of Object.entries(base)){
  result[Number(column)]=formula.replace(/(?<![A-Za-z0-9_])\$?([A-Z]{1,2})4999(?!\d)/g,(_match,col:string)=>`INDEX(${col}:${col},ROW())`);
  if(result[Number(column)]!.includes('4999'))throw Error('APPEND_DAILY_FORMULA_UNVERIFIED');
 }
 return result;
}

/** A single provider request appends one complete carrier row. Typed strings
 * remain literals even when merchant names begin with '='. This planner does
 * not grant permission to dispatch; the caller must reserve a durable intent,
 * fence prior writes and retain IN_FLIGHT on an ambiguous acknowledgement. */
export function appendDailyRowRequest(sheetId:number,payload:string):unknown{
 if(!Number.isSafeInteger(sheetId)||sheetId<0||!decodeAtomicDailyPayload(payload))throw Error('APPEND_DAILY_REQUEST_INVALID');
 const formula=appendDailyRowFormulas();
 const values=Array.from({length:25},(_,column)=>column===24?{userEnteredValue:{stringValue:payload}}:formula[column]?{userEnteredValue:{formulaValue:formula[column]}}:{});
 return {appendCells:{sheetId,rows:[{values}],fields:'userEnteredValue'}};
}

/** Insert one logical transaction row while leaving the AA:AC budget panel
 * at its physical coordinates. All three requests must be one atomic Google
 * batch; the planner alone does not establish that shifted formulas, other
 * workbook references, or an uncertain response are safe. */
export function insertContinuousDailyRowRequests(sheetId:number,row:number,rowCount:number,payload:string,publication?:{sheet:string;rows:number}):unknown[]{
 // Row 4 is a permanent anchor. Inserting there makes Sheets silently shift
 // absolute $A$4/$I$4 references and omit the new transaction from totals.
 if(!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(rowCount)||rowCount<5||rowCount>=5000||!Number.isSafeInteger(row)||row<5||row>rowCount||!decodeAtomicDailyPayload(payload))throw Error('INSERT_DAILY_REQUEST_INVALID');
 const formula=appendDailyRowFormulas(publication),dataColumns=publication?26:25;
 const values=Array.from({length:dataColumns},(_,column)=>{
  const value=column===24?{userEnteredValue:{stringValue:payload}}:formula[column]?{userEnteredValue:{formulaValue:formula[column]}}:{};
  const format=column===20?{userEnteredFormat:{numberFormat:{type:'DATE',pattern:'dd/MM/yyyy'}}}:column>=4&&column<=18?{userEnteredFormat:{numberFormat:{type:'NUMBER',pattern:'#,##0.00'}}}:{};
  return {...value,...format};
 });
 return [
  {appendDimension:{sheetId,dimension:'ROWS',length:1}},
  {insertRange:{range:{sheetId,startRowIndex:row-1,endRowIndex:row,startColumnIndex:0,endColumnIndex:dataColumns},shiftDimension:'ROWS'}},
  {updateCells:{start:{sheetId,rowIndex:row-1,columnIndex:0},rows:[{values}],fields:'userEnteredValue,userEnteredFormat.numberFormat'}}
 ];
}
