import {findMonthBlocks} from './daily-expense';
import {hasExpectedMonthlySubtotal,isAcceptedHelperFormula} from './daily-stable-row-writes';
import {planStableDailyExpenseRow, type StableDailyRowPlan} from './daily-stable-row-plan';

/** Read-only plan. It is not evidence of source provenance, a reservation, or
 * permission to write. The snapshots must be read again under the eventual
 * sheet-wide fence; positions returned here must never be persisted as IDs. */
export function inspectDailyAppendSnapshot(input:{formula:unknown[][];effective:unknown[][];rowCount:number;expenseId:string;year:number;month:number;expectedPrevious?:readonly unknown[]}):StableDailyRowPlan {
 const {formula,effective,rowCount,expenseId,year,month}=input;
 const review=(reason:string):StableDailyRowPlan=>({status:'REVIEW',reason});
 if(!Number.isSafeInteger(rowCount)||rowCount<1||rowCount>5000||!Number.isInteger(year)||year<1900||year>9999||!Number.isInteger(month)||month<1||month>12||!Array.isArray(formula)||!Array.isArray(effective)||formula.length>rowCount||effective.length>rowCount||[...formula,...effective].some(r=>!Array.isArray(r)||r.length>25)||(effective[4]??[])[0]!==year)return review('INCOMPLETE_SNAPSHOT');
 const ids=new Set<string>();
 for(let n=0;n<rowCount;n++){
  const a=formula[n]?.[23],b=effective[n]?.[23],blank=(v:unknown)=>v===null||v===undefined||v==='';
  if(blank(a)&&blank(b))continue;
  if(typeof a!=='string'||a.startsWith('=')||a!==b||ids.has(a))return review('DUPLICATE_OR_INVALID_ID');
  ids.add(a);
 }
 const allBlocks=findMonthBlocks(formula),blocks=allBlocks.filter(b=>b.month===month);if(blocks.length!==1)return review('MONTH_BLOCK_NOT_UNIQUE');
 const {headerRow,totalRow}=blocks[0]!,boundaries=new Set(allBlocks.flatMap(b=>[b.headerRow,b.totalRow]));
 for(let n=1;n<=rowCount;n++){
  if(n>headerRow&&n<totalRow||boundaries.has(n))continue;
  const row=effective[n-1]??[];
  if(Number(row[1])===month&&[4,5,6,7,10,11,12,13,14,15,16].some(i=>row[i]!==null&&row[i]!==undefined&&row[i]!==''&&(typeof row[i]!=='number'||row[i]!==0)))return review('FINANCIAL_ROW_OUTSIDE_MONTH');
 }
 if(!hasExpectedMonthlySubtotal(formula[totalRow-1]??[],headerRow,totalRow))return review('SUBTOTAL_FORMULA_UNVERIFIED');
 const header=effective[headerRow-1]??[],total=effective[totalRow-1]??[],cols=[4,5,6,7,10,11,12,13,14,15,16],sums=Array<number>(25).fill(0);
 if(typeof header[4]!=='number'||!Number.isFinite(header[4])||typeof header[9]!=='number'||Math.abs(header[9]-header[4])>0.001)return review('MONTH_OPENING_UNVERIFIED');
 let prior=header[9];
 for(let n=headerRow+1;n<totalRow;n++){
  const f=formula[n-1]??[],r=effective[n-1]??[];
  const populated=cols.some(i=>r[i]!==null&&r[i]!==undefined&&r[i]!==''&&(typeof r[i]!=='number'||r[i]!==0));
  if(!populated){if(Number(r[1])===month&&typeof r[9]==='number')return review('BLANK_ROW_BALANCE_UNVERIFIED');continue;}
  const day=Number(r[2]),date=new Date(Date.UTC(year,month-1,day));
  if(Number(r[1])!==month||!Number.isInteger(day)||date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day)return review('FINANCIAL_ROW_DATE_UNVERIFIED');
  for(const i of cols){const v=r[i];if(v===null||v===undefined||v==='')continue;if(typeof v!=='number'||!Number.isFinite(v)||v<0||f[i]!==v)return review('FINANCIAL_ROW_VALUE_UNVERIFIED');sums[i]=sums[i]!+v;}
  const out=[5,6,7,10,11,12,13,14,15,16];if(out.filter(i=>Number(r[i]||0)>0).length>1)return review('MULTIPLE_OUTFLOW_CHANNELS');
  for(const [i,name] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']] as const)if(!isAcceptedHelperFormula(headerRow,n,month,name,f[i],formula[n-2]??[]))return review('ROW_HELPER_FORMULA_UNVERIFIED');
  const rowCash=[5,6,7].reduce((v,i)=>v+Number(r[i]||0),0),rowCard=[10,11,12,13,14,15,16].reduce((v,i)=>v+Number(r[i]||0),0),serial=(date.getTime()-Date.UTC(1899,11,30))/86400000;
  if(r[8]!==rowCash||r[17]!==rowCard||typeof r[9]!=='number'||!Number.isFinite(r[9])||Math.abs(r[9]-(prior-rowCash))>0.001||typeof r[18]!=='number'||!Number.isFinite(r[18])||Math.abs(r[18]-(prior-rowCash-rowCard))>0.001||r[20]!==serial)return review('ROW_ACCOUNTING_UNVERIFIED');
  prior=r[9];
 }
 const cash=sums[5]!+sums[6]!+sums[7]!,card=[10,11,12,13,14,15,16].reduce((a,i)=>a+sums[i]!,0),expected:Record<number,number>={8:cash,9:header[4]-cash,17:card,18:header[4]-cash-card};for(const c of cols)expected[c]=sums[c]!;
 if(!Object.entries(expected).every(([i,v])=>typeof total[Number(i)]==='number'&&Number.isFinite(total[Number(i)] as number)&&Math.abs((total[Number(i)] as number)-v)<0.001))return review('SUBTOTAL_VALUE_UNVERIFIED');
 let plan:StableDailyRowPlan;try{plan=planStableDailyExpenseRow(formula,{expenseId,postingMonth:month,allowCreate:!input.expectedPrevious,...input.expectedPrevious?{expectedPrevious:input.expectedPrevious}:{}});}catch{return review('INVALID_EXPENSE_ID');}
 if(plan.status==='APPEND'){
  const candidate=formula[plan.observedRow-1]??[],previous=effective[plan.observedRow-2]??[];
  if(candidate[9]===`=J${plan.observedRow-1}-I${plan.observedRow}`&&(Number(previous[1])!==month||typeof previous[9]!=='number'||!Number.isFinite(previous[9])))return review('PREVIOUS_BALANCE_UNVERIFIED');
 }
 return plan;
}
