import {inspectDailyAppendSnapshot} from './daily-append-preflight';
import {findMonthBlocks} from './daily-expense';
import {planStableExpenseCancellation} from './stable-expense-cancellation-plan';

type Snapshot={formula:unknown[][];effective:unknown[][]};
type Input={before:Snapshot;after:Snapshot;expenseId:string;year:number;month:number;rowCount:number;columnCount:number;trustedPreimageDigest:string;trustedPreimageWidth:number};
type Result={status:'VERIFIED';observedRow:number}|{status:'REVIEW';reason:string};
const cleared=new Set([1,2,3,5,6,7,10,11,12,13,14,15,16,21,22]);
const helpers=new Set([8,9,17,18,20]);
const totals=new Set([4,5,6,7,8,9,10,11,12,13,14,15,16,17,18]);
const blank=(v:unknown)=>v===null||v===undefined||v==='';
const equal=(a:unknown,b:unknown)=>blank(a)&&blank(b)||a===b;
const scalar=(v:unknown)=>blank(v)||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v);

/** Verify full snapshots after a DAILY cancellation. This read-only result
 * cannot authorize a write, rule out a later writer, or release a claim. */
export async function verifyDailyCancellationReadback(input:Input):Promise<Result>{
 const review=(reason:string):Result=>({status:'REVIEW',reason});
 const {before,after,expenseId,year,month,rowCount,columnCount,trustedPreimageDigest,trustedPreimageWidth}=input;
 if(!Number.isSafeInteger(rowCount)||rowCount<1||rowCount>5000||!Number.isSafeInteger(columnCount)||columnCount<25||columnCount>100||trustedPreimageWidth!==columnCount)return review('INVALID_GRID');
 for(const snapshot of [before,after]){
  if(!snapshot||!Array.isArray(snapshot.formula)||!Array.isArray(snapshot.effective)||snapshot.formula.length>rowCount||snapshot.effective.length>rowCount||[...snapshot.formula,...snapshot.effective].some(r=>!Array.isArray(r)||r.length>columnCount||r.some(v=>!scalar(v))))return review('INVALID_SNAPSHOT');
 }
 const ids=before.formula.flatMap((row,i)=>row[23]===`MALIPANG_EXPENSE:${expenseId}`?[i]:[]);
 if(ids.length!==1)return review('IDENTITY_UNVERIFIED');
 const target=ids[0]!,row=before.formula[target]??[];
 // The preimage planner verifies the digest and every writable input before
 // deliberately returning REVIEW for DAILY accounting.
 const trusted=await planStableExpenseCancellation({projection:'DAILY',expenseId,rows:before.formula,trustedPreimageDigest,trustedPreimageWidth,cancelledAt:''});
 if(trusted.status!=='REVIEW'||trusted.reason!=='DAILY_ACCOUNTING_SIMULATION_REQUIRED')return review('PREIMAGE_UNVERIFIED');
 if(!blank(row[4]))return review('TARGET_INFLOW_UNVERIFIED');
 const initial=inspectDailyAppendSnapshot({formula:before.formula.map(r=>r.slice(0,25)),effective:before.effective.map(r=>r.slice(0,25)),rowCount,expenseId,year,month,expectedPrevious:Array.from({length:25},(_,i)=>row[i]??null)});
 if(initial.status!=='FOUND'||initial.observedRow!==target+1)return review('BEFORE_ACCOUNTING_UNVERIFIED');
 const blocks=findMonthBlocks(before.formula).filter(b=>b.month===month);
 if(blocks.length!==1)return review('MONTH_UNVERIFIED');
 const {headerRow,totalRow}=blocks[0]!;
 for(let n=0;n<rowCount;n++)for(let col=0;col<columnCount;col++){
  const a=before.formula[n]?.[col],b=after.formula[n]?.[col];
  if(n===target&&cleared.has(col)){if(!blank(b))return review('INPUT_NOT_CLEARED');}
  else if(!equal(a,b))return review('FORMULA_OR_OTHER_INPUT_CHANGED');
  const oldValue=before.effective[n]?.[col],newValue=after.effective[n]?.[col];
  const targetInput=n===target&&cleared.has(col);
  const recalculated=n+1>headerRow&&n+1<totalRow&&helpers.has(col)||n+1===totalRow&&totals.has(col);
  if(targetInput){if(!blank(newValue))return review('EFFECTIVE_INPUT_NOT_CLEARED');}
  else if(!recalculated&&!equal(oldValue,newValue))return review('UNRELATED_VALUE_CHANGED');
 }
 // Run the same complete month accounting check after readback. Use an absent
 // synthetic ID only to avoid treating the retained cancelled ID as a live row.
 let suffix=0,probe='';
 do{probe=`exp_verify_${suffix++}`;}while(after.formula.some(r=>r[23]===`MALIPANG_EXPENSE:${probe}`)&&suffix<=rowCount);
 if(suffix>rowCount+1)return review('IDENTITY_UNVERIFIED');
 const verified=inspectDailyAppendSnapshot({formula:after.formula.map(r=>r.slice(0,25)),effective:after.effective.map(r=>r.slice(0,25)),rowCount,expenseId:probe,year,month});
 if(verified.status!=='APPEND'&&verified.status!=='CAPACITY_REQUIRED')return review('AFTER_ACCOUNTING_UNVERIFIED');
 return {status:'VERIFIED',observedRow:target+1};
}
