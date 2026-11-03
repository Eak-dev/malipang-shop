import type {Env,SheetsSyncJob} from '../types';
import {batchGetSheetFormulaValues,batchWriteValues,getSheetGridInfo} from './client';
import {columnName} from './daily-expense';
import {buildPersonalUseRawSheetValues} from './sync';
import {planStableLedgerRow} from './stable-ledger-row-plan';
import {newStableSourcePredicate} from './stable-source-cutover';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';

const personalHeaders=['Personal_Use_ID','Transaction_Type','Transaction_Date','Description','Amount_Baht','Source_Wallet','Status','Message_ID','Trace_ID','Submitted_By','Branch_ID','Approved_At','Created_At','Updated_At','Version'] as const;
/** Unrouted phase-one candidate. The caller must own the workbook claim and
 * retain it on any exception. The old deployment and manual edits must be
 * paused; Google Sheets does not provide a compare-and-swap for values. */
export async function writeNewPersonalUnderClaim(env:Env,job:SheetsSyncJob,lease:string,claim:string):Promise<void>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,sheet=env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW';
 const otherSheets=()=>[env.SHEET_EXPENSE_RAW,env.SHEET_EXPENSE_DAILY,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.SHEET_ATTENDANCE_RAW,env.SHEET_DAILY_PAYROLL,env.SHEET_WEEKLY_PAYROLL,env.SHEET_WAGE_HISTORY,env.SHEET_SHIFT_SCHEDULE,env.SHEET_OT_REQUESTS,env.SHEET_SYSTEM_LOG].filter(Boolean);
 const currentScope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW',...otherSheets(),env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.EXTERNAL_API_TIMEOUT_MS]);
 const scope=currentScope(),stable=()=>env.DB===db&&currentScope()===scope;
 if(job.kind!=='SHEETS_SYNC'||job.entityType!=='PERSONAL_USE'||!job.entityKey||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<1||!lease||!claim||!book)throw Error('STABLE_PERSONAL_INVALID');
 if(otherSheets().includes(sheet))throw Error('STABLE_PERSONAL_SHEET_ALIAS');
 const source=async()=>db.prepare(`SELECT p.* FROM owner_personal_transactions p WHERE p.personal_use_id=? AND p.version=? AND p.status='CONFIRMED' AND ${newStableSourcePredicate('PERSONAL_USE')}
   AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='PERSONAL_USE' AND j.entity_key=p.personal_use_id AND j.entity_version=p.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(job.entityKey,job.entityVersion,job.entityKey,lease).first<Record<string,unknown>>();
 const initial=await source();if(!initial||!stable()||!await stableWorkbookClaimOwned(env,claim))throw Error('STABLE_PERSONAL_SOURCE_UNVERIFIED');
 const fingerprint=JSON.stringify(initial),values=buildPersonalUseRawSheetValues(initial),grid=await getSheetGridInfo(env,sheet);
 const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fingerprint))),v=>v.toString(16).padStart(2,'0')).join('');
 const fields=Object.entries(initial);if(fields.length>50||fields.some(([key,value])=>!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)||(value!==null&&!['string','number'].includes(typeof value))))throw Error('STABLE_PERSONAL_SOURCE_UNVERIFIED');
 const exact=fields.map(([key])=>`p."${key}" IS ?`).join(' AND '),fieldValues=fields.map(([,value])=>value);
 const rowGuard=`EXISTS(SELECT 1 FROM owner_personal_transactions p WHERE p.personal_use_id=? AND p.version=? AND p.status='CONFIRMED' AND ${exact} AND ${newStableSourcePredicate('PERSONAL_USE')} AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='PERSONAL_USE' AND j.entity_key=p.personal_use_id AND j.entity_version=p.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')`;
 const guardArgs=[job.entityKey,job.entityVersion,...fieldValues,job.entityKey,lease,book,claim];
 const journal=await db.prepare("SELECT state,source_version,source_digest FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='PERSONAL_USE' AND entity_id=?").bind(book,job.entityKey).first<{state:string;source_version:number;source_digest:string}>();
 if(journal&&(journal.state!=='VERIFIED'||journal.source_version!==job.entityVersion||journal.source_digest!==digest))throw Error('STABLE_PERSONAL_PREVIOUS_REVIEW');
 if(!stable()||grid.rowCount>5000||grid.columnCount>100||grid.columnCount<values.length)throw Error('STABLE_PERSONAL_GRID_UNVERIFIED');
 const range=`'${sheet.replace(/'/g,"''")}'!A1:${columnName(grid.columnCount)}${grid.rowCount}`;
 const sameGrid=async()=>{const now=await getSheetGridInfo(env,sheet);return stable()&&now.sheetId===grid.sheetId&&now.rowCount===grid.rowCount&&now.columnCount===grid.columnCount;};
 const snapshot=async()=>{if(!await sameGrid())throw Error('STABLE_PERSONAL_GRID_CHANGED');const result=await batchGetSheetFormulaValues(env,[range]);if(!stable()||result.length!==1||result[0]!.length>grid.rowCount||result[0]!.some(row=>!Array.isArray(row)||row.length>grid.columnCount)||!await sameGrid())throw Error('STABLE_PERSONAL_READ_UNVERIFIED');return result[0]!;};
 const before=await snapshot();if(personalHeaders.some((name,index)=>before[0]?.[index]!==name))throw Error('STABLE_PERSONAL_HEADER_UNVERIFIED');
 const plan=planStableLedgerRow(before,job.entityKey,values,!journal);
 if(plan.status==='REVIEW')throw Error('STABLE_PERSONAL_REVIEW');
 if(plan.status==='PRESENT'&&!journal)throw Error('STABLE_PERSONAL_UNCLAIMED_IDENTITY');
 const sourceMatches=async()=>{const current=await source();return !!current&&stable()&&JSON.stringify(current)===fingerprint&&await stableWorkbookClaimOwned(env,claim)&&stable();};
 if(!await sourceMatches())throw Error('STABLE_PERSONAL_SOURCE_CHANGED');
 if(plan.status==='APPEND'){
  if(plan.observedRow>grid.rowCount)throw Error('STABLE_PERSONAL_CAPACITY_REVIEW');
  const reserved=await db.prepare(`INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,source_version,source_digest,operation_token,state,updated_at) SELECT ?,'PERSONAL_USE',?,?,?,?,'IN_FLIGHT',strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE ${rowGuard}`).bind(book,job.entityKey,job.entityVersion,digest,claim,...guardArgs).run();
  if(reserved.success!==true||Number(reserved.meta?.changes)!==1)throw Error('STABLE_PERSONAL_RESERVATION_UNVERIFIED');
  const target=`'${sheet.replace(/'/g,"''")}'!A${plan.observedRow}:${columnName(values.length)}${plan.observedRow}`;
  await batchWriteValues(env,[{range:target,values:[values]}],async()=>{
   if(!await sourceMatches())throw Error('STABLE_PERSONAL_SOURCE_CHANGED');
   const current=await snapshot(),again=planStableLedgerRow(current,job.entityKey,values,true);
   if(again.status!=='APPEND'||again.observedRow!==plan.observedRow||JSON.stringify(current)!==JSON.stringify(before)||!await sourceMatches())throw Error('STABLE_PERSONAL_SHEET_CHANGED');
  });
 }
 const after=await snapshot();if(personalHeaders.some((name,index)=>after[0]?.[index]!==name))throw Error('STABLE_PERSONAL_HEADER_UNVERIFIED');
 const verified=planStableLedgerRow(after,job.entityKey,values,true);
 if(verified.status!=='PRESENT'||!await sourceMatches())throw Error('STABLE_PERSONAL_READBACK_UNVERIFIED');
 if(plan.status==='APPEND'){
  const recorded=await db.prepare(`UPDATE stable_projection_writes SET state='VERIFIED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND entity_type='PERSONAL_USE' AND entity_id=? AND source_version=? AND source_digest=? AND operation_token=? AND state='IN_FLIGHT' AND ${rowGuard}`).bind(book,job.entityKey,job.entityVersion,digest,claim,...guardArgs).run();
  if(recorded.success!==true||Number(recorded.meta?.changes)!==1)throw Error('STABLE_PERSONAL_VERIFICATION_UNCERTAIN');
 }
}
