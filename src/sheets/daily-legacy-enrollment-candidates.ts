import {buildDailyExpenseEntries,legacySourceWallet,resolvePayment,type DailyExpenseRecord} from './daily-expense';

/** Read-only candidate planning, never identity proof or write authorization.
 * A caller must inventory the complete relevant source and Sheet population,
 * independently investigate each candidate and explicitly approve enrollment.
 * observedRow is an ephemeral display hint only; never persist it. */
export type DailyLegacySource={expenseId:string;transactionDate:string;description:string;amountSatang:number;paymentKey:string;sourceWallet:string;category:string;version:number};
export type DailyLegacyObserved={observedRow:number;blockMonth:number;values:readonly unknown[];unsafe?:boolean};
export type DailyLegacyCandidate={expenseId:string;status:'REVIEW_PAIR'|'HOLD_AMBIGUOUS'|'HOLD_NO_MATCH'|'HOLD_INVALID_SOURCE'|'HOLD_UNSAFE';observedRow?:number};
const amountIndexes=[5,6,7,10,11,12,13,14,15,16] as const;
const norm=(v:unknown)=>typeof v==='string'?v.normalize('NFKC').trim().replace(/\s+/g,' '):'';
const blank=(v:unknown)=>v===null||v===undefined||v==='';
function date(value:string):{year:number;month:number;day:number}|null{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);if(!m)return null;const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),d=new Date(Date.UTC(year,month-1,day));return d.getUTCFullYear()===year&&d.getUTCMonth()+1===month&&d.getUTCDate()===day?{year,month,day}:null;}
function key(parts:unknown[]):string{return JSON.stringify(parts);}
export function dailyLegacyRowKey(row:DailyLegacyObserved):string|null{
 const v=row.values;if(!Number.isSafeInteger(row.observedRow)||row.observedRow<1||!Number.isInteger(row.blockMonth)||row.blockMonth<1||row.blockMonth>12||!Array.isArray(v)||v.length>25||Number(v[1])!==row.blockMonth||!Number.isInteger(Number(v[2]))||Number(v[2])<1||Number(v[2])>31)return null;
 const parts=amountIndexes.map(i=>({i,value:v[i]})).filter(x=>!blank(x.value)&&x.value!==0);if(parts.length!==1)return null;const {i,value}=parts[0]!;if(typeof value!=='number'||!Number.isFinite(value)||value<=0||!Number.isSafeInteger(Math.round(value*100))||Math.abs(value*100-Math.round(value*100))>0.00001||typeof v[3]!=='string'||!norm(v[3])||typeof v[21]!=='string'||!norm(v[21])||typeof v[22]!=='string'||!norm(v[22])||[1,2,3,21,22].some(n=>typeof v[n]==='string'&&String(v[n]).startsWith('=')))return null;
 return key([row.blockMonth,Number(v[2]),norm(v[3]),i,Math.round(value*100),norm(v[21]),norm(v[22])]);
}
function sourceKey(source:DailyLegacySource,headers:unknown[][],sheetYear:number):string|null{
 try{if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(source.expenseId)||!Number.isSafeInteger(source.version)||source.version<1||!Number.isSafeInteger(source.amountSatang)||source.amountSatang<1||typeof source.category!=='string'||!norm(source.category))return null;const d=date(source.transactionDate);if(!d)return null;const payment=resolvePayment(headers,source.paymentKey,d.year,d.month,d.day);if(payment.postingYear!==sheetYear)return null;const indexes:Record<string,number>={F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16},column=indexes[payment.amountColumn];if(column===undefined)return null;const record:DailyExpenseRecord={...source,amountBaht:source.amountSatang/100},description=buildDailyExpenseEntries(record,null,[]).entries[0]!.description;return key([payment.postingMonth,payment.postingDay,norm(description),column,source.amountSatang,norm(source.category),norm(legacySourceWallet(source.paymentKey,source.sourceWallet))]);}catch{return null;}
}
export function planDailyLegacyCandidates(records:readonly DailyLegacySource[],observed:readonly DailyLegacyObserved[],headers:unknown[][],sheetYear:number):DailyLegacyCandidate[]{
 if(!Array.isArray(records)||records.length>10000||!Array.isArray(observed)||observed.length>5000||!Number.isSafeInteger(sheetYear)||sheetYear<1900||sheetYear>9999)throw Error('DAILY_LEGACY_INVENTORY_INVALID');const rowIds=new Set<number>();for(const row of observed){if(!Number.isSafeInteger(row.observedRow)||rowIds.has(row.observedRow))throw Error('DAILY_LEGACY_INVENTORY_INVALID');rowIds.add(row.observedRow);}
 const sources=new Map<string,number>(),ids=new Map<string,number>(),rows=new Map<string,DailyLegacyObserved[]>();for(const r of records){ids.set(r.expenseId,(ids.get(r.expenseId)??0)+1);const k=sourceKey(r,headers,sheetYear);if(k)sources.set(k,(sources.get(k)??0)+1);}for(const r of observed){const k=dailyLegacyRowKey(r);if(k){const group=rows.get(k)??[];group.push(r);rows.set(k,group);}}
 return records.map(r=>{const k=sourceKey(r,headers,sheetYear);if(!k)return{expenseId:r.expenseId,status:'HOLD_INVALID_SOURCE'};const matches=rows.get(k)??[];if((ids.get(r.expenseId)??0)!==1||(sources.get(k)??0)!==1||matches.length>1)return{expenseId:r.expenseId,status:'HOLD_AMBIGUOUS'};if(matches.length===0)return{expenseId:r.expenseId,status:'HOLD_NO_MATCH'};if(matches[0]!.unsafe||!blank(matches[0]!.values[23]))return{expenseId:r.expenseId,status:'HOLD_UNSAFE'};return{expenseId:r.expenseId,status:'REVIEW_PAIR',observedRow:matches[0]!.observedRow};});
}
