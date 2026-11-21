import type {MonthlyReady} from './monthly-d1-preview';
import type {ReportGrid} from './monthly-report-baseline';
import {manualReportNativeRowRequests} from './monthly-report-template';

const blank=(v:unknown)=>v===undefined||v===null||v==='';
function canonical(v:unknown):unknown{if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return v;if(Array.isArray(v))return v.map(canonical);if(v&&typeof v==='object'){const out:Record<string,unknown>={};for(const k of Object.keys(v).sort()){const x=(v as Record<string,unknown>)[k];if(x!==undefined)out[k]=canonical(x);}return out;}throw Error('MONTHLY_ROW_PROOF_INVALID');}
const sameJson=(a:unknown,b:unknown)=>JSON.stringify(canonical(a??null))===JSON.stringify(canonical(b??null));
/** Read-only comparison with the intended source and native-row recipe. A
 * matching hash alone is never proof that the projected data is correct. */
export function verifyMonthlyReportRow(grid:ReportGrid,oldRows:number,formatSourceRow:number,row:MonthlyReady,marker:string):boolean{
 try{
  const requests=manualReportNativeRowRequests(grid.structure.sheetId,oldRows,formatSourceRow,row,marker) as Array<{updateCells?:{rows?:Array<{values?:Array<{userEnteredValue?:Record<string,unknown>}>}>}}>;
  if(grid.structure.title!=='รายวันต่อเนื่อง_แบบร่าง'||grid.rows!==oldRows+2||grid.columns<29||grid.columns>100)return false;
  const planned=requests[2]?.updateCells?.rows?.[0]?.values;if(!planned||planned.length!==25)return false;
  const index=oldRows,source=formatSourceRow-1,f=grid.formula[index]??[],e=grid.effective[index]??[],n=grid.notes[index]??[];
  if(n[19]!==marker||!blank(f[19])||!blank(e[19]))return false;
  let occurrences=0;for(const notes of grid.notes)if(Array.isArray(notes))for(const value of notes)if(value===marker)occurrences++;if(occurrences!==1)return false;
  const amountColumn=['F','G','H'].includes(row.amountColumn)?8:17,otherAmount=amountColumn===8?17:8;
  for(let i=0;i<grid.columns;i++){
   const intended=planned[i]?.userEnteredValue,expected=intended?.formulaValue??intended?.numberValue??intended?.stringValue;
   if(expected===undefined?!blank(f[i]):f[i]!==expected)return false;
   if(intended?.formulaValue===undefined&&(expected===undefined?!blank(e[i]):e[i]!==expected))return false;
   if(i!==19&&!blank(n[i]))return false;
   if(i<25&&(!sameJson(grid.formats[index]?.[i],grid.formats[source]?.[i])||!sameJson(grid.validations[index]?.[i],grid.validations[source]?.[i])))return false;
  }
  const serial=(Date.UTC(row.postingYear,row.postingMonth-1,row.postingDay)-Date.UTC(1899,11,30))/86400000;
  if(e[amountColumn]!==row.amountSatang/100||!blank(e[otherAmount])||e[20]!==serial)return false;
  return [9,18].every(i=>blank(e[i])||typeof e[i]==='number'&&Number.isFinite(e[i]));
 }catch{return false;}
}
