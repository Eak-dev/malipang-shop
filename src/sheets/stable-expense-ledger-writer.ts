import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetFormulaValues,batchWriteValues,getSheetGridInfo} from './client';
import {columnName} from './daily-expense';
import {planStableLedgerRow} from './stable-ledger-row-plan';
import {readStableExpenseSource,type StableExpenseSource} from './stable-expense-source';
import {planStableExpenseProjections} from './stable-expense-projection-plan';
import {newStableSourcePredicate,stableSourceIntegrity} from './stable-source-cutover';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';

const rawHeaders=['Expense_ID','Transaction_Date','Description','Amount_Baht','Payment_Key','Source_Wallet','Category','Status','Message_ID','Trace_ID','Submitted_By_Staff_ID','Branch_ID','Document_ID','Document_Type','Vendor','Document_Number','Order_ID'];
const detailHeaders=['Purchase_Item_ID','Expense_ID','Document_ID','วันที่ซื้อ','บริษัท/ร้านค้า','เลขที่เอกสาร','รายการสินค้า','จำนวน','หน่วย','ราคาต่อหน่วย','ส่วนลดรายการ','จำนวนเงินรายการ','ส่วนลด/ปรับยอดระดับเอกสาร','ยอดจ่ายจริงของ Expense','หมวด','สาขา','สถานะ','Evidence ref (private)','Created_At','Updated_At / Cancelled_At'];

/** Candidate, not routed. The caller must retain the workbook claim on any
 * failure and pause old writers and manual edits during this operation. */
