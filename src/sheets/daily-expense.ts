import type { Env } from "../types";
import { batchClearValues,batchGetSheetValues,batchUpdateSpreadsheet,batchWriteValues,getSheetId } from "./client";

export interface DailyExpenseRecord{
  expenseId:string;transactionDate:string;description:string;amountBaht:number;
  paymentKey:string;sourceWallet:string;category:string;
}
export interface DailyExpenseDocument{
  documentId:string;documentType:string;vendorName:string;legalVendorName:string;
  documentNumber:string;orderId:string;
}
export interface DailyExpenseDocumentItem{
  itemId:string;documentId:string;expenseId:string|null;sellerKey:string;productCode:string;
  description:string;quantity:number|null;unit:string;unitPriceSatang:number|null;
  discountSatang:number|null;lineTotalSatang:number|null;
}
export interface DailyExpenseEntry{
  rowKey:string;description:string;amountBaht:number;
}
export interface DailyExpensePostingPlan{
  mode:"ITEMIZED"|"SUMMARY_FALLBACK";reason:string;entries:DailyExpenseEntry[];
}
export interface DailyExpensePlacement{entityKey:string;row:number;postingMonth:number;postingDay:number;amountColumn:string;sourceWallet:string}
interface MonthBlock{month:number;headerRow:number;totalRow:number}
interface DailyLayout{body:unknown[][];headers:unknown[][];blocks:MonthBlock[]}

const normalize=(value:unknown)=>String(value??"").trim().toLowerCase().replace(/[\s_\-/]+/g,"");
const sheetRange=(sheet:string,range:string)=>`'${sheet.replace(/'/g,"''")}'!${range}`;
const itemizedDocumentTypes=new Set(["RECEIPT","TAX_INVOICE","RECEIPT_TAX_INVOICE"]);

export function columnName(index:number):string{let n=index,result="";while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}
function positiveInt(value:unknown):number|null{const n=Number(value);return Number.isInteger(n)&&n>0?n:null;}
function normalizedText(value:unknown):string{return String(value??"").trim();}
function satangFromBaht(value:number):number|null{if(!Number.isFinite(value))return null;const satang=Math.round(value*100);return Number.isSafeInteger(satang)?satang:null;}
function displayNumber(value:number):string{return Number.isInteger(value)?String(value):String(Number(value.toFixed(4)));}
function displayBahtFromSatang(value:number):string{return value%100===0?String(value/100):(value/100).toFixed(2);}
function parseTransactionDate(iso:string):{year:number;month:number;day:number}{const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);if(!match)throw new Error(`Invalid expense transaction date: ${iso}`);const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]),date=new Date(Date.UTC(year,month-1,day));if(date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)throw new Error(`Invalid expense transaction date: ${iso}`);return{year,month,day};}
function lastDay(year:number,month:number):number{return new Date(Date.UTC(year,month,0)).getUTCDate();}

export function dailyItemDescription(document:DailyExpenseDocument,item:DailyExpenseDocumentItem):string{
  const vendor=normalizedText(document.vendorName)||normalizedText(document.legalVendorName)||normalizedText(item.sellerKey);
  const reference=normalizedText(document.documentNumber)||normalizedText(document.orderId);
  const description=normalizedText(item.description)||normalizedText(item.productCode)||"Item";
  const parts=[vendor,reference,description].filter(Boolean);
  if(item.quantity!=null&&Number.isFinite(item.quantity)&&item.unitPriceSatang!=null&&Number.isSafeInteger(item.unitPriceSatang)){
    const quantity=`${displayNumber(item.quantity)}${normalizedText(item.unit)?` ${normalizedText(item.unit)}`:""}`;
    parts.push(`${quantity} x ${displayBahtFromSatang(item.unitPriceSatang)}`);
  }
  return parts.join(" | ");
}

