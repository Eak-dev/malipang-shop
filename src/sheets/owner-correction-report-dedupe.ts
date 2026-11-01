import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {isIsoDate} from "../shared/time";

const exceptionalExpense="exp_730b2534-981b-4730-885e-a00995ef36ed";
const clean=(value:unknown)=>String(value??"").trim().replace(/ +/g," ").toUpperCase();
function date(value:unknown):string|null{
  if(typeof value==="string")return isIsoDate(value)?value:null;
  if(typeof value!=="number"||!Number.isFinite(value))return null;
  const days=Math.floor(value);if(days<1||days>100000)return null;
  const result=new Date(Date.UTC(1899,11,30)+days*86400000).toISOString().slice(0,10);
  return isIsoDate(result)?result:null;
}
function satang(value:unknown):number|null{
  if(typeof value!=="number"||!Number.isFinite(value)||value<=0)return null;
  const n=Math.round(value*100);return Number.isSafeInteger(n)&&Math.abs(value*100-n)<0.000001?n:null;
}
function key(id:string,day:string,amount:number,doc:string,order:string):string{
  const identity=id===exceptionalExpense?`EXP|${id}`:order?`ORD|${order}|${(amount/100).toFixed(2)}`:doc?`DOC|${doc}|${(amount/100).toFixed(2)}`:`EXP|${id}`;
  return `${day.slice(0,7)}|${identity}`;
}

/** Mirror the modern 97_EXPENSE_CLEAN deduplication key, and refuse ambiguous changes.
 * rows must be the complete current V52_EXPENSE_RAW, not a partial range. */
export function correctionReportDeduplicationSafe(before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot,rows:unknown[][]):boolean{
  if(before.expenseId!==after.expenseId||before.status!=="CONFIRMED"||after.status!=="CONFIRMED"||!isIsoDate(before.transactionDate)||!isIsoDate(after.transactionDate)||before.transactionDate<"2026-08-01"||after.transactionDate<"2026-08-01"||!Number.isSafeInteger(before.amountSatang)||before.amountSatang<=0||!Number.isSafeInteger(after.amountSatang)||after.amountSatang<=0)return false;
  const seen=new Map<string,number>(),source:unknown[][]=[];
  for(const row of rows){
    if(row[7]!=="CONFIRMED")continue;
    const id=typeof row[0]==="string"?row[0]:"",day=date(row[1]),amount=satang(row[3]);
    if(!id||!day||amount===null)return false;
    if(id===before.expenseId)source.push(row);
    if(day<"2026-08-01")continue;
    const k=key(id,day,amount,clean(row[15]),clean(row[16]));seen.set(k,(seen.get(k)||0)+1);
  }
  if(source.length!==1)return false;
  const row=source[0]!,day=date(row[1]),amount=satang(row[3]);
  if(day!==before.transactionDate||amount!==before.amountSatang)return false;
  const oldKey=key(before.expenseId,day,amount,clean(row[15]),clean(row[16])),newKey=key(after.expenseId,after.transactionDate,after.amountSatang,clean(row[15]),clean(row[16]));
  return seen.get(oldKey)===1&&(newKey===oldKey||(seen.get(newKey)||0)===0);
}
