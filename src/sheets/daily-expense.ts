import type { Env } from "../types";
import { batchClearValues,batchGetSheetValues,batchUpdateSpreadsheet,batchWriteValues,getSheetId } from "./client";

export interface DailyExpenseRecord{
  expenseId:string;transactionDate:string;description:string;amountBaht:number;
  paymentKey:string;sourceWallet:string;category:string;
}
export interface DailyExpensePlacement{row:number;postingMonth:number;postingDay:number;amountColumn:string;sourceWallet:string}
interface MonthBlock{month:number;headerRow:number;totalRow:number}
interface DailyLayout{body:unknown[][];headers:unknown[][];blocks:MonthBlock[]}

const normalize=(value:unknown)=>String(value??"").trim().toLowerCase().replace(/[\s_\-/]+/g,"");
const sheetRange=(sheet:string,range:string)=>`'${sheet.replace(/'/g,"''")}'!${range}`;

export function columnName(index:number):string{let n=index,result="";while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}
function positiveInt(value:unknown):number|null{const n=Number(value);return Number.isInteger(n)&&n>0?n:null;}
function parseTransactionDate(iso:string):{year:number;month:number;day:number}{const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);if(!match)throw new Error(`Invalid expense transaction date: ${iso}`);const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),date=new Date(Date.UTC(year,month-1,day));if(date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)throw new Error(`Invalid expense transaction date: ${iso}`);return{year,month,day};}
function lastDay(year:number,month:number):number{return new Date(Date.UTC(year,month,0)).getUTCDate();}

export function findMonthBlocks(body:unknown[][]):MonthBlock[]{
  const blocks:MonthBlock[]=[];
  for(let i=0;i<body.length;i++){
    const row=body[i]||[],month=positiveInt(row[1]);if(normalize(row[3])!==normalize("รายรับทั้งหมดในบัญชี")||!month||month>12)continue;
    let totalRow=0;for(let j=i+1;j<body.length;j++){const candidate=body[j]||[];if(normalize(candidate[0])===normalize("รวม")&&Number(candidate[1])===month){totalRow=j+1;break;}if(normalize(candidate[3])===normalize("รายรับทั้งหมดในบัญชี"))break;}
    if(totalRow)blocks.push({month,headerRow:i+1,totalRow});
  }
  return blocks;
}

function headerRows(headers:unknown[][]):{row2:unknown[];row3:unknown[]}{return{row2:headers[1]||[],row3:headers[2]||[]};}
function findColumn(row:unknown[],aliases:string[]):number|null{const targets=aliases.map(normalize);for(let i=0;i<row.length;i++){const cell=normalize(row[i]);if(cell&&targets.some(target=>cell===target||cell.includes(target)))return i+1;}return null;}
export function resolvePayment(headers:unknown[][],paymentKey:string,year:number,month:number,day:number):{amountColumn:string;postingMonth:number;postingYear:number;postingDay:number}{
  const key=normalize(paymentKey),{row2,row3}=headerRows(headers);let column:number|null=null,cutoff:number|null=null,isCredit=false;
  if(key==="cash")column=findColumn(row3,["NON-FIXED","NON FIXED"] )||7;
  else if(key==="transfer")column=findColumn(row2,["เงินโอน"] )||8;
  else{
    isCredit=true;const aliases:Record<string,string[]>={kbank:["Kbank"],firstchoice:["First Choice"],aeon:["Aeon"],citibank:["Cibit Bank","Citibank","Citi"],ttb:["Thanachart","TTB"],homepro:["Homepro"],t1:["The One","The 1"]};
    const names=aliases[key];if(!names)throw new Error(`Unsupported expense payment key for daily sheet: ${paymentKey}`);column=findColumn(row3,names);if(!column)throw new Error(`Payment column not found in daily sheet: ${paymentKey}`);cutoff=positiveInt(row2[column-1]);if(!cutoff||cutoff>31)throw new Error(`Credit cutoff day not found in daily sheet: ${paymentKey}`);
  }
  let postingYear=year,postingMonth=month;if(isCredit&&cutoff&&day>cutoff){postingMonth++;if(postingMonth===13){postingMonth=1;postingYear++;}}
  return{amountColumn:columnName(column!),postingMonth,postingYear,postingDay:Math.min(day,lastDay(postingYear,postingMonth))};
}