export function buildDailyExpenseEntries(record:DailyExpenseRecord,document:DailyExpenseDocument|null,items:DailyExpenseDocumentItem[]):DailyExpensePostingPlan{
  const summary={rowKey:record.expenseId,description:record.description.trim(),amountBaht:record.amountBaht};
  const fallback=(reason:string):DailyExpensePostingPlan=>({mode:"SUMMARY_FALLBACK",reason,entries:[summary]});
  const finalSatang=satangFromBaht(record.amountBaht);
  if(!summary.description||finalSatang==null||finalSatang<=0)return fallback("Invalid finalized expense amount or description");
  if(!document)return fallback("No primary purchase document");
  if(!itemizedDocumentTypes.has(normalizedText(document.documentType).toUpperCase()))return fallback("Document type is not itemized in daily sheet");
  if(!items.length)return fallback("No normalized document line items");
  const itemIds=new Set<string>();let totalSatang=0;
  for(const item of items){
    const itemId=normalizedText(item.itemId),lineTotal=item.lineTotalSatang;
    if(!itemId||itemIds.has(itemId)||normalizedText(item.documentId)!==document.documentId||item.expenseId!==record.expenseId||!normalizedText(item.description)||!Number.isSafeInteger(lineTotal)||lineTotal!<=0)return fallback("Line items are incomplete or invalid");
    itemIds.add(itemId);totalSatang+=lineTotal!;
  }
  if(totalSatang!==finalSatang)return fallback("Line totals do not reconcile to final paid amount");
  return{mode:"ITEMIZED",reason:"Exact line totals reconcile to final paid amount",entries:items.map(item=>({rowKey:`${record.expenseId}|${item.itemId}`,description:dailyItemDescription(document,item),amountBaht:Number(item.lineTotalSatang)/100}))};
}

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
export function requiredMonthlyCapacityExpansions(availableRows:number,requiredRows:number):number{return Math.max(0,requiredRows-Math.max(0,availableRows));}
export function isDailyExpenseMappingKey(expenseId:string,entityKey:string):boolean{return entityKey===expenseId||entityKey.startsWith(`${expenseId}|`);}
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
async function mappedRowsForExpense(env:Env,expenseId:string):Promise<Array<{entityKey:string;row:number}>>{
  const result=await env.DB.prepare(`SELECT entity_key,row_number FROM sheet_row_index WHERE sheet_name=? AND (entity_key=? OR substr(entity_key,1,length(?)+1)=? || '|') ORDER BY row_number ASC`).bind(env.SHEET_EXPENSE_DAILY,expenseId,expenseId,expenseId).all<{entity_key:string;row_number:number}>();
  return(result.results||[]).filter(item=>isDailyExpenseMappingKey(expenseId,String(item.entity_key))).map(item=>({entityKey:String(item.entity_key),row:Number(item.row_number)}));
}
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
    const existing=await env.DB.prepare(`SELECT anchor_total_row,marker,state FROM daily_sheet_capacity_expansions WHERE sheet_name=? AND month=?`).bind(env.SHEET_EXPENSE_DAILY,block.month).first<{anchor_total_row:number;marker:string;state:string}>();
    // A completed expansion cannot be reused: its old anchor now points to a
    // detail row.  Every new slot is inserted immediately before the current
    // monthly total, while an interrupted expansion resumes from its marker.
    const inFlight=!!existing&&existing.state!=="COMPLETED",anchor=inFlight?Number(existing!.anchor_total_row):block.totalRow,marker=inFlight?existing!.marker:`__MALIPANG_CAPACITY_${block.month}_${block.totalRow}__`,markerRow=layout.body.findIndex(row=>String(row?.[0]??"")===marker)+1;
    if(existing?.state==="MAPPED"&&markerRow>0){await batchClearValues(env,[sheetRange(env.SHEET_EXPENSE_DAILY,`A${markerRow}`)]);await env.DB.prepare(`UPDATE daily_sheet_capacity_expansions SET state='COMPLETED',updated_at=? WHERE sheet_name=? AND month=?`).bind(now,env.SHEET_EXPENSE_DAILY,block.month).run();return true;}
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

async function reserveDailyEntryRows(env:Env,record:DailyExpenseRecord,entries:DailyExpenseEntry[]):Promise<{payment:ReturnType<typeof resolvePayment>;rows:Map<string,number>}>{
  if(!record.description.trim()||!Number.isFinite(record.amountBaht)||record.amountBaht<=0)throw new Error("Invalid confirmed expense for daily sheet");
  if(!entries.length)throw new Error("No confirmed expense entries for daily sheet");
  const entryKeys=new Set(entries.map(entry=>entry.rowKey));if(entryKeys.size!==entries.length||[...entryKeys].some(key=>!key.trim()))throw new Error("Daily expense entry keys must be stable and unique");
  if(entries.some(entry=>!entry.description.trim()||!Number.isFinite(entry.amountBaht)||entry.amountBaht<=0))throw new Error("Invalid confirmed daily expense entry");
  const {year,month,day}=parseTransactionDate(record.transactionDate);let layout=await loadLayout(env),payment=resolvePayment(layout.headers,record.paymentKey,year,month,day),rows=new Map<string,number>();
  for(const entry of entries){const existing=await mappedRow(env,entry.rowKey);if(existing)rows.set(entry.rowKey,existing);}
  while(rows.size<entries.length){
    const candidates=candidateRows(layout.body,layout.blocks,payment.postingMonth);
    if(requiredMonthlyCapacityExpansions(candidates.length,entries.length-rows.size)===0)break;
    const block=layout.blocks.find(item=>item.month===payment.postingMonth);if(!block)throw new Error(`Daily sheet month block not found: ${payment.postingMonth}`);
    const expanded=await expandMonthCapacity(env,block,layout);if(!expanded)throw new Error(`Daily sheet capacity expansion is busy for month ${payment.postingMonth}; retry safely.`);
    // Existing item mappings after the inserted total row move down one row.
    // Reload them from D1 before writing so a retry never targets the old row.
    layout=await loadLayout(env);payment=resolvePayment(layout.headers,record.paymentKey,year,month,day);rows=new Map<string,number>();
    for(const entry of entries){const existing=await mappedRow(env,entry.rowKey);if(existing)rows.set(entry.rowKey,existing);}
  }
  let candidates=candidateRows(layout.body,layout.blocks,payment.postingMonth);
  for(const entry of entries)if(!rows.has(entry.rowKey)){const row=await reserveRow(env,entry.rowKey,candidates);rows.set(entry.rowKey,row);candidates=candidates.filter(candidate=>candidate!==row);}
  return{payment,rows};
}

