import type { Env } from "../types";
import { batchGetSheetValues,batchGetSheetFormulaValues,batchWriteValues } from "./client";
import {withCorrectionDailyWriteFence,type GuardedDailyMutation,type DailyFenceExpenseSnapshot} from "./owner-correction-daily-write-fence";

export class DailyCancelReviewRequired extends Error{
  constructor(reason="DAILY_CANCEL_IDENTITY_REVIEW_REQUIRED"){super(reason);this.name="DailyCancelReviewRequired";}
}

export interface DailyExpenseRecord{
  expenseId:string;transactionDate:string;description:string;amountBaht:number;
  paymentKey:string;sourceWallet:string;category:string;version:number;
}
function fenceSnapshot(record:DailyExpenseRecord):DailyFenceExpenseSnapshot{return{expenseId:record.expenseId,version:record.version,transactionDate:record.transactionDate,description:record.description,amountSatang:Math.round(record.amountBaht*100),paymentKey:record.paymentKey,sourceWallet:record.sourceWallet,category:record.category};}
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
export interface DailyExpensePostingPlan{mode:"SUMMARY";reason:string;entries:DailyExpenseEntry[];}
export interface DailyExpenseItemPostingOptions{replaceLegacySummary?:boolean}
export interface DailyExpensePlacement{entityKey:string;row:number;postingMonth:number;postingDay:number;amountColumn:string;sourceWallet:string}
interface MonthBlock{month:number;headerRow:number;totalRow:number}
interface DailyLayout{body:unknown[][];headers:unknown[][];blocks:MonthBlock[]}

const normalize=(value:unknown)=>String(value??"").trim().toLowerCase().replace(/[\s_\-/]+/g,"");
const sheetRange=(sheet:string,range:string)=>`'${sheet.replace(/'/g,"''")}'!${range}`;

export function columnName(index:number):string{let n=index,result="";while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}
function positiveInt(value:unknown):number|null{const n=Number(value);return Number.isInteger(n)&&n>0?n:null;}
function normalizedText(value:unknown):string{return String(value??"").trim();}
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
  // `รายวัน` is the cash-outflow ledger: exactly one row per finalized
  // Expense.  Purchase detail is written separately to `รายละเอียดการซื้อ`.
  // Keep the arguments for compatibility with callers and to make the policy
  // explicit at this boundary; neither a long receipt nor a retry may change
  // the ledger cardinality.
  void document;void items;
  const description=record.description.trim()||"Expense document";
  if(!Number.isFinite(record.amountBaht)||record.amountBaht<=0)throw new Error("Invalid finalized expense amount");
  return{mode:"SUMMARY",reason:"Daily ledger is one summary row per Expense",entries:[{rowKey:record.expenseId,description,amountBaht:record.amountBaht}]};
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
  const existing=await mappedRow(env,expenseId);if(existing!==null)throw new DailyCancelReviewRequired("DAILY_CONFIRMED_IDENTITY_UNVERIFIED");
  for(const row of candidates){
    const inserted=await env.DB.prepare(`INSERT OR IGNORE INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)`).bind(env.SHEET_EXPENSE_DAILY,expenseId,row).run();
    const allocated=await mappedRow(env,expenseId);
    if(Number(inserted.meta.changes||0)===1&&allocated===row)return row;
    if(allocated!==null)throw new DailyCancelReviewRequired("DAILY_CONFIRMED_IDENTITY_UNVERIFIED");
  }
  // Visually blank rows may already be mapped to other expenses; retrying
  // cannot prove they are safe or create new capacity.
  throw new DailyCancelReviewRequired("DAILY_CAPACITY_ROWS_RESERVED_REVIEW_REQUIRED");
}
/** Historical D1-only repair primitive; no runtime callers. It does not prove
 * a Sheets insertion happened at the intended row and must not be used to
 * resume or repair an ambiguous expansion without independent review. */
