import type {Env,SheetsSyncJob} from '../types';
import type {ContinuousSheetsReadPolicy} from './client';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,getSheetCellNumberFormats,getSheetGridInfo} from './client';
import {columnName,legacySourceWallet} from './daily-expense';
import {encodeAtomicDailyPayload} from './atomic-daily-template';
import {matchesCommittedDailyInsert} from './continuous-daily-write-evidence';
import {matchesPinnedHistoricalDailyReadback,type HistoricalDailyReceipt} from './exact-daily-historical-receipt';
import {type StableExpenseSource} from './stable-expense-source';
import {planStableExpenseProjections} from './stable-expense-projection-plan';
import {readVerifiedLegacyDailyIds,verifiedInsertDailyPayment} from './insert-daily-writer';
import {readLegacyDailyCoverage} from './legacy-daily-coverage';
import {verifyMixedDailyAccounting} from './mixed-daily-accounting';
import {verifyDailyCarrierEvidence} from './daily-carrier-auth';
import {readContinuousReportHealth} from './continuous-report-health';
import {paymentOptionForPair} from '../expense/document';

type Evidence={sheet_id:number;sheet_name:string;source_version:number;source_digest:string;operation_token:string;marker:string;target_row:number;before_rows:number;before_columns:number;before_digest:string;payload_digest:string;notice_stamp:string;notice_identity:string;projection_state:string};
type HistoricalDailyReadback=Readonly<{fingerprint:string;receipt:HistoricalDailyReceipt}>;
/** Read-only formula/effective and scoped target-format proof, not full CellData.
 * Notes, validation, protection and comment anchors are outside this proof.
 * Caller authenticates source and notice; success never grants mutation authority. */
