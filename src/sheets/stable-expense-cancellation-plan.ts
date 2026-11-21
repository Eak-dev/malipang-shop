/** Read-only cancellation candidate. A plan is never authorization to write:
 * callers must verify the trusted journal/preimage digest, source version,
 * workbook and job leases, provider state and external-writer exclusion. */
export type CancellationProjection='DAILY'|'EXPENSE_RAW'|'DETAIL';
export type CancellationPlan={status:'REVIEW';reason:string}|{status:'UPDATE';observedRow:number;changes:Array<{column:number;value:string|null}>};
type Input={projection:CancellationProjection;expenseId:string;itemId?:string;rows:unknown[][];trustedPreimageDigest?:string;trustedPreimageWidth?:number;cancelledAt:string};
const blank=(value:unknown)=>value===null||value===undefined||value==='';
const scalar=(value:unknown)=>blank(value)||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value);
const canonical=(row:unknown[],width:number)=>Array.from({length:width},(_,i)=>blank(row[i])?null:row[i]);

export async function planStableExpenseCancellation(input:Input):Promise<CancellationPlan>{
 const review=(reason:string):CancellationPlan=>({status:'REVIEW',reason});
 const {projection,expenseId,itemId,rows,trustedPreimageDigest,trustedPreimageWidth,cancelledAt}=input;
 if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(expenseId)||!['DAILY','EXPENSE_RAW','DETAIL'].includes(projection)||projection==='DETAIL'&&!/^[A-Za-z0-9_-]{1,128}$/.test(itemId||'')||!Array.isArray(rows)||rows.length>5000||rows.some(r=>!Array.isArray(r)||r.length>100||r.some(v=>!scalar(v))))return review('INVALID_INPUT');
 if(typeof trustedPreimageDigest!=='string'||!/^[0-9a-f]{64}$/.test(trustedPreimageDigest)||!Number.isSafeInteger(trustedPreimageWidth)||Number(trustedPreimageWidth)>100)return review('MISSING_PREIMAGE');
 const minimum=projection==='DAILY'?25:projection==='EXPENSE_RAW'?17:20;
 if(Number(trustedPreimageWidth)<minimum)return review('INCOMPLETE_PREIMAGE');
 const key=projection==='DAILY'?`MALIPANG_EXPENSE:${expenseId}`:projection==='DETAIL'?itemId!:expenseId,index=projection==='DAILY'?23:0;
 const found=rows.flatMap((row,i)=>row[index]===key?[i]:[]);
 if(found.length!==1)return review(found.length?'DUPLICATE_ID':'MISSING_ID');
 const row=rows[found[0]!]!;
 if(projection==='DETAIL'&&row[1]!==expenseId)return review('EXPENSE_ID_MISMATCH');
 const width=Number(trustedPreimageWidth);
 if(row.slice(width).some(value=>!blank(value)))return review('PREIMAGE_MISMATCH');
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(row,width))))),v=>v.toString(16).padStart(2,'0')).join('');
 if(digest!==trustedPreimageDigest)return review('PREIMAGE_MISMATCH');
 const cols=projection==='DAILY'?[1,2,3,5,6,7,10,11,12,13,14,15,16,21,22]:projection==='EXPENSE_RAW'?[7]:[16,19];
 if(cols.some(i=>typeof row[i]==='string'&&(row[i] as string).startsWith('=')))return review('FORMULA_IN_INPUT');
 // A row with cleared month/day can change running balances in later rows.
 // This planner cannot prove the entire month's accounting without a provider
 // calculation or exclusive writer fence; never authorize that write here.
 if(projection==='DAILY')return review('DAILY_ACCOUNTING_SIMULATION_REQUIRED');
 if(projection==='EXPENSE_RAW'&&row[7]!=='CONFIRMED'||projection==='DETAIL'&&row[16]!=='CONFIRMED')return review('STATUS_UNVERIFIED');
 if(projection==='DETAIL'&&(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cancelledAt)||!Number.isFinite(Date.parse(cancelledAt))||new Date(cancelledAt).toISOString()!==cancelledAt))return review('INVALID_TIME');
 const changes=cols.map(column=>({column,value:projection==='EXPENSE_RAW'?'CANCELLED':column===16?'CANCELLED':cancelledAt}));
 return{status:'UPDATE',observedRow:found[0]!+1,changes};
}
