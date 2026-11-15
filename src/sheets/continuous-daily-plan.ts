import {legacySourceWallet,resolvePayment} from './daily-expense';
import {stableDailyExpenseKey} from './daily-stable-row-plan';
import {paymentOptionForPair} from '../expense/document';

/** Planning only. A row number is an observation, not a reservation, proof of
 * no prior provider write, or permission to write. Callers must fence external
 * writers, prove an unknown request has settled, journal intent and read back. */
export type ContinuousDailyPlan =
 | {status:'REVIEW';reason:string}
 | {status:'FOUND';observedRow:number;requiresBalanceVerification:true}
 | {status:'APPEND';observedRow:number;changes:Array<{column:number;userEnteredValue:{numberValue:number}|{stringValue:string}}>;requiresBalanceVerification:true}
 | {status:'CAPACITY_REQUIRED'};
export type ContinuousDailyInput = {
  /** Complete FORMULA-rendered grid through columnCount and rowCount. */
  rows:readonly (readonly unknown[])[]; rowCount:number; columnCount:number; firstDataRow:number; snapshotComplete:boolean;
  expenseId:string; transactionDate:string; description:string; amountSatang:number; paymentKey:string; sourceWallet:string; category:string;
  /** Supplied only after independently proving this entity has never been projected. */
  allowCreate:boolean;
  /** Trusted whole-row preimage, required even when the stable ID is present.
   * The separate budget panel in AA:AC is verified as accounting input by
   * the caller; it is not part of the expense's row identity. */
  expectedPrevious?:readonly unknown[];
};
const blank=(x:unknown):boolean=>x===null||x===undefined||x==='';
const scalar=(x:unknown):boolean=>blank(x)||typeof x==='string'||typeof x==='boolean'||typeof x==='number'&&Number.isFinite(x);
const same=(x:unknown,y:unknown):boolean=>blank(x)&&blank(y)||x===y;
const norm=(x:unknown):string=>String(x??'').trim().toLowerCase().replace(/[\s_\-/]+/g,'');
const helperIndexes=new Set([8,9,17,18,20]); // I J R S U
// AA:AC hold year/month/opening budget, not transaction-row content. Column Z
// is a spacer and remains part of occupancy/preimage checks.
const budgetIndexes=new Set([26,27,28]);
const amountColumns:Record<string,number>={F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16};
const amountIndexes=Object.values(amountColumns);

export function continuousDailyDateFormula(row:number):string{
 if(!Number.isSafeInteger(row)||row<1)throw Error('INVALID_CONTINUOUS_DAILY_ROW');
 return `=IF(AND(ISNUMBER(A${row}),ISNUMBER(B${row}),ISNUMBER(C${row}),A${row}>=1900,A${row}<=9999,B${row}>=1,B${row}<=12,C${row}>=1,C${row}<=31),IF(AND(YEAR(DATE(A${row},B${row},C${row}))=A${row},MONTH(DATE(A${row},B${row},C${row}))=B${row},DAY(DATE(A${row},B${row},C${row}))=C${row}),DATE(A${row},B${row},C${row}),""),"")`;
}

/** Exact helper contract of the preformatted continuous daily template. A
 * mismatch must be reviewed, even if its effective value happens to match. */
export function continuousDailyHelperFormulas(row:number):Record<number,string>{
 if(!Number.isSafeInteger(row)||row<4)throw Error('INVALID_CONTINUOUS_DAILY_ROW');
 return {
  8:`=IF(COUNTA(F${row}:H${row})=0,"",SUM(F${row}:H${row}))`,
  9:`=IF(U${row}="","",IF(OR(COUNTIFS($AA$4:$AA$243,A${row},$AB$4:$AB$243,B${row})<>1,SUMPRODUCT(--($AA$4:$AA$243=A${row}),--($AB$4:$AB$243=B${row}),--ISNUMBER($AC$4:$AC$243))<>1),"",SUMIFS($AC$4:$AC$243,$AA$4:$AA$243,A${row},$AB$4:$AB$243,B${row})-SUMIFS($I$4:I${row},$A$4:A${row},A${row},$B$4:B${row},B${row})))`,
  17:`=IF(COUNTA(K${row}:Q${row})=0,"",SUM(K${row}:Q${row}))`,
  18:`=IF(J${row}="","",J${row}-R${row})`,
  20:continuousDailyDateFormula(row)
 };
}

