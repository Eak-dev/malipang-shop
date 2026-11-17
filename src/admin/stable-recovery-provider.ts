import type {Env} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSheetGridInfo} from '../sheets/client';
import {columnName} from '../sheets/daily-expense';
import {decodeAtomicDailyPayload} from '../sheets/atomic-daily-template';

/** Provider inspection is diagnostic only. An absent identifier does not
 * prove absence of a legacy/unidentified row, provider settlement, or that a
 * human/legacy writer cannot modify the workbook after this snapshot. */
type Rows=unknown[][];
export type RecoverySheetSnapshot={formula:Rows;effective:Rows;rowCount:number;columnCount:number};
type Counts={oldDaily:number;newDaily:number;raw:number;details:number};
export type RecoveryProviderEvidence={status:'HOLD';reason:string;counts:Counts|null;requires:string[]};
const requirements=['PROVIDER_SETTLEMENT','EXTERNAL_WRITER_FENCE','SOURCE_AND_JOURNAL_RECONCILIATION'];
const hold=(reason:string,counts:Counts|null=null):RecoveryProviderEvidence=>({status:'HOLD',reason,counts,requires:requirements.slice()});

export function inspectRecoverySheetSnapshots(expenseId:string,snapshots:RecoverySheetSnapshot[]):RecoveryProviderEvidence{
 if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(expenseId)||!Array.isArray(snapshots)||snapshots.length!==4)return hold('INVALID_INPUT');
 const valid=snapshots.every((s,i)=>s&&Number.isSafeInteger(s.rowCount)&&s.rowCount>=1&&s.rowCount<=5000&&Number.isSafeInteger(s.columnCount)&&s.columnCount>=(i<2?25:i===2?17:20)&&s.columnCount<=100&&[s.formula,s.effective].every(rows=>Array.isArray(rows)&&rows.length<=s.rowCount&&rows.every(r=>Array.isArray(r)&&r.length<=s.columnCount)));
 if(!valid)return hold('INCOMPLETE_SNAPSHOT');
 const key=`MALIPANG_EXPENSE:${expenseId}`;
 let inconsistent=false;
 function daily(s:RecoverySheetSnapshot):number{
  let count=0;
  for(let i=0;i<s.rowCount;i++){
   const formula=s.formula[i]??[],effective=s.effective[i]??[],carrier=decodeAtomicDailyPayload(formula[24]);
   const fId=formula[23]===key,eId=effective[23]===key,carrierId=carrier?.expenseId===expenseId;
   const malformedCarrier=typeof formula[24]==='string'&&formula[24].includes(key)&&!carrier;
   const has=fId||eId||carrierId||malformedCarrier;
   if(!has)continue;
   count++;
   // In a plain row X is a literal. In the carrier layout X is a formula;
   // it must agree with the independently decoded Y payload and its value.
   if(malformedCarrier||(carrierId?(!eId||effective[24]!==formula[24]):(!fId||!eId)))inconsistent=true;
  }
  return count;
 }
 const oldDaily=daily(snapshots[0]!),newDaily=daily(snapshots[1]!);
 function exact(s:RecoverySheetSnapshot,column:number):number{
  let count=0;
  for(let i=1;i<s.rowCount;i++){
   const f=s.formula[i]?.[column]===expenseId,e=s.effective[i]?.[column]===expenseId;
   if(f||e){count++;if(!f||!e)inconsistent=true;}
  }
  return count;
 }
 const raw=exact(snapshots[2]!,0),details=exact(snapshots[3]!,1),counts={oldDaily,newDaily,raw,details};
 if(inconsistent)return hold('IDENTITY_INCONSISTENT',counts);
 if(oldDaily+newDaily>1||raw>1)return hold('DUPLICATE_IDENTITY',counts);
 return hold('SETTLEMENT_UNPROVEN',counts);
}

/** Four full-grid reads (old/new daily, raw and detail), with immutable grid
 * identity checks. This function does not write or authorize replay. */
export async function inspectRecoveryProvider(env:Env,expenseId:string,oldDailySheet:string,newDailySheet:string):Promise<RecoveryProviderEvidence>{
 if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(expenseId))return hold('INVALID_INPUT');
 const book=env.GOOGLE_SPREADSHEET_ID,db=env.DB,dailyConfig=env.SHEET_EXPENSE_DAILY;
 const names=[oldDailySheet,newDailySheet,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ'];
 if(!book||names.some(n=>typeof n!=='string'||!n.trim()||n.length>100)||new Set(names).size!==4)return hold('INVALID_TARGET');
 try{
  const grids=await Promise.all(names.map(n=>getSheetGridInfo(env,n)));
  if(new Set(grids.map(g=>g.sheetId)).size!==4||grids.some(g=>g.rowCount>5000||g.columnCount>100))return hold('INVALID_GRID');
  const ranges=names.map((name,i)=>`'${name.replace(/'/g,"''")}'!A1:${columnName(grids[i]!.columnCount)}${grids[i]!.rowCount}`);
  const formula=await batchGetSheetFormulaValues(env,ranges),effective=await batchGetSheetEffectiveSerialValues(env,ranges);
  const after=await Promise.all(names.map(n=>getSheetGridInfo(env,n)));
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||dailyConfig!==env.SHEET_EXPENSE_DAILY||names[2]!==env.SHEET_EXPENSE_RAW||names[3]!==(env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ')||JSON.stringify(grids)!==JSON.stringify(after)||formula.length!==4||effective.length!==4)return hold('READ_UNVERIFIED');
  return inspectRecoverySheetSnapshots(expenseId,grids.map((g,i)=>({...g,formula:formula[i]!,effective:effective[i]!})));
 }catch{return hold('READ_UNAVAILABLE');}
}