export async function proveDailyProviderPostimage(env:Env,job:SheetsSyncJob,operationToken:string,row:Evidence,source:StableExpenseSource,target:{sheet:string;sheetId:number},policy:ContinuousSheetsReadPolicy,stable:()=>boolean,readSource:()=>Promise<StableExpenseSource|null>,verifyNotice:()=>Promise<boolean>,allowExtraBlankTail:boolean,mark:(stage:string)=>void,repeatFormatAndReports=false,historical?:HistoricalDailyReadback):Promise<{snapshot:{formula:unknown[][];effective:unknown[][]}}|null>{
 const book=env.GOOGLE_SPREADSHEET_ID,db=env.DB,pin=env.EXACT_DAILY_HISTORICAL_RECEIPT_SHA256;
 const sameScope=historical?()=>stable()&&env.GOOGLE_SPREADSHEET_ID===book&&env.DB===db&&env.EXACT_DAILY_HISTORICAL_RECEIPT_SHA256===pin:stable;
 if(historical&&(!pin||!allowExtraBlankTail||
  row.source_version!==job.entityVersion||row.source_digest!==source.digest||row.operation_token!==operationToken||
  row.sheet_id!==target.sheetId||row.sheet_name!==target.sheet||!sameScope()))return null;
 const record=planStableExpenseProjections(source).record,date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(record.transactionDate);if(!date||!paymentOptionForPair(record.paymentKey,record.sourceWallet))return null;
 mark('GRID');const grid=await getSheetGridInfo(env,target.sheet,policy),coords={sheetId:row.sheet_id,row:row.target_row,rowCount:row.before_rows,columnCount:row.before_columns};
 if(grid.sheetId!==row.sheet_id||grid.columnCount!==row.before_columns||grid.rowCount!==row.before_rows+(allowExtraBlankTail?2:1)||!sameScope())return null;
 const range=`'${target.sheet.replace(/'/g,"''")}'!A1:${columnName(grid.columnCount)}${grid.rowCount}`;
 const take=async()=>{const a=await getSheetGridInfo(env,target.sheet,policy),f=await batchGetSheetFormulaValues(env,[range],policy),e=await batchGetSheetEffectiveSerialValues(env,[range],policy),b=await getSheetGridInfo(env,target.sheet,policy);if(!sameScope()||JSON.stringify(a)!==JSON.stringify(grid)||JSON.stringify(b)!==JSON.stringify(grid)||f.length!==1||e.length!==1||f[0]!.length>grid.rowCount||e[0]!.length>grid.rowCount)throw Error('DAILY_POSITIVE_READ_UNVERIFIED');return {formula:f[0]!,effective:e[0]!};};
 mark('SNAPSHOT');const snapshot=await take(),payment=verifiedInsertDailyPayment(snapshot.formula,record.paymentKey,Number(date[1]),Number(date[2]),Number(date[3]));
 // This opt-in is reserved for a separately pinned incident where the old
 // append+insert batch left one extra blank row. Verify every cell before
 // omitting that row from the original preimage proof.
 const extra=grid.rowCount===row.before_rows+2,blank=(v:unknown)=>v===undefined||v===null||v==='';
 if(extra&&[snapshot.formula[row.before_rows+1],snapshot.effective[row.before_rows+1]].some(r=>r!==undefined&&(!Array.isArray(r)||r.length>grid.columnCount||r.some(v=>!blank(v)))))return null;
 const insertSnapshot=extra?{formula:snapshot.formula.slice(0,row.before_rows+1),effective:snapshot.effective.slice(0,row.before_rows+1)}:snapshot;
 const payload=encodeAtomicDailyPayload({expenseId:job.entityKey,postingYear:payment.postingYear,postingMonth:payment.postingMonth,postingDay:payment.postingDay,description:record.description.trim(),amountColumn:payment.amountColumn,amountSatang:Number(source.expense.amount_satang),category:record.category.trim(),wallet:legacySourceWallet(record.paymentKey,record.sourceWallet),operationMarker:row.marker});
 mark('LEGACY');const legacy=await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,target.sheet,policy);
 const legacyIdRange=`'${env.SHEET_EXPENSE_DAILY.replace(/'/g,"''")}'!X1:X${legacy.grid.rowCount}`;
 const legacyIds=await readVerifiedLegacyDailyIds(env,legacyIdRange,legacy.grid.rowCount,job.entityKey,policy);
 // This is an additional duplicate guard for positive verification only;
 // absence from the legacy tab can never justify dispatch or retry.
 if(!legacyIds)return null;
 mark('FORMAT');const formats=await getSheetCellNumberFormats(env,target.sheet,row.sheet_id,row.target_row,policy);
 mark('NOTICE');if(!await verifyNotice())return null;
 mark('POSTIMAGE');
 const matches=historical
  ?await matchesPinnedHistoricalDailyReadback(historical.receipt,pin,historical.fingerprint,
   {spreadsheetId:book,sheetId:grid.sheetId,sheetName:target.sheet,
    rowCount:grid.rowCount,columnCount:grid.columnCount,values:snapshot})
  :await matchesCommittedDailyInsert(insertSnapshot,coords,payload,row.before_digest,row.payload_digest);
 if(!matches)return null;
 mark('ACCOUNTING');if(!verifyMixedDailyAccounting(snapshot,grid.rowCount,grid.columnCount,payment.postingYear,payment.postingMonth,legacy.coverage))return null;
 mark('CARRIER');if(!await verifyDailyCarrierEvidence(env,target.sheet,row.sheet_id,grid.columnCount,snapshot.formula,{entityId:job.entityKey,operationToken,payload}))return null;
 mark('FORMAT');if(formats.length!==17||!formats.slice(0,15).every(f=>f?.type==='NUMBER'&&f.pattern==='#,##0.00')||formats[16]?.type!=='DATE'||formats[16]?.pattern!=='dd/MM/yyyy')return null;
 mark('REPORT');if(await readContinuousReportHealth(env,undefined,undefined,policy)!=='OK')return null;
 mark('FINAL_READS');const latest=await readSource();
 if(!latest||latest.revision!==source.revision||latest.digest!==source.digest||latest.fingerprint!==source.fingerprint||historical&&!sameScope())return null;
 if(JSON.stringify(await take())!==JSON.stringify(snapshot)||
  JSON.stringify(await readLegacyDailyCoverage(env,payment.postingYear,payment.postingMonth,target.sheet,policy))!==JSON.stringify(legacy)||
  JSON.stringify(await readVerifiedLegacyDailyIds(env,legacyIdRange,legacy.grid.rowCount,job.entityKey,policy))!==JSON.stringify(legacyIds))return null;
 if((repeatFormatAndReports||historical)&&(JSON.stringify(await getSheetCellNumberFormats(env,target.sheet,row.sheet_id,row.target_row,policy))!==JSON.stringify(formats)||
  await readContinuousReportHealth(env,undefined,undefined,policy)!=='OK'))return null;
 if(!await verifyNotice()||!sameScope())return null;
 return {snapshot};
}
