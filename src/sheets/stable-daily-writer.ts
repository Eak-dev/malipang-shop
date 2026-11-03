import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetEffectiveSerialValues,batchGetSheetFormulaValues,batchUpdateSpreadsheet,getSheetGridInfo} from './client';
import {columnName,findMonthBlocks,legacySourceWallet,resolvePayment} from './daily-expense';
import {inspectDailyAppendSnapshot} from './daily-append-preflight';
import {verifyDailyRecoveryAccounting} from './daily-recovery-accounting';
import {stableDailyExpenseKey} from './daily-stable-row-plan';
import {buildStableEmptyDailyRow,type StableDailyValues} from './daily-stable-row-writes';
import {planStableExpenseProjections} from './stable-expense-projection-plan';
import {readStableExpenseSource,type StableExpenseSource} from './stable-expense-source';
import {newStableSourcePredicate,stableSourceIntegrity} from './stable-source-cutover';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';

/** Thrown before an intent or provider mutation, so a caller can safely
 * release the workbook while retaining the individual job for review. */
export class StableDailyCapacityError extends Error{constructor(){super('STABLE_DAILY_CAPACITY');this.name='StableDailyCapacityError';}}
/** Candidate only: caller must hold the workbook claim and pause old writers
 * and manual edits. Full months and unverified history always stop. */