/** Reject ambiguous/missing payment headers rather than silently using the
 * fallback position in resolvePayment. Credit cutoff rules remain identical. */
function paymentHeaderIsUnique(headers:readonly (readonly unknown[])[],key:string,column:string):boolean{
 const k=norm(key),aliases:Record<string,string[]>={cash:['non-fixed','non fixed'],transfer:['เงินโอน'],kbank:['Kbank'],firstchoice:['First Choice'],aeon:['Aeon'],citibank:['Cibit Bank','Citibank','Citi'],ttb:['Thanachart','TTB'],homepro:['Homepro'],t1:['The One','The 1']};
 const names=aliases[k];if(!names)return false;
 // The existing sheet puts the transfer label on row 2; the new continuous
 // template puts it on row 3. Both must name the same unique physical column.
 const candidateRows=k==='transfer'?[headers[1]??[],headers[2]??[]]:[headers[2]??[]],targets=names.map(norm);
 const indexes=new Set(candidateRows.flatMap(row=>row.flatMap((v,i)=>{const label=norm(v);return label&&targets.some(t=>label===t||label.includes(t))?[i]:[];})));
 return indexes.size===1&&indexes.has(amountColumns[column]!);
}

export function planContinuousDailyExpense(input:ContinuousDailyInput):ContinuousDailyPlan{
 const review=(reason:string):ContinuousDailyPlan=>({status:'REVIEW',reason});
 const {rows,rowCount,columnCount,firstDataRow}=input;
 if(!input.snapshotComplete||!Array.isArray(rows)||!Number.isSafeInteger(rowCount)||rowCount<1||rowCount>5000||!Number.isSafeInteger(columnCount)||columnCount<29||columnCount>100||firstDataRow!==4||firstDataRow>rowCount||rows.length>rowCount||rows.some(row=>!Array.isArray(row)||row.length>columnCount||row.some(v=>!scalar(v))))return review('INCOMPLETE_SNAPSHOT');
 let key:string;try{key=stableDailyExpenseKey(input.expenseId);}catch{return review('INVALID_EXPENSE_ID');}
 const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(input.transactionDate);
 if(!m)return review('INVALID_TRANSACTION_DATE');
 const year=Number(m[1]),month=Number(m[2]),day=Number(m[3]),date=new Date(Date.UTC(year,month-1,day));
 if(year<1900||year>9999||date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)return review('INVALID_TRANSACTION_DATE');
 if(!Number.isSafeInteger(input.amountSatang)||input.amountSatang<=0||!input.description.trim()||!input.category.trim()||!paymentOptionForPair(input.paymentKey,input.sourceWallet))return review('INVALID_EXPENSE');
 let payment:ReturnType<typeof resolvePayment>;
 try{payment=resolvePayment(rows.slice(0,3).map(r=>Array.from(r)),input.paymentKey,year,month,day);}catch{return review('PAYMENT_UNVERIFIED');}
 if(!paymentHeaderIsUnique(rows,input.paymentKey,payment.amountColumn)||amountColumns[payment.amountColumn]===undefined)return review('PAYMENT_UNVERIFIED');
 const posting=new Date(Date.UTC(payment.postingYear,payment.postingMonth-1,payment.postingDay));
 if(!Number.isSafeInteger(payment.postingYear)||payment.postingYear<1900||payment.postingYear>9999||!Number.isInteger(payment.postingMonth)||!Number.isInteger(payment.postingDay)||posting.getUTCFullYear()!==payment.postingYear||posting.getUTCMonth()+1!==payment.postingMonth||posting.getUTCDate()!==payment.postingDay)return review('INVALID_POSTING_DATE');
 for(let index=0;index<firstDataRow-1;index++)if(typeof rows[index]?.[23]==='string'&&String(rows[index]![23]).startsWith('MALIPANG_EXPENSE:'))return review('IDENTITY_OUTSIDE_DATA');
 const stableIds=new Set<string>();let found=-1,lastUsed=firstDataRow-1;
 for(let index=firstDataRow-1;index<rowCount;index++){
  const row=rows[index]??[],id=row[23];
  // Only AA4:AC243 are part of the explicitly bounded budget panel. Values
  // below it could be independent owner data, so never silently disregard it.
  if(index>=243&&[26,27,28].some(col=>!blank(row[col])))return review('BUDGET_PANEL_OUTSIDE_RANGE');
  if(!blank(id)){
   if(typeof id!=='string'||!/^MALIPANG_EXPENSE:exp_[A-Za-z0-9_-]{1,128}$/.test(id))return review('INVALID_STABLE_ID');
   if(stableIds.has(id))return review('DUPLICATE_STABLE_ID');
   stableIds.add(id);if(id===key)found=index;
  }
  if(Array.from({length:columnCount},(_,col)=>col).some(col=>!budgetIndexes.has(col)&&!helperIndexes.has(col)&&!blank(row[col])))lastUsed=index+1;
 }
 const checkSource=(row:readonly unknown[],rowNumber:number):boolean=>{
  const col=amountColumns[payment.amountColumn]!;
  return row[0]===payment.postingYear&&row[1]===payment.postingMonth&&row[2]===payment.postingDay&&row[3]===input.description.trim()&&row[col]===input.amountSatang/100&&amountIndexes.every(i=>i===col||blank(row[i]))&&row[21]===input.category.trim()&&row[22]===legacySourceWallet(input.paymentKey,input.sourceWallet)&&row[23]===key&&Object.entries(continuousDailyHelperFormulas(rowNumber)).every(([i,formula])=>row[Number(i)]===formula);
 };
 if(found>=0){
  const observed=rows[found]??[],expected=input.expectedPrevious;
  if(!expected||expected.length!==columnCount||expected.some(v=>!scalar(v)))return review('MISSING_TRUSTED_PREIMAGE');
  if(Array.from({length:columnCount},(_,i)=>i).some(i=>!budgetIndexes.has(i)&&!same(observed[i],expected[i]))||!checkSource(observed,found+1))return review('IDENTITY_PREIMAGE_MISMATCH');
  return{status:'FOUND',observedRow:found+1,requiresBalanceVerification:true};
 }
 if(!input.allowCreate)return review('NO_PRIOR_WRITE_UNVERIFIED');
 const next=lastUsed+1;if(next>rowCount)return{status:'CAPACITY_REQUIRED'};
 const row=rows[next-1]??[];
 if(Array.from({length:columnCount},(_,col)=>col).some(col=>!budgetIndexes.has(col)&&!helperIndexes.has(col)&&!blank(row[col])))return review('APPEND_ROW_NOT_EMPTY');
 // Every helper must be present and identical to the verified template. They
 // are never written here; formula/value readback remains required later.
 if(!Object.entries(continuousDailyHelperFormulas(next)).every(([col,formula])=>row[Number(col)]===formula))return review('HELPER_FORMULA_UNVERIFIED');
 // Use Sheets ExtendedValue's explicit types. In particular, even a merchant
 // name beginning with '=' is a literal stringValue, never USER_ENTERED.
 const changes:Array<{column:number;userEnteredValue:{numberValue:number}|{stringValue:string}}>=[
  {column:0,userEnteredValue:{numberValue:payment.postingYear}},{column:1,userEnteredValue:{numberValue:payment.postingMonth}},{column:2,userEnteredValue:{numberValue:payment.postingDay}},{column:3,userEnteredValue:{stringValue:input.description.trim()}},
  {column:amountColumns[payment.amountColumn]!,userEnteredValue:{numberValue:input.amountSatang/100}},{column:21,userEnteredValue:{stringValue:input.category.trim()}},{column:22,userEnteredValue:{stringValue:legacySourceWallet(input.paymentKey,input.sourceWallet)}},{column:23,userEnteredValue:{stringValue:key}}
 ];
 return{status:'APPEND',observedRow:next,changes,requiresBalanceVerification:true};
}