export function buildDailySheetWritePlan(sheet:string,record:DailyExpenseRecord,payment:ReturnType<typeof resolvePayment>,sourceWallet:string,entries:DailyExpenseEntry[],rows:Map<string,number>):{clearRanges:string[];writes:Array<{range:string;values:unknown[][]}>}{
  return{
    clearRanges:entries.flatMap(entry=>dailyInputRanges(sheet,rows.get(entry.rowKey)!)),
    writes:entries.flatMap(entry=>{const row=rows.get(entry.rowKey)!;return[
      {range:sheetRange(sheet,`B${row}:D${row}`),values:[[payment.postingMonth,payment.postingDay,entry.description]]},
      {range:sheetRange(sheet,`${payment.amountColumn}${row}`),values:[[entry.amountBaht]]},
      {range:sheetRange(sheet,`V${row}:W${row}`),values:[[record.category,sourceWallet]]}
    ];})
  };
}

async function writeDailyExpenseEntries(env:Env,record:DailyExpenseRecord,entries:DailyExpenseEntry[]):Promise<DailyExpensePlacement[]>{
  const {payment,rows}=await reserveDailyEntryRows(env,record,entries),sourceWallet=legacySourceWallet(record.paymentKey,record.sourceWallet),writePlan=buildDailySheetWritePlan(env.SHEET_EXPENSE_DAILY,record,payment,sourceWallet,entries,rows);
  await batchClearValues(env,writePlan.clearRanges);
  await batchWriteValues(env,writePlan.writes);
  return entries.map(entry=>({entityKey:entry.rowKey,row:rows.get(entry.rowKey)!,postingMonth:payment.postingMonth,postingDay:payment.postingDay,amountColumn:payment.amountColumn,sourceWallet}));
}

export async function writeConfirmedExpenseWithDocumentItemsToDaily(env:Env,record:DailyExpenseRecord,document:DailyExpenseDocument|null,items:DailyExpenseDocumentItem[]):Promise<{plan:DailyExpensePostingPlan;placements:DailyExpensePlacement[]}>{
  const plan=buildDailyExpenseEntries(record,document,items);
  // Existing summary mappings are historical reporting rows.  Keep them as-is
  // on automatic reconcile; only newly posted expenses acquire item row keys.
  if(plan.mode==="ITEMIZED"&&await mappedRow(env,record.expenseId)){
    const summary:DailyExpensePostingPlan={mode:"SUMMARY_FALLBACK",reason:"Existing legacy summary mapping is preserved",entries:[{rowKey:record.expenseId,description:record.description.trim(),amountBaht:record.amountBaht}]};
    return{plan:summary,placements:await writeDailyExpenseEntries(env,record,summary.entries)};
  }
  return{plan,placements:await writeDailyExpenseEntries(env,record,plan.entries)};
}

export async function writeConfirmedExpenseToDaily(env:Env,record:DailyExpenseRecord):Promise<DailyExpensePlacement>{
  const result=await writeDailyExpenseEntries(env,record,[{rowKey:record.expenseId,description:record.description.trim(),amountBaht:record.amountBaht}]);
  return result[0]!;
}

export async function clearCancelledExpenseFromDaily(env:Env,expenseId:string):Promise<number[]>{
  const mapped=await mappedRowsForExpense(env,expenseId);if(!mapped.length)return[];
  await batchClearValues(env,mapped.flatMap(item=>dailyInputRanges(env.SHEET_EXPENSE_DAILY,item.row)));
  await env.DB.prepare(`DELETE FROM sheet_row_index WHERE sheet_name=? AND (entity_key=? OR substr(entity_key,1,length(?)+1)=? || '|')`).bind(env.SHEET_EXPENSE_DAILY,expenseId,expenseId,expenseId).run();
  return mapped.map(item=>item.row);
}