export async function writeNewExpenseLedgerUnderClaim(env:Env,job:SheetsSyncJob,lease:string,claim:string,source:StableExpenseSource,projection:'EXPENSE_RAW'|'DETAIL',itemId?:string):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,plan=planStableExpenseProjections(source);
 const sheet=projection==='EXPENSE_RAW'?env.SHEET_EXPENSE_RAW:(env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ');
 const headers=projection==='EXPENSE_RAW'?rawHeaders:detailHeaders;
 const entry=projection==='DETAIL'?plan.details.find(x=>x.itemId===itemId):undefined;
 if(job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!book||!sheet||!lease||!claim||source.expense.expense_id!==job.entityKey||Number(source.expense.version)!==job.entityVersion||projection==='DETAIL'&&!entry)throw Error('STABLE_EXPENSE_LEDGER_INVALID');
 const identity=projection==='EXPENSE_RAW'?job.entityKey:entry!.itemId,entity=projection==='EXPENSE_RAW'?job.entityKey:`${job.entityKey}|${identity}`,values=projection==='EXPENSE_RAW'?plan.raw:entry!.values;
 const others=[env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW',env.SHEET_EXPENSE_DAILY,projection==='EXPENSE_RAW'?(env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ'):env.SHEET_EXPENSE_RAW,env.SHEET_ATTENDANCE_RAW,env.SHEET_DAILY_PAYROLL,env.SHEET_WEEKLY_PAYROLL,env.SHEET_WAGE_HISTORY,env.SHEET_SHIFT_SCHEDULE,env.SHEET_OT_REQUESTS,env.SHEET_SYSTEM_LOG].filter(Boolean);
 const scope=JSON.stringify([book,sheet,...others,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.EXTERNAL_API_TIMEOUT_MS,env.STABLE_PHASE1_ENABLED]);
 const stable=()=>env.DB===db&&JSON.stringify([env.GOOGLE_SPREADSHEET_ID,projection==='EXPENSE_RAW'?env.SHEET_EXPENSE_RAW:(env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ'),...([env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW',env.SHEET_EXPENSE_DAILY,projection==='EXPENSE_RAW'?(env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ'):env.SHEET_EXPENSE_RAW,env.SHEET_ATTENDANCE_RAW,env.SHEET_DAILY_PAYROLL,env.SHEET_WEEKLY_PAYROLL,env.SHEET_WAGE_HISTORY,env.SHEET_SHIFT_SCHEDULE,env.SHEET_OT_REQUESTS,env.SHEET_SYSTEM_LOG].filter(Boolean)),env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.EXTERNAL_API_TIMEOUT_MS,env.STABLE_PHASE1_ENABLED])===scope;
 if(others.includes(sheet))throw Error('STABLE_EXPENSE_SHEET_ALIAS');
 const sourceMatches=async()=>{const current=await readStableExpenseSource(env,job,lease,claim);return !!current&&current.revision===source.revision&&current.digest===source.digest&&current.fingerprint===source.fingerprint&&stable()&&await stableWorkbookClaimOwned(env,claim)&&stable();};
 if(!await sourceMatches())throw Error('STABLE_EXPENSE_SOURCE_CHANGED');
 const grid=await getSheetGridInfo(env,sheet);if(!stable()||grid.rowCount>5000||grid.columnCount>100||grid.columnCount<headers.length)throw Error('STABLE_EXPENSE_GRID_UNVERIFIED');
 const journal=await db.prepare("SELECT state,source_version,source_digest,sheet_id,sheet_name FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection=?").bind(book,entity,projection).first<{state:string;source_version:number;source_digest:string;sheet_id:number;sheet_name:string}>();
 if(journal&&(journal.state!=='VERIFIED'||journal.source_version!==job.entityVersion||journal.source_digest!==source.digest||journal.sheet_id!==grid.sheetId||journal.sheet_name!==sheet))throw Error('STABLE_EXPENSE_PREVIOUS_REVIEW');
 const range=`'${sheet.replace(/'/g,"''")}'!A1:${columnName(grid.columnCount)}${grid.rowCount}`;
 const sameGrid=async()=>{const now=await getSheetGridInfo(env,sheet);return stable()&&now.sheetId===grid.sheetId&&now.rowCount===grid.rowCount&&now.columnCount===grid.columnCount;};
 const snapshot=async()=>{if(!await sameGrid())throw Error('STABLE_EXPENSE_GRID_CHANGED');const result=await batchGetSheetFormulaValues(env,[range]);if(!stable()||result.length!==1||result[0]!.length>grid.rowCount||result[0]!.some(row=>!Array.isArray(row)||row.length>grid.columnCount)||!await sameGrid()||headers.some((name,index)=>result[0]![0]?.[index]!==name))throw Error('STABLE_EXPENSE_READ_UNVERIFIED');return result[0]!;};
 const before=await snapshot(),rowPlan=planStableLedgerRow(before,identity,values,!journal);
 if(rowPlan.status==='REVIEW'||rowPlan.status==='PRESENT'&&!journal)throw Error('STABLE_EXPENSE_LEDGER_REVIEW');
 if(!await sourceMatches())throw Error('STABLE_EXPENSE_SOURCE_CHANGED');
 const guard=`${stableSourceIntegrity} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND ${newStableSourcePredicate('EXPENSE')} AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))`;
 const guardArgs=[source.revision,book,claim,job.entityKey,job.entityVersion,job.entityKey,lease];
 if(rowPlan.status==='APPEND'){
  if(rowPlan.observedRow>grid.rowCount)throw Error('STABLE_EXPENSE_LEDGER_CAPACITY');
  const reserved=await db.prepare(`INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) SELECT ?,'EXPENSE',?,?,?,?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${guard}`).bind(book,entity,projection,grid.sheetId,sheet,job.entityVersion,source.digest,claim,...guardArgs).run();
  if(reserved.success!==true||Number(reserved.meta?.changes)!==1)throw Error('STABLE_EXPENSE_RESERVATION_UNVERIFIED');
  const target=`'${sheet.replace(/'/g,"''")}'!A${rowPlan.observedRow}:${columnName(values.length)}${rowPlan.observedRow}`;
  await batchWriteValues(env,[{range:target,values:[values]}],async()=>{if(!await sourceMatches())throw Error('STABLE_EXPENSE_SOURCE_CHANGED');const current=await snapshot(),again=planStableLedgerRow(current,identity,values,true);if(again.status!=='APPEND'||again.observedRow!==rowPlan.observedRow||JSON.stringify(current)!==JSON.stringify(before)||!await sourceMatches())throw Error('STABLE_EXPENSE_LEDGER_CHANGED');});
 }
 const after=await snapshot();if(planStableLedgerRow(after,identity,values,true).status!=='PRESENT'||!await sourceMatches())throw Error('STABLE_EXPENSE_LEDGER_READBACK');
 if(rowPlan.status==='APPEND'){
  const recorded=await db.prepare(`UPDATE stable_projection_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND entity_id=? AND projection=? AND sheet_id=? AND sheet_name=? AND source_version=? AND source_digest=? AND operation_token=? AND state='IN_FLIGHT' AND ${guard}`).bind(book,entity,projection,grid.sheetId,sheet,job.entityVersion,source.digest,claim,...guardArgs).run();
  if(recorded.success!==true||Number(recorded.meta?.changes)!==1)throw Error('STABLE_EXPENSE_VERIFICATION_UNCERTAIN');
 }
}
