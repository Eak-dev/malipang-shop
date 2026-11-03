import {findMonthBlocks} from './daily-expense';
import {hasExpectedMonthlySubtotal,isAcceptedHelperFormula} from './daily-stable-row-writes';

/** A fresh, full formula and effective-value snapshot is required. This checks
 * one already-enrolled row and the surrounding month; it never addresses a
 * Sheet write or authorizes a recovery by itself. */
export function verifyDailyRecoveryAccounting(formula:unknown[][],effective:unknown[][],row:number,month:number,year:number,day:number):boolean{
 if(!Number.isSafeInteger(row)||row<1||!Number.isSafeInteger(month)||month<1||month>12||!Number.isSafeInteger(year)||year<1900||year>9999||!Number.isSafeInteger(day)||day<1||day>31||!Array.isArray(formula)||!Array.isArray(effective))return false;
 const date=new Date(Date.UTC(year,month-1,day));if(date.getUTCFullYear()!==year||date.getUTCMonth()+1!==month||date.getUTCDate()!==day||(effective[4]??[])[0]!==year)return false;
 const blocks=findMonthBlocks(formula).filter(b=>b.month===month);if(blocks.length!==1)return false;const {headerRow,totalRow}=blocks[0]!;if(row<=headerRow||row>=totalRow||!hasExpectedMonthlySubtotal(formula[totalRow-1]??[],headerRow,totalRow))return false;
 const target=formula[row-1]??[],previous=formula[row-2]??[],shown=effective[row-1]??[],header=effective[headerRow-1]??[],total=effective[totalRow-1]??[];
 if(Number(target[1])!==month||Number(target[2])!==day||typeof header[4]!=='number'||!Number.isFinite(header[4])||typeof header[9]!=='number'||Math.abs(header[9]-header[4])>0.001)return false;
 for(const [i,name] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']] as const)if(!isAcceptedHelperFormula(headerRow,row,month,name,target[i],previous))return false;
 const cols=[4,5,6,7,10,11,12,13,14,15,16],sums=Array<number>(25).fill(0);
 for(let n=headerRow+1;n<totalRow;n++){const item=effective[n-1]??[],hasFinancial=[5,6,7,10,11,12,13,14,15,16].some(i=>item[i]!==undefined&&item[i]!==null&&item[i]!==''&&(typeof item[i]!=='number'||item[i]!==0));if(hasFinancial){const itemDay=Number(item[2]),d=new Date(Date.UTC(year,month-1,itemDay));if(Number(item[1])!==month||!Number.isInteger(itemDay)||d.getUTCFullYear()!==year||d.getUTCMonth()+1!==month||d.getUTCDate()!==itemDay)return false;}if(Number(item[1])!==month)continue;for(const col of cols){const v=item[col];if(v===undefined||v===null||v==='')continue;if(typeof v!=='number'||!Number.isFinite(v))return false;sums[col]=sums[col]!+v;}}
 const cash=sums[5]!+sums[6]!+sums[7]!,card=[10,11,12,13,14,15,16].reduce((n,i)=>n+sums[i]!,0),expected:Record<number,number>={8:cash,9:header[4]-cash,17:card,18:header[4]-cash-card};for(const col of cols)expected[col]=sums[col]!;
 if(!Object.entries(expected).every(([col,v])=>typeof total[Number(col)]==='number'&&Number.isFinite(total[Number(col)] as number)&&Math.abs((total[Number(col)] as number)-v)<0.001))return false;
 let prior:number|undefined;for(let n=row-1;n>=headerRow;n--){const item=effective[n-1]??[],balance=item[9];if(Number(item[1])===month&&typeof balance==='number'&&Number.isFinite(balance)){prior=balance;break;}}if(prior===undefined)return false;
 if(target[9]===`=J${row-1}-I${row}`&&typeof (effective[row-2]??[])[9]!=='number')return false;
 const rowCash=[5,6,7].reduce((n,i)=>n+Number(target[i]||0),0),rowCard=[10,11,12,13,14,15,16].reduce((n,i)=>n+Number(target[i]||0),0),serial=(date.getTime()-Date.UTC(1899,11,30))/86400000;
 return Number.isFinite(rowCash)&&Number.isFinite(rowCard)&&shown[8]===rowCash&&shown[17]===rowCard&&typeof shown[9]==='number'&&Number.isFinite(shown[9])&&Math.abs(shown[9]-(prior-rowCash))<0.001&&typeof shown[18]==='number'&&Number.isFinite(shown[18])&&Math.abs(shown[18]-(prior-rowCash-rowCard))<0.001&&shown[20]===serial;
}
