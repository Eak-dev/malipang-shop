import type { Env } from '../types';
import { getSheetRowCount, getSheetValues } from './client';

/**
 * Read-only experiment. These findings are not authority to mutate a row:
 * an editor can sort/delete it between this snapshot and an A1 write.
 * No D1 row index is read or persisted by this module.
 */
export type LedgerKind = 'EXPENSE' | 'PERSONAL_USE' | 'PURCHASE_DETAILS';
export type IdentityFinding = 'UNIQUE' | 'ABSENT' | 'DUPLICATE' | 'CONFLICT';
export const LEDGER_INSPECTION_ROW_LIMIT = 10_000;

export class LedgerIdentityInspectionReview extends Error {
  constructor(reason: 'UNIQUE'|'ABSENT'|'DUPLICATE'|'CONFLICT'|'UNAVAILABLE') {
    super(`LEDGER_IDENTITY_INSPECTION_${reason}_REVIEW`);
    this.name = 'LedgerIdentityInspectionReview';
  }
}

const exact=(value:unknown):string=>typeof value==='string'?value:'';
const headers:Record<LedgerKind,readonly string[]>={
  EXPENSE:['Expense_ID'], PERSONAL_USE:['Personal_Use_ID'], PURCHASE_DETAILS:['Purchase_Item_ID','Expense_ID']
};

/**
 * Snapshot includes row 1 and ALL physical rows in the grid. Exact comparison
 * deliberately avoids case-folding or prefix matching on transaction IDs.
 */
export function resolveLedgerSnapshot(kind:LedgerKind, rows:unknown[][], expenseId:string, itemIds:readonly string[]=[]):IdentityFinding {
  if(!expenseId || expenseId.trim()!==expenseId || itemIds.some(x=>!x || x.trim()!==x))return 'CONFLICT';
  const expected=headers[kind], first=rows[0]||[];
  if(!expected.every((value,index)=>exact(first[index])===value))return 'CONFLICT';
  const data=rows.slice(1);
  if(kind!=='PURCHASE_DETAILS'){
    const matches=data.filter(row=>exact(row[0])===expenseId).length;
    return matches===0?'ABSENT':matches===1?'UNIQUE':'DUPLICATE';
  }
  if(new Set(itemIds).size!==itemIds.length)return 'DUPLICATE';
  const matchingExpense=data.filter(row=>exact(row[1])===expenseId);
  if(matchingExpense.some(row=>!exact(row[0])))return 'CONFLICT';
  const examined=itemIds.length ? itemIds : matchingExpense.map(row=>exact(row[0]));
  if(new Set(examined).size!==examined.length)return 'DUPLICATE';
  if(examined.length===0)return 'ABSENT';
  let found=0;
  for(const item of examined){
    const rowsWithItem=data.filter(row=>exact(row[0])===item);
    if(rowsWithItem.length>1)return 'DUPLICATE';
    if(rowsWithItem.length===1){
      if(exact(rowsWithItem[0]![1])!==expenseId)return 'CONFLICT';
      found++;
    }
  }
  return found===0?'ABSENT':found===examined.length?'UNIQUE':'CONFLICT';
}

export function ledgerInspectionEnabled(env:Pick<Env,'SHEETS_LEDGER_IDENTITY_INSPECTION'>):boolean {
  return env.SHEETS_LEDGER_IDENTITY_INSPECTION==='true';
}

/** When enabled, always HOLD; no result grants permission to write. */
export async function inspectLedgerAndHold(env:Env,kind:LedgerKind,sheet:string,expenseId:string,itemIds:readonly string[]=[]):Promise<void>{
  if(!ledgerInspectionEnabled(env))return;
  let finding:IdentityFinding;
  try{
    if(!sheet || itemIds.length>1000)throw new Error('invalid scope');
    const count=await getSheetRowCount(env,sheet);
    if(count>LEDGER_INSPECTION_ROW_LIMIT)throw new Error('inspection limit');
    const quoted=`'${sheet.replace(/'/g,"''")}'`;
    const rows=await getSheetValues(env,`${quoted}!A1:${kind==='PURCHASE_DETAILS'?'B':'A'}${count}`);
    finding=resolveLedgerSnapshot(kind,rows,expenseId,itemIds);
  }catch{
    throw new LedgerIdentityInspectionReview('UNAVAILABLE');
  }
  throw new LedgerIdentityInspectionReview(finding);
}
