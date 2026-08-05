import type { Env } from "../types";
import { batchWriteValues } from "./client";
import type { DailyExpenseDocument,DailyExpenseDocumentItem,DailyExpenseRecord } from "./daily-expense";

export interface PurchaseDetailRecord extends DailyExpenseRecord { branchId:string; status:"CONFIRMED"|"CANCELLED"; createdAt:string; updatedAt:string; }
export interface PurchaseDetailDocument extends DailyExpenseDocument { documentDate:string; }
export interface PurchaseDetailEntry { rowKey:string; itemId:string; values:unknown[]; }
const detailSheet=(env:Env)=>env.SHEET_PURCHASE_DETAILS||"รายละเอียดการซื้อ";
const range=(sheet:string,a1:string)=>`'${sheet.replace(/'/g,"''")}'!${a1}`;
const baht=(satang:number|null)=>satang==null?"":Number(satang)/100;
const text=(value:unknown)=>String(value??"").trim();

/** Stable identity used both for the Sheet mapping and idempotent retries. */
export function purchaseDetailRowKey(expenseId:string,itemId:string):string{return `${expenseId}|${itemId}`;}

/**
 * Build an audit-friendly private purchase-detail ledger.  It deliberately
 * does not allocate document-level adjustments to arbitrary line items.  The
 * aggregate adjustment is shown once on the first detail row instead.
 */
export function buildPurchaseDetailEntries(record:PurchaseDetailRecord,document:PurchaseDetailDocument|null,items:DailyExpenseDocumentItem[]):PurchaseDetailEntry[]{
  if(!document||record.status!=="CONFIRMED")return[];
  const valid=items.filter(item=>text(item.itemId)&&item.documentId===document.documentId&&item.expenseId===record.expenseId&&text(item.description));
  const lineTotal=valid.reduce((sum,item)=>sum+(Number.isSafeInteger(item.lineTotalSatang)?Number(item.lineTotalSatang):0),0);
  const adjustment=Math.round(record.amountBaht*100)-lineTotal;
  const vendor=text(document.vendorName)||text(document.legalVendorName)||"Unknown vendor";
  const documentDate=text(document.documentDate)||record.transactionDate;
  return valid.map((item,index)=>({
    rowKey:purchaseDetailRowKey(record.expenseId,item.itemId),itemId:item.itemId,
    values:[
      item.itemId,record.expenseId,document.documentId,documentDate,vendor,text(document.documentNumber)||text(document.orderId),
      text(item.description),item.quantity??"",text(item.unit),baht(item.unitPriceSatang),baht(item.discountSatang),baht(item.lineTotalSatang),
      index===0&&adjustment!==0?baht(adjustment):"",record.amountBaht,record.category,record.branchId,record.status,
      `D1:${document.documentId}`,record.createdAt,record.updatedAt
    ]
  }));
}

async function mappedRow(env:Env,key:string):Promise<number|null>{
  const row=await env.DB.prepare(`SELECT row_number FROM sheet_row_index WHERE sheet_name=? AND entity_key=?`).bind(detailSheet(env),key).first<{row_number:number}>();
  return row?Number(row.row_number):null;
}
async function reserveRow(env:Env,key:string):Promise<number>{
  const existing=await mappedRow(env,key);if(existing)return existing;
  const sheet=detailSheet(env);
  const allocated=await env.DB.prepare(`INSERT INTO sheet_cursors(sheet_name,next_row) VALUES(?,3) ON CONFLICT(sheet_name) DO UPDATE SET next_row=next_row+1 RETURNING next_row-1 AS row_number`).bind(sheet).first<{row_number:number}>();
  const candidate=Number(allocated?.row_number||2);
  await env.DB.prepare(`INSERT OR IGNORE INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)`).bind(sheet,key,candidate).run();
  const final=await mappedRow(env,key);if(!final)throw new Error("Unable to reserve purchase detail row");return final;
}

export async function writeConfirmedExpensePurchaseDetails(env:Env,record:PurchaseDetailRecord,document:PurchaseDetailDocument|null,items:DailyExpenseDocumentItem[]):Promise<number>{
  const entries=buildPurchaseDetailEntries(record,document,items),sheet=detailSheet(env);
  if(!entries.length)return 0;
  const writes=[] as Array<{range:string;values:unknown[][]}>;
  for(const entry of entries){const row=await reserveRow(env,entry.rowKey);writes.push({range:range(sheet,`A${row}:T${row}`),values:[entry.values]});}
  await batchWriteValues(env,writes);return entries.length;
}

/** Keep a cancelled purchase visible and auditable; it no longer counts as an active detail. */
export async function markCancelledExpensePurchaseDetails(env:Env,expenseId:string,now=new Date().toISOString()):Promise<number>{
  const sheet=detailSheet(env),result=await env.DB.prepare(`SELECT row_number FROM sheet_row_index WHERE sheet_name=? AND substr(entity_key,1,length(?)+1)=? || '|' ORDER BY row_number`).bind(sheet,expenseId,expenseId).all<{row_number:number}>();
  const rows=(result.results||[]).map(row=>Number(row.row_number));
  await batchWriteValues(env,rows.flatMap(row=>[
    {range:range(sheet,`Q${row}`),values:[["CANCELLED"]]},
    {range:range(sheet,`T${row}`),values:[[now]]}
  ]));
  return rows.length;
}
