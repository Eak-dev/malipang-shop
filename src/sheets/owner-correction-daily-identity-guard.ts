import type {Env} from '../types';
import {batchGetSheetFormulaValues,batchGetSheetValues,batchPatchMetadataRows,getSheetProtectedRanges,getSheetRowMetadataById,readSheetRowsByMetadata,searchSheetRowMetadata,type SheetProtectedRange,type SheetRowMetadata} from './client';
import {matchesOwnerCorrectionIdentity} from './owner-correction-identity';
import {isIsoDate} from '../shared/time';
import {legacySourceWallet,resolvePayment} from './daily-expense';
import type {GuardedDailyMutation} from './owner-correction-daily-write-fence';

const columns=[1,2,3,5,6,7,10,11,12,13,14,15,16,21,22];
const quote=(value:string)=>`'${value.replace(/'/g,"''")}'`;
export class DailyIdentityReviewRequired extends Error{constructor(){super('DAILY_IDENTITY_REVIEW_REQUIRED');this.name='DailyIdentityReviewRequired';}}

/** Inert before installation and permanent after activation, independently of the LINE flag. */
export async function dailyIdentityEnforced(env:Env,sheet:string):Promise<boolean>{
  const installed=await env.DB.prepare(`SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='owner_correction_daily_identity_latch'`).first<{present:number}>();
  if(!installed)return false;
  return Boolean(await env.DB.prepare(`SELECT 1 AS present FROM owner_correction_daily_identity_latch WHERE sheet_name=?`).bind(sheet).first<{present:number}>());
}

/** Activation must hold the shared sheet-wide fence; no API endpoint enables it. */
export async function activateDailyIdentityLatch(env:Env,sheet:string,token:string,nowMs=Date.now()):Promise<boolean>{
  if(!sheet||!token||!Number.isFinite(nowMs))return false;
  const now=new Date(nowMs);if(!Number.isFinite(now.getTime()))return false;
  const result=await env.DB.prepare(`INSERT OR IGNORE INTO owner_correction_daily_identity_latch(sheet_name,activated_at)
    SELECT ?,? WHERE EXISTS(SELECT 1 FROM owner_correction_daily_write_fences WHERE sheet_name=? AND lease_token=? AND state='OWNED' AND lease_until>?)`)
    .bind(sheet,now.toISOString(),sheet,token,now.toISOString()).run();
  return Number(result.meta.changes||0)===1;
}

interface ExpenseRow{expense_id:string;description:string;category:string;amount_satang:number;transaction_date:string;payment_key:string;source_wallet:string;status:string;version:number;updated_at:string|null}
interface DailyObservation{expense:ExpenseRow;marker:SheetRowMetadata;values:unknown[];formulas:unknown[];sheetYear:number;posting:{postingYear:number;postingMonth:number;postingDay:number;amountColumn:string};ranges:SheetProtectedRange[]}
const columnIndex=(letters:string)=>{let n=0;for(const c of letters)n=n*26+c.charCodeAt(0)-64;return n-1;};

/** Restrictions must cover all mutation cells and permit only this service account.
 * Spreadsheet owners can always override protection: this is not a Sheets CAS. */
export function protectedDailyInputs(ranges:SheetProtectedRange[],marker:SheetRowMetadata,serviceAccount:string):boolean{
  const account=serviceAccount.trim().toLowerCase();if(!account||!Array.isArray(ranges)||ranges.some(item=>!item.range||item.range.sheetId!==marker.sheetId))return false;
  return columns.every(column=>{
    const covered=ranges.filter(item=>{const r=item.range!;return (r.startRowIndex??0)<=marker.rowIndex&&(r.endRowIndex??Infinity)>marker.rowIndex&&(r.startColumnIndex??0)<=column&&(r.endColumnIndex??Infinity)>column;});
    return covered.length>0&&covered.every(item=>item.warningOnly!==true&&item.requestingUserCanEdit===true&&!(item.unprotectedRanges?.length)&&item.editors?.domainUsersCanEdit!==true&&!(item.editors?.groups?.length)&&Array.isArray(item.editors?.users)&&item.editors!.users!.length>0&&item.editors!.users!.every(user=>typeof user==='string'&&user.trim().toLowerCase()===account));
  });
}