export function candidateRows(body:unknown[][],blocks:MonthBlock[],month:number):number[]{
  const block=blocks.find(item=>item.month===month);if(!block)throw new Error(`Daily sheet month block not found: ${month}`);const rows:number[]=[];
  for(let row=block.headerRow+1;row<block.totalRow;row++){const values=body[row-1]||[];if(String(values[0]??"").trim()===""&&String(values[3]??"").trim()==="")rows.push(row);}
  return rows;
}
export function monthCapacityExpansionRequests(sheetId:number,totalRow:number):unknown[]{
  // Sheets row indexes are zero based and the total row must stay below the
  // new detail row. Copying the preceding detail row preserves its formulas
  // and formatting; input cells are explicitly cleared before use.
  const index=totalRow-1;
  return[
    {insertDimension:{range:{sheetId,dimension:"ROWS",startIndex:index,endIndex:index+1},inheritFromBefore:true}},
    {copyPaste:{source:{sheetId,startRowIndex:index-1,endRowIndex:index,startColumnIndex:0,endColumnIndex:23},destination:{sheetId,startRowIndex:index,endRowIndex:index+1,startColumnIndex:0,endColumnIndex:23},pasteType:"PASTE_NORMAL",pasteOrientation:"NORMAL"}}
  ];
}
function monthCapacityExpansionRequestsWithMarker(sheetId:number,totalRow:number,marker:string):unknown[]{
  return[...monthCapacityExpansionRequests(sheetId,totalRow),{updateCells:{start:{sheetId,rowIndex:totalRow-1,columnIndex:0},rows:[{values:[{userEnteredValue:{stringValue:marker}}]}],fields:"userEnteredValue"}}];
}

async function loadLayout(env:Env):Promise<DailyLayout>{
  // The production daily tab already exceeds 1,000 rows.  This bounded range
  // deliberately covers the current 2,533-row layout plus room for safe
  // monthly expansion, instead of silently losing later months.
  const [body=[],headers=[]]=await batchGetSheetValues(env,[sheetRange(env.SHEET_EXPENSE_DAILY,"A1:D5000"),sheetRange(env.SHEET_EXPENSE_DAILY,"A1:W3")]);return{body,headers,blocks:findMonthBlocks(body)};
}
export async function checkDailyExpenseSheet(env:Env):Promise<{sheet:string;monthBlocks:number[];amountColumns:Record<string,string>}>{
  const layout=await loadLayout(env),monthBlocks=layout.blocks.map(block=>block.month),missing=Array.from({length:12},(_,i)=>i+1).filter(month=>!monthBlocks.includes(month));if(missing.length)throw new Error(`Daily sheet is missing month blocks: ${missing.join(",")}`);
  const amountColumns=Object.fromEntries(["cash","transfer","kbank","firstchoice","aeon","citibank","ttb","homepro","t1"].map(key=>[key,resolvePayment(layout.headers,key,2026,1,1).amountColumn]));return{sheet:env.SHEET_EXPENSE_DAILY,monthBlocks,amountColumns};
}
async function mappedRow(env:Env,expenseId:string):Promise<number|null>{const found=await env.DB.prepare(`SELECT row_number FROM sheet_row_index WHERE sheet_name=? AND entity_key=?`).bind(env.SHEET_EXPENSE_DAILY,expenseId).first<{row_number:number}>();return found?Number(found.row_number):null;}
async function reserveRow(env:Env,expenseId:string,candidates:number[]):Promise<number>{
  const existing=await mappedRow(env,expenseId);if(existing)return existing;
  for(const row of candidates){
    await env.DB.prepare(`INSERT OR IGNORE INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)`).bind(env.SHEET_EXPENSE_DAILY,expenseId,row).run();
    const allocated=await mappedRow(env,expenseId);if(allocated)return allocated;
  }
  throw new Error("Unable to reserve an empty daily expense row");
}
async function expandMonthCapacity(env:Env,block:MonthBlock,layout:DailyLayout):Promise<boolean>{
  const now=new Date().toISOString(),locked=await env.DB.prepare(`INSERT OR IGNORE INTO daily_sheet_capacity_locks(sheet_name,month,locked_at) VALUES(?,?,?)`).bind(env.SHEET_EXPENSE_DAILY,block.month,now).run();
  if(Number(locked.meta.changes||0)!==1)return false;
  try{
    const existing=await env.DB.prepare(`SELECT anchor_total_row,marker,state FROM daily_sheet_capacity_expansions WHERE sheet_name=? AND month=?`).bind(env.SHEET_EXPENSE_DAILY,block.month).first<{anchor_total_row:number;marker:string;state:string}>(),marker=existing?.marker||`__MALIPANG_CAPACITY_${block.month}_${block.totalRow}__`,markerRow=layout.body.findIndex(row=>String(row?.[0]??"")===marker)+1;
    if(existing?.state==="MAPPED"&&markerRow>0){await batchClearValues(env,[sheetRange(env.SHEET_EXPENSE_DAILY,`A${markerRow}`)]);await env.DB.prepare(`UPDATE daily_sheet_capacity_expansions SET state='COMPLETED',updated_at=? WHERE sheet_name=? AND month=?`).bind(now,env.SHEET_EXPENSE_DAILY,block.month).run();return true;}
    const anchor=existing?.anchor_total_row||block.totalRow;
    if(!existing||existing.state==="COMPLETED")await env.DB.prepare(`INSERT INTO daily_sheet_capacity_expansions(sheet_name,month,anchor_total_row,marker,state,created_at,updated_at) VALUES(?,?,?,?, 'PREPARED',?,?) ON CONFLICT(sheet_name,month) DO UPDATE SET anchor_total_row=excluded.anchor_total_row,marker=excluded.marker,state='PREPARED',updated_at=excluded.updated_at`).bind(env.SHEET_EXPENSE_DAILY,block.month,block.totalRow,marker,now,now).run();
    if(markerRow===0){const sheetId=await getSheetId(env,env.SHEET_EXPENSE_DAILY);await batchUpdateSpreadsheet(env,monthCapacityExpansionRequestsWithMarker(sheetId,anchor,marker));}
    // The marker makes a timeout after Sheets mutation observable.  Mapping is
    // advanced exactly once by the PREPARED -> MAPPED state transition.
    const mapped=await env.DB.prepare(`UPDATE daily_sheet_capacity_expansions SET state='MAPPED',updated_at=? WHERE sheet_name=? AND month=? AND state='PREPARED'`).bind(now,env.SHEET_EXPENSE_DAILY,block.month).run();
    if(Number(mapped.meta.changes||0)===1)await env.DB.prepare(`UPDATE sheet_row_index SET row_number=row_number+1 WHERE sheet_name=? AND row_number>=?`).bind(env.SHEET_EXPENSE_DAILY,anchor).run();
    const refreshed=await loadLayout(env),refreshedMarkerRow=refreshed.body.findIndex(row=>String(row?.[0]??"")===marker)+1;if(refreshedMarkerRow>0)await batchClearValues(env,[sheetRange(env.SHEET_EXPENSE_DAILY,`A${refreshedMarkerRow}`)]);
    await env.DB.prepare(`UPDATE daily_sheet_capacity_expansions SET state='COMPLETED',updated_at=? WHERE sheet_name=? AND month=?`).bind(new Date().toISOString(),env.SHEET_EXPENSE_DAILY,block.month).run();
    return true;
  }finally{await env.DB.prepare(`DELETE FROM daily_sheet_capacity_locks WHERE sheet_name=? AND month=?`).bind(env.SHEET_EXPENSE_DAILY,block.month).run();}
}
export function legacySourceWallet(paymentKey:string,sourceWallet:string):string{return normalize(paymentKey)==="cash"||normalize(sourceWallet)==="cashdrawer"?"ทอน/หน้าร้าน":"บัญชีร้าน";}
export function dailyInputRanges(sheet:string,row:number):string[]{return[sheetRange(sheet,`B${row}:D${row}`),sheetRange(sheet,`F${row}:H${row}`),sheetRange(sheet,`K${row}:Q${row}`),sheetRange(sheet,`V${row}:W${row}`)];}

