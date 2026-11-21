import {expenseCategories,paymentOptionForPair} from '../expense/document';
import {legacySourceWallet} from './daily-expense';
import {verifiedInsertDailyPayment} from './insert-daily-writer';

/** Pure, read-only preflight. No result grants permission to write Sheets. */
export type MonthlyExpenseRow={expense_id:unknown;version:unknown;status:unknown;transaction_date:unknown;description:unknown;amount_satang:unknown;payment_key:unknown;source_wallet:unknown;category:unknown};
export type MonthlyReady={expenseId:string;sourceVersion:number;transactionDate:string;postingYear:number;postingMonth:number;postingDay:number;description:string;amountSatang:number;amountColumn:string;category:string;wallet:string};
export type MonthlyHold={expenseId:string|null;reason:'DATE_UNVERIFIED'|'IDENTITY_UNVERIFIED'|'SOURCE_INCOMPLETE'|'SOURCE_DUPLICATE'|'PAYMENT_UNVERIFIED'};
export type MonthlyPreview={period:string;ready:MonthlyReady[];held:MonthlyHold[];outsidePeriod:number};

export function bangkokMonth(now:Date):string{
 if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw Error('MONTHLY_PREVIEW_TIME_INVALID');
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit'}).formatToParts(now);
 const year=parts.find(p=>p.type==='year')?.value,month=parts.find(p=>p.type==='month')?.value;
 if(!year||!/^\d{4}$/.test(year)||!month||!/^\d{2}$/.test(month))throw Error('MONTHLY_PREVIEW_TIME_INVALID');
 return `${year}-${month}`;
}
function parsedDate(value:unknown):{year:number;month:number;day:number}|null{
 if(typeof value!=='string')return null;const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);if(!m)return null;
 const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),d=new Date(Date.UTC(year,month-1,day));
 return year>=1900&&year<=9999&&d.getUTCFullYear()===year&&d.getUTCMonth()===month-1&&d.getUTCDate()===day?{year,month,day}:null;
}
const nonempty=(x:unknown):x is string=>typeof x==='string'&&x.trim().length>0&&x.length<=1000;

/** Caller supplies private D1 rows and the actual verified sheet headers.
 * Never log or expose these rows through an endpoint without an explicit
 * privacy review. Includes held reasons so one bad row doesn't hide others. */
export function planMonthlyD1Preview(rows:readonly MonthlyExpenseRow[],headers:unknown[][],now:Date):MonthlyPreview{
 const period=bangkokMonth(now),ready:MonthlyReady[]=[],held:MonthlyHold[]=[];let outsidePeriod=0;
 const identities=new Map<string,number>();for(const row of rows)if(row.status==='CONFIRMED'&&typeof row.expense_id==='string')identities.set(row.expense_id,(identities.get(row.expense_id)??0)+1);
 for(const row of rows){
  if(row.status!=='CONFIRMED')continue;
  const expenseId=typeof row.expense_id==='string'&&/^exp_[A-Za-z0-9_-]{1,128}$/.test(row.expense_id)?row.expense_id:null,date=parsedDate(row.transaction_date);
  if(!date){held.push({expenseId,reason:'DATE_UNVERIFIED'});continue;}
  if(`${date.year}-${String(date.month).padStart(2,'0')}`!==period){outsidePeriod++;continue;}
  if(!expenseId){held.push({expenseId:null,reason:'IDENTITY_UNVERIFIED'});continue;}
  if(identities.get(expenseId)!==1){held.push({expenseId,reason:'SOURCE_DUPLICATE'});continue;}
  if(!nonempty(row.description)||!nonempty(row.category)||!expenseCategories.has(row.category)||!nonempty(row.payment_key)||!nonempty(row.source_wallet)||!Number.isSafeInteger(row.version)||Number(row.version)<1||!Number.isSafeInteger(row.amount_satang)||Number(row.amount_satang)<=0){held.push({expenseId,reason:'SOURCE_INCOMPLETE'});continue;}
  if(!paymentOptionForPair(row.payment_key,row.source_wallet)){held.push({expenseId,reason:'PAYMENT_UNVERIFIED'});continue;}
  try{
   const payment=verifiedInsertDailyPayment(headers,row.payment_key,date.year,date.month,date.day);
   ready.push({expenseId,sourceVersion:Number(row.version),transactionDate:row.transaction_date as string,postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,description:row.description.trim(),amountSatang:Number(row.amount_satang),amountColumn:payment.amountColumn,category:row.category.trim(),wallet:legacySourceWallet(row.payment_key,row.source_wallet)});
  }catch{held.push({expenseId,reason:'PAYMENT_UNVERIFIED'});}
 }
 return {period,ready,held,outsidePeriod};
}