async function observe(env:Env,expenseId:string):Promise<DailyObservation|null>{
  const expense=await env.DB.prepare(`SELECT expense_id,description,category,amount_satang,transaction_date,payment_key,source_wallet,status,version,updated_at FROM expense_events WHERE expense_id=?`).bind(expenseId).first<ExpenseRow>();
  if(!expense||expense.status!=='CANCELLED'||!Number.isSafeInteger(expense.version)||expense.version<1||!Number.isSafeInteger(expense.amount_satang)||expense.amount_satang<=0||!isIsoDate(expense.transaction_date))return null;
  const [markers,protection,headerResult]=await Promise.all([searchSheetRowMetadata(env,'malipang_expense_daily'),getSheetProtectedRanges(env,env.SHEET_EXPENSE_DAILY),batchGetSheetValues(env,[`${quote(env.SHEET_EXPENSE_DAILY)}!A1:W5`])]);
  const matching=markers.filter(item=>item.metadataValue===expenseId);
  if(matching.length!==1||matching[0]!.sheetId!==protection.sheetId||markers.filter(item=>item.sheetId===matching[0]!.sheetId&&item.rowIndex===matching[0]!.rowIndex).length!==1)return null;
  const marker=matching[0]!,headers=headerResult[0];if(!headers||!protectedDailyInputs(protection.ranges,marker,env.GOOGLE_SERVICE_ACCOUNT_EMAIL||''))return null;
  const year=Number(headers[4]?.[0]),date=expense.transaction_date.split('-').map(Number);let posting:DailyObservation['posting'];
  try{posting=resolvePayment(headers,expense.payment_key,date[0]!,date[1]!,date[2]!);}catch{return null;}
  if(!Number.isSafeInteger(year)||year!==posting.postingYear)return null;
  const [values,formulaResult,metadata]=await Promise.all([readSheetRowsByMetadata(env,[marker.metadataId]),batchGetSheetFormulaValues(env,[`${quote(env.SHEET_EXPENSE_DAILY)}!A${marker.rowIndex+1}:W${marker.rowIndex+1}`]),getSheetRowMetadataById(env,marker.metadataId)]);
  if(!metadata||JSON.stringify(metadata)!==JSON.stringify(marker)||!values.has(marker.metadataId)||formulaResult.length!==1||formulaResult[0]!.length>1)return null;
  const formulas=formulaResult[0]![0]||[];if(columns.some(column=>typeof formulas[column]==='string'&&(formulas[column] as string).startsWith('=')))return null;
  return {expense,marker,values:values.get(marker.metadataId)!,formulas,sheetYear:year,posting,ranges:protection.ranges};
}
function matches(o:DailyObservation):boolean{
  return matchesOwnerCorrectionIdentity({expenseId:o.expense.expense_id,description:o.expense.description,amountSatang:o.expense.amount_satang,postingYear:o.posting.postingYear,postingMonth:o.posting.postingMonth,postingDay:o.posting.postingDay,amountColumn:columnIndex(o.posting.amountColumn)},{rowNumber:o.marker.rowIndex+1,sheetYear:o.sheetYear,values:o.values})&&o.values[21]===o.expense.category&&o.values[22]===legacySourceWallet(o.expense.payment_key,o.expense.source_wallet);
}
const blank=(o:DailyObservation)=>columns.every(i=>o.values[i]===undefined||o.values[i]===null||o.values[i]==='');

/**
 * Only an already linked, exact cancelled expense can be cleared. Unlinked and
 * historical item rows remain held. The metadata ID, not a numeric A1 row,
 * directs the write; the provider result and an independent read are checked.
 */
export async function clearVerifiedCancelledDailyExpense(env:Env,expenseId:string,write:GuardedDailyMutation,fenceToken?:string):Promise<number[]>{
  if(!fenceToken)throw new DailyIdentityReviewRequired();
  const fence=await env.DB.prepare(`SELECT 1 AS present FROM owner_correction_daily_write_fences WHERE sheet_name=? AND lease_token=? AND state='OWNED' AND lease_until>?`).bind(env.SHEET_EXPENSE_DAILY,fenceToken,new Date().toISOString()).first<{present:number}>();
  if(!fence)throw new DailyIdentityReviewRequired();
  const mappings=await env.DB.prepare(`SELECT entity_key,row_number FROM sheet_row_index WHERE sheet_name=? AND (entity_key=? OR substr(entity_key,1,length(?)+1)=? || '|')`).bind(env.SHEET_EXPENSE_DAILY,expenseId,expenseId,expenseId).all<{entity_key:string;row_number:number}>();
  const rows=mappings.results||[];if(!rows.length)throw new DailyIdentityReviewRequired();
  if(rows.length!==1||rows[0]!.entity_key!==expenseId)throw new DailyIdentityReviewRequired();
  const a=await observe(env,expenseId),b=await observe(env,expenseId);if(!a||!b||JSON.stringify(a)!==JSON.stringify(b)||(!matches(a)&&!blank(a)))throw new DailyIdentityReviewRequired();
  let clearedRow=a.marker.rowIndex+1;
  if(!blank(a)){
    const patch=[{metadataId:a.marker.metadataId,cells:columns.map(columnIndex=>({columnIndex,value:''}))}];
    await write(before=>batchPatchMetadataRows(env,patch,columns,async()=>{const last=await observe(env,expenseId);if(!last||JSON.stringify(last)!==JSON.stringify(a))throw new DailyIdentityReviewRequired();if(before)await before();}));
    const after=await observe(env,expenseId);if(!after||after.marker.metadataId!==a.marker.metadataId||JSON.stringify(after.expense)!==JSON.stringify(a.expense)||!blank(after))throw new DailyIdentityReviewRequired();clearedRow=after.marker.rowIndex+1;
  }
  const deleted=await env.DB.prepare(`DELETE FROM sheet_row_index WHERE sheet_name=? AND entity_key=? AND row_number=? AND EXISTS(SELECT 1 FROM expense_events WHERE expense_id=? AND status='CANCELLED' AND version=? AND updated_at IS ?)`)
    .bind(env.SHEET_EXPENSE_DAILY,expenseId,rows[0]!.row_number,expenseId,a.expense.version,a.expense.updated_at).run();
  if(Number(deleted.meta.changes||0)!==1)throw new DailyIdentityReviewRequired();
  return [clearedRow];
}