export async function writeConfirmedExpenseToDaily(env:Env,record:DailyExpenseRecord):Promise<DailyExpensePlacement>{
  if(!record.description.trim()||!Number.isFinite(record.amountBaht)||record.amountBaht<=0)throw new Error("Invalid confirmed expense for daily sheet");
  const {year,month,day}=parseTransactionDate(record.transactionDate);let layout=await loadLayout(env),payment=resolvePayment(layout.headers,record.paymentKey,year,month,day),existing=await mappedRow(env,record.expenseId);
  if(!existing&&candidateRows(layout.body,layout.blocks,payment.postingMonth).length===0){const block=layout.blocks.find(item=>item.month===payment.postingMonth);if(!block)throw new Error(`Daily sheet month block not found: ${payment.postingMonth}`);const expanded=await expandMonthCapacity(env,block,layout);if(!expanded)throw new Error(`Daily sheet capacity expansion is busy for month ${payment.postingMonth}; retry safely.`);layout=await loadLayout(env);payment=resolvePayment(layout.headers,record.paymentKey,year,month,day);}
  const row=existing||await reserveRow(env,record.expenseId,candidateRows(layout.body,layout.blocks,payment.postingMonth)),sourceWallet=legacySourceWallet(record.paymentKey,record.sourceWallet);
  await batchClearValues(env,dailyInputRanges(env.SHEET_EXPENSE_DAILY,row));
  await batchWriteValues(env,[
    {range:sheetRange(env.SHEET_EXPENSE_DAILY,`B${row}:D${row}`),values:[[payment.postingMonth,payment.postingDay,record.description]]},
    {range:sheetRange(env.SHEET_EXPENSE_DAILY,`${payment.amountColumn}${row}`),values:[[record.amountBaht]]},
    {range:sheetRange(env.SHEET_EXPENSE_DAILY,`V${row}:W${row}`),values:[[record.category,sourceWallet]]}
  ]);
  return{row,postingMonth:payment.postingMonth,postingDay:payment.postingDay,amountColumn:payment.amountColumn,sourceWallet};
}
export async function clearCancelledExpenseFromDaily(env:Env,expenseId:string):Promise<number|null>{const row=await mappedRow(env,expenseId);if(!row)return null;await batchClearValues(env,dailyInputRanges(env.SHEET_EXPENSE_DAILY,row));await env.DB.prepare(`DELETE FROM sheet_row_index WHERE sheet_name=? AND entity_key=? AND row_number=?`).bind(env.SHEET_EXPENSE_DAILY,expenseId,row).run();return row;}