export async function writeNewDailyUnderClaim(env:Env,job:SheetsSyncJob,lease:string,claim:string,source:StableExpenseSource):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,sheet=env.SHEET_EXPENSE_DAILY,planned=planStableExpenseProjections(source),record=planned.record;
 const others=()=>[env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW',env.SHEET_ATTENDANCE_RAW,env.SHEET_DAILY_PAYROLL,env.SHEET_WEEKLY_PAYROLL,env.SHEET_WAGE_HISTORY,env.SHEET_SHIFT_SCHEDULE,env.SHEET_OT_REQUESTS,env.SHEET_SYSTEM_LOG].filter(Boolean);
 const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,...others(),env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.EXTERNAL_API_TIMEOUT_MS,env.STABLE_PHASE1_ENABLED]),initialScope=scope(),stable=()=>env.DB===db&&scope()===initialScope;
 if(job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||record.expenseId!==job.entityKey||Number(source.expense.version)!==job.entityVersion||!book||!sheet||!lease||!claim||others().includes(sheet))throw Error('STABLE_DAILY_INVALID');
 const date=/^(\d{4})-(\d{2})-(\d{2})$/.exec(record.transactionDate);if(!date)throw Error('STABLE_DAILY_DATE');
 const year=Number(date[1]),month=Number(date[2]),day=Number(date[3]),actualDate=new Date(Date.UTC(year,month-1,day));if(actualDate.getUTCFullYear()!==year||actualDate.getUTCMonth()+1!==month||actualDate.getUTCDate()!==day)throw Error('STABLE_DAILY_DATE');
 const sourceMatches=async()=>{const current=await readStableExpenseSource(env,job,lease,claim);return !!current&&current.revision===source.revision&&current.digest===source.digest&&current.fingerprint===source.fingerprint&&stable()&&await stableWorkbookClaimOwned(env,claim)&&stable();};
 if(!await sourceMatches())throw Error('STABLE_DAILY_SOURCE_CHANGED');
 const grid=await getSheetGridInfo(env,sheet);if(!stable()||grid.rowCount>5000||grid.columnCount<25||grid.columnCount>100)throw Error('STABLE_DAILY_GRID_UNVERIFIED');
 const journal=await db.prepare("SELECT state,source_version,source_digest,sheet_id,sheet_name FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY'").bind(book,job.entityKey).first<{state:string;source_version:number;source_digest:string;sheet_id:number;sheet_name:string}>();
 if(journal&&(journal.state!=='VERIFIED'||journal.source_version!==job.entityVersion||journal.source_digest!==source.digest||journal.sheet_id!==grid.sheetId||journal.sheet_name!==sheet))throw Error('STABLE_DAILY_PREVIOUS_REVIEW');
 const range=`'${sheet.replace(/'/g,"''")}'!A1:${columnName(grid.columnCount)}${grid.rowCount}`;
 const sameGrid=async()=>{const now=await getSheetGridInfo(env,sheet);return stable()&&now.sheetId===grid.sheetId&&now.rowCount===grid.rowCount&&now.columnCount===grid.columnCount;};
 const snapshot=async()=>{if(!await sameGrid())throw Error('STABLE_DAILY_GRID_CHANGED');const f=await batchGetSheetFormulaValues(env,[range]),v=await batchGetSheetEffectiveSerialValues(env,[range]);if(!stable()||f.length!==1||v.length!==1||f[0]!.length>grid.rowCount||v[0]!.length>grid.rowCount||[...f[0]!,...v[0]!].some(row=>!Array.isArray(row)||row.length>grid.columnCount)||!await sameGrid())throw Error('STABLE_DAILY_READ_UNVERIFIED');return{fullFormula:f[0]!,formula:f[0]!.map(row=>row.slice(0,25)),effective:v[0]!.map(row=>row.slice(0,25))};};
 const choose=(s:Awaited<ReturnType<typeof snapshot>>)=>{const payment=resolvePayment(s.formula.slice(0,3),record.paymentKey,year,month,day),blocks=findMonthBlocks(s.formula).filter(b=>b.month===payment.postingMonth);if(blocks.length!==1)throw Error('STABLE_DAILY_MONTH_UNVERIFIED');const block=blocks[0]!,key=stableDailyExpenseKey(job.entityKey),found=s.formula.flatMap((row,index)=>row[23]===key?[index+1]:[]);if(found.length>1||journal&&!found.length||!journal&&found.length)throw Error('STABLE_DAILY_IDENTITY_REVIEW');
  for(let n=block.headerRow+1;n<block.totalRow;n++)if((s.fullFormula[n-1]??[]).slice(25).some(x=>x!==null&&x!==undefined&&x!==''))throw Error('STABLE_DAILY_EXTRA_DATA');
  const previous=journal&&found.length?Array.from({length:25},(_,i)=>s.formula[found[0]!-1]?.[i]??null):undefined;
  const p=inspectDailyAppendSnapshot({formula:s.formula,effective:s.effective,rowCount:grid.rowCount,expenseId:job.entityKey,year:payment.postingYear,month:payment.postingMonth,...previous?{expectedPrevious:previous}:{}});
  if(p.status==='CAPACITY_REQUIRED')throw new StableDailyCapacityError();
  if(p.status==='REVIEW')throw Error('STABLE_DAILY_REVIEW');
  if(journal&&p.status!=='FOUND'||!journal&&p.status!=='APPEND')throw Error('STABLE_DAILY_IDENTITY_REVIEW');
  const values:StableDailyValues={month:payment.postingMonth,day:payment.postingDay,description:record.description.trim(),amountColumn:payment.amountColumn,amountBaht:record.amountBaht,category:record.category,sourceWallet:legacySourceWallet(record.paymentKey,record.sourceWallet)};
  return{payment,block,key,plan:p,values};};
 const before=await snapshot(),choice=choose(before);if(!await sourceMatches())throw Error('STABLE_DAILY_SOURCE_CHANGED');
 const guard=`${stableSourceIntegrity} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND ${newStableSourcePredicate('EXPENSE')} AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))`;
 const args=[source.revision,book,claim,job.entityKey,job.entityVersion,job.entityKey,lease];
 if(choice.plan.status==='APPEND'){
  const reserved=await db.prepare(`INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) SELECT ?,'EXPENSE',?,'DAILY',?,?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${guard}`).bind(book,job.entityKey,grid.sheetId,sheet,job.entityVersion,source.digest,claim,...args).run();
  if(reserved.success!==true||Number(reserved.meta?.changes)!==1)throw Error('STABLE_DAILY_RESERVATION');
  const row=choice.plan.observedRow,requests=buildStableEmptyDailyRow(grid.sheetId,choice.block.headerRow,row,choice.key,choice.values,choice.plan.formulaColumnsMissing);
  await batchUpdateSpreadsheet(env,requests,async()=>{if(!await sourceMatches())throw Error('STABLE_DAILY_SOURCE_CHANGED');const current=await snapshot(),again=choose(current);if(again.plan.status!=='APPEND'||again.plan.observedRow!==row||JSON.stringify(current)!==JSON.stringify(before)||!await sourceMatches())throw Error('STABLE_DAILY_SHEET_CHANGED');});
 }
 const after=await snapshot(),found=after.formula.flatMap((row,index)=>row[23]===choice.key?[index+1]:[]);if(found.length!==1||!await sourceMatches())throw Error('STABLE_DAILY_READBACK');
 const row=found[0]!,data=after.formula[row-1]??[],columns:Record<string,number>={F:5,G:6,H:7,K:10,L:11,M:12,N:13,O:14,P:15,Q:16},amountColumn=columns[choice.values.amountColumn];
 if(amountColumn===undefined||Number(data[1])!==choice.values.month||Number(data[2])!==choice.values.day||data[3]!==choice.values.description||data[amountColumn]!==choice.values.amountBaht||data[21]!==choice.values.category||data[22]!==choice.values.sourceWallet||!verifyDailyRecoveryAccounting(after.formula,after.effective,row,choice.values.month,choice.payment.postingYear,choice.values.day))throw Error('STABLE_DAILY_ACCOUNTING_UNVERIFIED');
 const previous=Array.from({length:25},(_,i)=>data[i]??null),checked=inspectDailyAppendSnapshot({formula:after.formula,effective:after.effective,rowCount:grid.rowCount,expenseId:job.entityKey,year:choice.payment.postingYear,month:choice.values.month,expectedPrevious:previous});if(checked.status!=='FOUND'||checked.observedRow!==row)throw Error('STABLE_DAILY_READBACK');
 if(choice.plan.status==='APPEND'){
  const done=await db.prepare(`UPDATE stable_projection_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection='DAILY' AND sheet_id=? AND sheet_name=? AND source_version=? AND source_digest=? AND operation_token=? AND state='IN_FLIGHT' AND ${guard}`).bind(book,job.entityKey,grid.sheetId,sheet,job.entityVersion,source.digest,claim,...args).run();if(done.success!==true||Number(done.meta?.changes)!==1)throw Error('STABLE_DAILY_VERIFICATION_UNCERTAIN');
 }
}
