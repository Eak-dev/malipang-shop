import {continuousDailyHelperFormulas,planContinuousDailyExpense,type ContinuousDailyInput} from './continuous-daily-plan';

/** Readback validation only. A successful result does not establish that an
 * earlier provider request has settled, reserve a row or authorize a retry. */
export type ContinuousDailyVerificationInput = ContinuousDailyInput & {
 effectiveRows:readonly (readonly unknown[])[];
 postingYear:number;
 postingMonth:number;
};
export type ContinuousDailyVerification = {status:'VERIFIED';row:number}|{status:'REVIEW';reason:string};
const blank=(v:unknown):boolean=>v===null||v===undefined||v==='';
const same=(a:unknown,b:unknown):boolean=>blank(a)&&blank(b)||a===b;
const money=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&Number.isSafeInteger(Math.round(v*100))&&Math.abs(v*100-Math.round(v*100))<0.0001;
const signedMoney=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Number.isSafeInteger(Math.round(v*100))&&Math.abs(v*100-Math.round(v*100))<0.0001;
const satang=(v:number):number=>Math.round(v*100);
const equalSatang=(v:unknown,n:number):boolean=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v*100-n)<0.001;

export function verifyContinuousDailyExpense(input:ContinuousDailyVerificationInput):ContinuousDailyVerification{
 const fail=(reason:string):ContinuousDailyVerification=>({status:'REVIEW',reason});
 if(!input.snapshotComplete||input.effectiveRows.length>input.rowCount||input.effectiveRows.some(row=>!Array.isArray(row)||row.length>input.columnCount))return fail('INCOMPLETE_EFFECTIVE_SNAPSHOT');
 const plan=planContinuousDailyExpense({...input,allowCreate:false});
 if(plan.status!=='FOUND')return fail(plan.status==='REVIEW'?plan.reason:'TARGET_NOT_FOUND');
 if(!Number.isInteger(input.postingYear)||!Number.isInteger(input.postingMonth)||input.postingMonth<1||input.postingMonth>12)return fail('INVALID_POSTING_MONTH');
 const target=input.effectiveRows[plan.observedRow-1]??[];
 if(target[0]!==input.postingYear||target[1]!==input.postingMonth)return fail('POSTING_MONTH_MISMATCH');
 const targetFormula=input.rows[plan.observedRow-1]??[];
 if([0,1,2,3,4,5,6,7,10,11,12,13,14,15,16,21,22,23].some(c=>!same(targetFormula[c],target[c])))return fail('TARGET_EFFECTIVE_MISMATCH');
 const openings:number[]=[];
 for(let i=3;i<Math.min(243,input.rowCount);i++){
  const f=input.rows[i]??[],e=input.effectiveRows[i]??[];
  if(f[26]!==input.postingYear||f[27]!==input.postingMonth)continue;
  if(!signedMoney(f[28])||e[26]!==f[26]||e[27]!==f[27]||e[28]!==f[28])return fail('OPENING_UNVERIFIED');
  openings.push(satang(f[28]));
 }
 if(openings.length!==1)return fail('OPENING_UNVERIFIED');
 const cash=[5,6,7],card=[10,11,12,13,14,15,16],amounts=[...cash,...card];let cashSoFar=0;
 for(let i=3;i<input.rowCount;i++){
  const f=input.rows[i]??[],e=input.effectiveRows[i]??[];
  const hasFinancial=amounts.some(c=>!blank(e[c])||!blank(f[c]))||!blank(e[4])||!blank(f[4]);
  if(!hasFinancial)continue;
  const year=e[0],month=e[1],day=e[2];
  if(!Number.isInteger(year)||!Number.isInteger(month)||!Number.isInteger(day))return fail('ROW_DATE_UNVERIFIED');
  const date=new Date(Date.UTC(Number(year),Number(month)-1,Number(day)));
  if(date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)return fail('ROW_DATE_UNVERIFIED');
  if(year!==input.postingYear||month!==input.postingMonth)continue;
  if((!blank(e[4])&&!money(e[4]))||amounts.some(c=>!blank(e[c])&&!money(e[c])))return fail('ROW_AMOUNT_UNVERIFIED');
  if(Object.entries(continuousDailyHelperFormulas(i+1)).some(([column,formula])=>f[Number(column)]!==formula))return fail('ROW_FORMULA_UNVERIFIED');
  const sum=(columns:number[])=>columns.reduce((total,column)=>total+(blank(e[column])?0:satang(e[column] as number)),0);
  const cashAmount=sum(cash),cardAmount=sum(card);cashSoFar+=cashAmount;
  if(!Number.isSafeInteger(cashSoFar)||!Number.isSafeInteger(openings[0]!-cashSoFar))return fail('ROW_AMOUNT_UNVERIFIED');
  const present=(columns:number[])=>columns.some(column=>!blank(e[column]));
  if(present(cash)?!equalSatang(e[8],cashAmount):!blank(e[8]))return fail('ROW_CASH_TOTAL_UNVERIFIED');
  if(present(card)?!equalSatang(e[17],cardAmount):!blank(e[17]))return fail('ROW_CARD_TOTAL_UNVERIFIED');
  if(!equalSatang(e[9],openings[0]!-cashSoFar)||!equalSatang(e[18],openings[0]!-cashSoFar-cardAmount))return fail('ROW_BALANCE_UNVERIFIED');
  if(e[20]!==Math.floor((date.getTime()-Date.UTC(1899,11,30))/86400000))return fail('ROW_EFFECTIVE_DATE_UNVERIFIED');
 }
 return {status:'VERIFIED',row:plan.observedRow};
}