export async function mapDailyCapacityExpansion(env:Env,month:number,anchor:number,marker:string,now:string,fenceToken:string):Promise<boolean>{
  const sheet=env.SHEET_EXPENSE_DAILY;if(!sheet||!fenceToken||!Number.isSafeInteger(month)||month<1||month>12||!Number.isSafeInteger(anchor)||anchor<2||!marker||!Number.isFinite(Date.parse(now)))return false;
  const active=`EXISTS(SELECT 1 FROM daily_sheet_capacity_expansions e WHERE e.sheet_name=? AND e.month=? AND e.anchor_total_row=? AND e.marker=? AND e.state='PREPARED') AND EXISTS(SELECT 1 FROM owner_correction_daily_write_fences f WHERE f.sheet_name=? AND f.lease_token=? AND f.state='OWNED' AND f.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
  const fenceAssert=`SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM owner_correction_daily_write_fences WHERE sheet_name=? AND lease_token=? AND state='OWNED' AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN json('daily capacity fence lost') ELSE 1 END AS verified`;
  const result=await env.DB.batch([
    env.DB.prepare(fenceAssert).bind(sheet,fenceToken),
    env.DB.prepare(`SELECT CASE WHEN ${active} AND EXISTS(SELECT 1 FROM sheet_row_index WHERE sheet_name=? AND row_number<=0) THEN json('invalid daily sheet row mapping') ELSE 1 END AS verified`).bind(sheet,month,anchor,marker,sheet,fenceToken,sheet),
    env.DB.prepare(`UPDATE sheet_row_index SET row_number=-row_number WHERE sheet_name=? AND row_number>=? AND ${active}`).bind(sheet,anchor,sheet,month,anchor,marker,sheet,fenceToken),
    env.DB.prepare(`UPDATE sheet_row_index SET row_number=-row_number+1 WHERE sheet_name=? AND row_number<=-? AND ${active}`).bind(sheet,anchor,sheet,month,anchor,marker,sheet,fenceToken),
    env.DB.prepare(`UPDATE daily_sheet_capacity_expansions SET state='MAPPED',updated_at=? WHERE sheet_name=? AND month=? AND anchor_total_row=? AND marker=? AND state='PREPARED' AND NOT EXISTS(SELECT 1 FROM sheet_row_index WHERE sheet_name=? AND row_number<=0) AND ${active}`).bind(now,sheet,month,anchor,marker,sheet,sheet,month,anchor,marker,sheet,fenceToken),
    env.DB.prepare(`SELECT CASE WHEN ${active} THEN json('incomplete daily sheet mapping') ELSE 1 END AS verified`).bind(sheet,month,anchor,marker,sheet,fenceToken),
    env.DB.prepare(fenceAssert).bind(sheet,fenceToken)
  ]);
  return Number(result[4]?.meta.changes||0)===1;
}
export function legacySourceWallet(paymentKey:string,sourceWallet:string):string{
  // Funding source is independent of payment method: cash can come from the
  // shop bank rather than the till. Preserve the legacy fallback otherwise.
  if(normalize(sourceWallet)==="shopbank")return"บัญชีร้าน";
  return normalize(paymentKey)==="cash"||normalize(sourceWallet)==="cashdrawer"?"ทอน/หน้าร้าน":"บัญชีร้าน";
}
export function dailyInputRanges(sheet:string,row:number):string[]{return[sheetRange(sheet,`B${row}:D${row}`),sheetRange(sheet,`F${row}:H${row}`),sheetRange(sheet,`K${row}:Q${row}`),sheetRange(sheet,`V${row}:W${row}`)];}

async function reserveDailyEntryRows(env:Env,record:DailyExpenseRecord,entries:DailyExpenseEntry[]):Promise<{payment:ReturnType<typeof resolvePayment>;rows:Map<string,number>}>{
  if(!record.description.trim()||!Number.isFinite(record.amountBaht)||record.amountBaht<=0)throw new Error("Invalid confirmed expense for daily sheet");
  if(!entries.length)throw new Error("No confirmed expense entries for daily sheet");
  const entryKeys=new Set(entries.map(entry=>entry.rowKey));if(entryKeys.size!==entries.length||[...entryKeys].some(key=>!key.trim()))throw new Error("Daily expense entry keys must be stable and unique");
  if(entries.some(entry=>!entry.description.trim()||!Number.isFinite(entry.amountBaht)||entry.amountBaht<=0))throw new Error("Invalid confirmed daily expense entry");
  // A numeric D1 mapping is merely a historical hint: manual row insertions
  // can make it point at a different expense. The daily sheet has no durable
  // authenticated ID for old rows, and even a full value match does not prove
  // identity. Hold rather than clearing an existing mapped row. A replacement
  // path must first establish independently authenticated row identity.
  for(const entry of entries)if(await mappedRow(env,entry.rowKey)!==null)throw new DailyCancelReviewRequired("DAILY_CONFIRMED_IDENTITY_UNVERIFIED");
  const {year,month,day}=parseTransactionDate(record.transactionDate),layout=await loadLayout(env),payment=resolvePayment(layout.headers,record.paymentKey,year,month,day),rows=new Map<string,number>();
  // No automatic row insertion or recovery: historical PREPARED anchors may
  // refer to another month, and copying a populated row duplicates inputs.
  // A full month must remain held until capacity and any prior ambiguous
  // expansion are independently reviewed. Clock expiry is not proof of safety.
  if(requiredMonthlyCapacityExpansions(candidateRows(layout.body,layout.blocks,payment.postingMonth).length,entries.length)>0)throw new DailyCancelReviewRequired("DAILY_CAPACITY_MANUAL_REVIEW_REQUIRED");
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

async function writeDailyExpenseEntries(env:Env,record:DailyExpenseRecord,entries:DailyExpenseEntry[],write:GuardedDailyMutation):Promise<DailyExpensePlacement[]>{
  // Revalidation reduces stale-work risk. The caller that changes the expense
  // must also hold this same sheet-wide fence; this check is not a Sheets CAS.
  const current=async()=>{
    const row=await env.DB.prepare(`SELECT expense_id,transaction_date,description,amount_satang,payment_key,source_wallet,category,status,version FROM expense_events WHERE expense_id=?`).bind(record.expenseId).first<{expense_id:string;transaction_date:string;description:string;amount_satang:number;payment_key:string;source_wallet:string;category:string;status:string;version:number}>();
    if(!row||row.status!=="CONFIRMED"||!Number.isSafeInteger(record.version)||Number(row.version)!==record.version||row.transaction_date!==record.transactionDate||row.description!==record.description||Number(row.amount_satang)!==Math.round(record.amountBaht*100)||row.payment_key!==record.paymentKey||row.source_wallet!==record.sourceWallet||row.category!==record.category)throw new DailyCancelReviewRequired("DAILY_CONFIRMED_SNAPSHOT_CHANGED");
  };
  await current();
  const {payment,rows}=await reserveDailyEntryRows(env,record,entries),sourceWallet=legacySourceWallet(record.paymentKey,record.sourceWallet),writePlan=buildDailySheetWritePlan(env.SHEET_EXPENSE_DAILY,record,payment,sourceWallet,entries,rows);
  // A visually blank candidate can still contain an amount, category, or an
  // input-cell formula outside the columns used by candidateRows(). Do not
  // clear any input cells: require all of them to be blank before writing.
  // Formula-mode reads expose formulas that display as the empty string. This
  // is a fail-closed collision check, not an atomic Sheets compare-and-swap.
  const blank=async()=>{
    const values=await batchGetSheetFormulaValues(env,writePlan.clearRanges);
    if(values.length!==writePlan.clearRanges.length||values.some(range=>!Array.isArray(range)||range.some(row=>!Array.isArray(row)||row.some(value=>value!==null&&value!==undefined&&value!==""))))throw new DailyCancelReviewRequired("DAILY_NEW_ROW_NOT_EMPTY_OR_UNVERIFIED");
  };
  await blank();
  await write(before=>batchWriteValues(env,writePlan.writes,async()=>{await current();await blank();if(before)await before();}));
  return entries.map(entry=>({entityKey:entry.rowKey,row:rows.get(entry.rowKey)!,postingMonth:payment.postingMonth,postingDay:payment.postingDay,amountColumn:payment.amountColumn,sourceWallet}));
}

export async function writeConfirmedExpenseWithDocumentItemsToDaily(env:Env,record:DailyExpenseRecord,document:DailyExpenseDocument|null,items:DailyExpenseDocumentItem[],options:DailyExpenseItemPostingOptions={}):Promise<{plan:DailyExpensePostingPlan;placements:DailyExpensePlacement[];replacedLegacySummary:boolean}>{
  return withCorrectionDailyWriteFence(env,env.SHEET_EXPENSE_DAILY,async (write,fenceToken)=>{
  if(!fenceToken)throw new Error("DAILY_FENCE_TOKEN_MISSING");
  const plan=buildDailyExpenseEntries(record,document,items);
  const existing=await mappedRowsForExpense(env,record.expenseId);
  const hasLegacyItemRows=existing.some(item=>item.entityKey!==record.expenseId);
  // A pre-#119 itemized daily entry is historical.  Never add a second daily
  // cash-outflow row automatically; an explicit bounded reconcile is required.
  if(hasLegacyItemRows&&!options.replaceLegacySummary)return{plan,placements:[],replacedLegacySummary:false};
  if(hasLegacyItemRows&&options.replaceLegacySummary){
    // Historical itemized mappings have no durable row identity. A numeric
    // index is not sufficient authority to clear any row, even under a fence.
    throw new DailyCancelReviewRequired("DAILY_LEGACY_IDENTITY_REVIEW_REQUIRED");
  }
  return{plan,placements:await writeDailyExpenseEntries(env,record,plan.entries,write),replacedLegacySummary:hasLegacyItemRows};
  },undefined,fenceSnapshot(record));
}

export async function writeConfirmedExpenseToDaily(env:Env,record:DailyExpenseRecord):Promise<DailyExpensePlacement>{
  return withCorrectionDailyWriteFence(env,env.SHEET_EXPENSE_DAILY,async (write,fenceToken)=>{
  if(!fenceToken)throw new Error("DAILY_FENCE_TOKEN_MISSING");
  const result=await writeDailyExpenseEntries(env,record,[{rowKey:record.expenseId,description:record.description.trim(),amountBaht:record.amountBaht}],write);
  return result[0]!;
  },undefined,fenceSnapshot(record));
}

export async function clearCancelledExpenseFromDaily(env:Env,expenseId:string):Promise<number[]>{
  return withCorrectionDailyWriteFence(env,env.SHEET_EXPENSE_DAILY,async()=>{
  const mapped=await mappedRowsForExpense(env,expenseId);if(!mapped.length)return[];
  // Even identical date, description, amount and category can belong to two
  // transactions. A numeric index and a value match are not a durable ID.
  // Hold every mapped cancellation until row identity has independent proof.
  throw new DailyCancelReviewRequired("DAILY_CANCEL_IDENTITY_UNVERIFIED");
  });
}
