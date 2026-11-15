import {atomicDailyRowFormulas,decodeAtomicDailyPayload} from './atomic-daily-template';
import {appendDailyRowFormulas} from './append-daily-template';
import {continuousDailyHelperFormulas} from './continuous-daily-plan';
import {stableDailyExpenseKey} from './daily-stable-row-plan';
import type {VerifiedLegacyCoverage} from './legacy-daily-coverage';

type Snapshot={formula:unknown[][];effective:unknown[][]};
const blank=(v:unknown)=>v===undefined||v===null||v==='';
const same=(a:unknown,b:unknown)=>blank(a)&&blank(b)||a===b;
const money=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&Number.isSafeInteger(Math.round(v*100))&&Math.abs(v*100-Math.round(v*100))<0.0001;
const cents=(v:number)=>Math.round(v*100);
const eq=(v:unknown,n:number)=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v*100-n)<0.001;
const cash=[5,6,7],card=[10,11,12,13,14,15,16],amounts=[...cash,...card];
const columns:Record<string,number>={F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16};

/** Verify actual mixed draft + inserted carrier rows. It does not authorize
 * writes or prove external settlement. Legacy-style manual input is allowed
 * only if its formula and effective running balance match the combined old
 * and new monthly accounting; the original draft J will fail when it omits
 * nonzero legacy spending. */
export function verifyMixedDailyAccounting(snapshot:Snapshot,rowCount:number,columnCount:number,year:number,month:number,legacy:VerifiedLegacyCoverage):boolean{
 if(!legacy||legacy.status!=='VERIFIED'||legacy.year!==year||legacy.month!==month||!Number.isSafeInteger(legacy.legacyDebitSatang)||legacy.legacyDebitSatang<0||legacy.openingSatang!==null&&(!Number.isSafeInteger(legacy.openingSatang)||legacy.openingSatang<0)||!Number.isSafeInteger(rowCount)||rowCount<4||rowCount>5000||!Number.isSafeInteger(columnCount)||columnCount<29||columnCount>100||snapshot.formula.length>rowCount||snapshot.effective.length>rowCount)return false;
 const {formula,effective}=snapshot,openings:number[]=[];
 for(let i=3;i<Math.min(243,rowCount);i++){
  const f=formula[i]??[],e=effective[i]??[];
  if(f[26]===year&&f[27]===month){if(!money(f[28])||!same(e[26],f[26])||!same(e[27],f[27])||!same(e[28],f[28]))return false;openings.push(cents(f[28]));}
 }
 if(openings.length>1||openings.length===0&&legacy.openingSatang===null)return false;
 const opening=openings.length===1?openings[0]!:legacy.openingSatang!;
 let spent=0;const ids=new Set<string>(),dynamic=appendDailyRowFormulas();
 for(let i=3;i<rowCount;i++){
  const f=formula[i]??[],e=effective[i]??[],v=f[24],carrier=decodeAtomicDailyPayload(v),cancelled=typeof v==='string'&&/^MPD1_CANCELLED_[0-9a-f]{64}$/.test(v);
  const literal=atomicDailyRowFormulas(i+1),validCarrierFormula=[dynamic,literal].some(template=>Object.entries(template).every(([c,x])=>f[Number(c)]===x));
  if(f.length>columnCount||e.length>columnCount||i>=243&&[26,27,28].some(c=>!blank(f[c])))return false;
  if(carrier){
   const id=stableDailyExpenseKey(carrier.expenseId),col=columns[carrier.amountColumn];
   if(ids.has(id)||col===undefined||!same(v,e[24])||!same(id,e[23])||!validCarrierFormula||e[0]!==carrier.postingYear||e[1]!==carrier.postingMonth||e[2]!==carrier.postingDay||e[3]!==carrier.description||e[col]!==carrier.amountSatang/100||amounts.some(c=>c!==col&&!blank(e[c]))||e[21]!==carrier.category||e[22]!==carrier.wallet||!blank(e[4]))return false;
   ids.add(id);
  }else if(cancelled){
   if(!same(v,e[24])||!validCarrierFormula||[0,1,2,3,4,...amounts,8,9,17,18,20,21,22,23].some(c=>!blank(e[c])))return false;
   continue;
  }else if(!blank(v)||!blank(e[24])||!blank(f[23])||!blank(e[23]))return false;
  const hasMoney=amounts.some(c=>!blank(e[c])||!blank(f[c])&&typeof f[c]!=='string')||!blank(e[4])||!blank(f[4]);
  if(!hasMoney)continue;
  const y=e[0],m=e[1],d=e[2];if(!Number.isInteger(y)||!Number.isInteger(m)||!Number.isInteger(d))return false;
  const date=new Date(Date.UTC(Number(y),Number(m)-1,Number(d)));if(date.getUTCFullYear()!==y||date.getUTCMonth()+1!==m||date.getUTCDate()!==d)return false;
  if(y!==year||m!==month)continue;
  if(!carrier&&Object.entries(continuousDailyHelperFormulas(i+1)).some(([c,x])=>Number(c)===9?f[9]!==x&&f[9]!==dynamic[9]:f[Number(c)]!==x))return false;
  if((!blank(e[4])&&!money(e[4]))||amounts.some(c=>!blank(e[c])&&!money(e[c])))return false;
  if(!carrier&&[0,1,2,3,4,...amounts,21,22].some(c=>!same(f[c],e[c])))return false;
  const sum=(cols:number[])=>cols.reduce((n,c)=>n+(blank(e[c])?0:cents(e[c] as number)),0),current=sum(cash),credit=sum(card);spent+=current;
  if(!Number.isSafeInteger(spent)||!Number.isSafeInteger(opening-legacy.legacyDebitSatang-spent))return false;
  if(cash.some(c=>!blank(e[c]))?!eq(e[8],current):!blank(e[8]))return false;
  if(card.some(c=>!blank(e[c]))?!eq(e[17],credit):!blank(e[17]))return false;
  if(!eq(e[9],opening-legacy.legacyDebitSatang-spent)||!eq(e[18],opening-legacy.legacyDebitSatang-spent-credit))return false;
  if(e[20]!==Math.floor((date.getTime()-Date.UTC(1899,11,30))/86400000))return false;
 }
 return true;
}
