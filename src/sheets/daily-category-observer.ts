import type {Env} from "../types";
import {sha256Hex} from "../shared/ids";
import {getSheetId,getSheetValues,searchSheetRowMetadata,type SheetRowMetadata} from "./client";
import {resolvePayment} from "./daily-expense";
import {planDailyCategoryScan,type CategoryScanBaseline,type CategoryScanExpense,type CategoryScanRow} from "./daily-category-scan";
import {clearDailyCategoryRejection,refreshDailyCategoryBaselineRow,requestDailyCategoryChange,seedDailyCategoryBaseline} from "./daily-category-repository";

export interface CategoryObserverPorts{
  sheetId:(env:Env,name:string)=>Promise<number>;
  values:(env:Env,range:string)=>Promise<unknown[][]>;
  metadata:(env:Env,key:string)=>Promise<SheetRowMetadata[]>;
}
const defaultPorts:CategoryObserverPorts={sheetId:getSheetId,values:getSheetValues,metadata:searchSheetRowMetadata};
const quote=(name:string)=>`'${name.replace(/'/g,"''")}'`;
function columnIndex(value:string):number{let n=0;if(!/^[A-Z]+$/.test(value))return -1;for(const c of value)n=n*26+c.charCodeAt(0)-64;return n-1;}

export async function collectDailyCategorySnapshot(env:Env,ports:CategoryObserverPorts=defaultPorts):Promise<{sheetId:number;expenses:CategoryScanExpense[];rows:CategoryScanRow[];baselines:Map<string,CategoryScanBaseline>}>{
  const sheet=env.SHEET_EXPENSE_DAILY,[sheetId,values,metadata,records,baselineRows]=await Promise.all([
    ports.sheetId(env,sheet),ports.values(env,`${quote(sheet)}!A:W`),ports.metadata(env,"malipang_expense_daily"),
    env.DB.prepare(`SELECT expense_id,description,amount_satang,transaction_date,payment_key,category,version FROM expense_events WHERE status='CONFIRMED'`).all<Record<string,unknown>>(),
    env.DB.prepare(`SELECT expense_id,row_number,metadata_id,category,expense_version,fingerprint FROM daily_category_baselines`).all<Record<string,unknown>>()
  ]);
  const sheetYear=Number(values[4]?.[0]);if(!Number.isSafeInteger(sheetYear)||sheetYear<2000||sheetYear>9999)throw new Error("CATEGORY_SHEET_YEAR_INVALID");
  const expenses:CategoryScanExpense[]=[];
  for(const e of records.results||[]){
    const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(e.transaction_date||""));if(!match)continue;
    let payment:ReturnType<typeof resolvePayment>;try{payment=resolvePayment(values.slice(0,3),String(e.payment_key||""),Number(match[1]),Number(match[2]),Number(match[3]));}catch{continue;}
    const identity={expenseId:String(e.expense_id||""),postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,description:String(e.description||""),amountSatang:Number(e.amount_satang),amountColumn:columnIndex(payment.amountColumn)};
    const bytes=new TextEncoder().encode(JSON.stringify(identity));
    expenses.push({...identity,category:String(e.category||""),version:Number(e.version),fingerprint:await sha256Hex(bytes.buffer),transactionDate:String(e.transaction_date)});
  }
  const byRow=new Map<number,SheetRowMetadata[]>();for(const m of metadata.filter(m=>m.sheetId===sheetId)){const group=byRow.get(m.rowIndex)||[];group.push(m);byRow.set(m.rowIndex,group);}
  const rows:CategoryScanRow[]=values.map((row,index)=>{const group=byRow.get(index)||[],m=group.length===1?group[0]:undefined;return {rowNumber:index+1,sheetYear,values:row,metadataId:m?.metadataId||null,metadataExpenseId:m?.metadataValue||null};});
  const baselines=new Map<string,CategoryScanBaseline>();for(const b of baselineRows.results||[])baselines.set(String(b.expense_id),{rowNumber:Number(b.row_number),metadataId:Number(b.metadata_id),category:String(b.category),version:Number(b.expense_version),fingerprint:String(b.fingerprint)});
  return {sheetId,expenses,rows,baselines};
}

/** Full-sheet identity matching fails closed on ambiguity; no row number alone is trusted. */
export async function observeDailyCategoryChanges(env:Env,ports:CategoryObserverPorts=defaultPorts):Promise<{baselined:number;requested:number;conflicts:number}>{
  const {expenses,rows,baselines}=await collectDailyCategorySnapshot(env,ports);
  let baselined=0,requested=0,conflicts=0,planned=planDailyCategoryScan(expenses,rows,baselines);
  // An inserted row moves developer metadata with the record. Refresh only
  // after a fresh unique match and only when no owner request is pending.
  for(const entry of planned){
    if(entry.observation.kind!=="CONFLICT"||entry.observation.reason!=="IDENTITY_NOT_VERIFIED")continue;
    const e=expenses.find(x=>x.expenseId===entry.expenseId),r=rows[entry.rowNumber-1],b=baselines.get(entry.expenseId);
    if(!e||!r||!b||r.metadataId!==b.metadataId||r.metadataExpenseId!==e.expenseId||b.fingerprint!==e.fingerprint||b.category!==e.category||b.version!==e.version||String(r.values[21]||"")!==e.category)continue;
    if(await refreshDailyCategoryBaselineRow(env,{expenseId:e.expenseId,rowNumber:r.rowNumber,metadataId:b.metadataId,fingerprint:e.fingerprint,category:e.category,expenseVersion:e.version}))baselines.set(e.expenseId,{...b,rowNumber:r.rowNumber});
  }
  planned=planDailyCategoryScan(expenses,rows,baselines);
  for(const entry of planned){
    const e=expenses.find(x=>x.expenseId===entry.expenseId);if(entry.observation.kind==="CONFLICT")conflicts++;
    if(!e||!entry.metadataId)continue;
    const row={expenseId:e.expenseId,rowNumber:entry.rowNumber,metadataId:entry.metadataId,fingerprint:e.fingerprint,category:e.category,expenseVersion:e.version};
    // A later edit supersedes the old request only after the same row and
    // baseline have been verified. Keep the obsolete request for audit.
    if(entry.observation.kind==="UNCHANGED"||entry.observation.kind==="OWNER_REVIEW"){
      const observed=entry.observation.kind==="UNCHANGED"?e.category:entry.observation.to;
      await env.DB.prepare(`UPDATE daily_category_requests SET status='STALE',updated_at=?
        WHERE expense_id=? AND status='PENDING' AND row_number=? AND metadata_id=?
          AND fingerprint=? AND expense_version=? AND from_category=? AND to_category<>?`)
        .bind(new Date().toISOString(),e.expenseId,entry.rowNumber,entry.metadataId,e.fingerprint,e.version,e.category,observed).run();
    }
    if(entry.observation.kind==="BASELINE"){if(await seedDailyCategoryBaseline(env,row))baselined++;}
    else if(entry.observation.kind==="OWNER_REVIEW"){if(await requestDailyCategoryChange(env,row,entry.observation.to))requested++;}
    else if(entry.observation.kind==="UNCHANGED")await clearDailyCategoryRejection(env,row);
  }
  return {baselined,requested,conflicts};
}
