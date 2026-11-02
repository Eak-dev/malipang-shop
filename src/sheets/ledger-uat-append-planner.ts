import type {Env} from '../types';
import type {LedgerCellState,LedgerWriteIdentity} from './ledger-metadata-writer';

/** A complete, current, independently obtained UAT-only grid observation.
 * This type is not evidence of provenance, a lock, or an atomic precondition. */
export interface LedgerUatAppendSnapshot{
  sheetId:number;
  rowCount:number;
  columnCount:number;
  rows:readonly (readonly LedgerCellState[])[];
  hasProtectedRanges:boolean;
  hasMerges:boolean;
}
const widths={EXPENSE:17,PERSONAL_USE:15} as const;
const headers={EXPENSE:'Expense_ID',PERSONAL_USE:'Personal_Use_ID'} as const;
const keys={EXPENSE:'E',PERSONAL_USE:'P'} as const;
function complete(cell:LedgerCellState|undefined):cell is LedgerCellState{
  if(!cell||typeof cell.hasValidation!=='boolean'||!(cell.note===null||typeof cell.note==='string')||!(cell.formula===null||typeof cell.formula==='string'))return false;
  return cell.entered===null||typeof cell.entered==='string'||typeof cell.entered==='boolean'||typeof cell.entered==='number'&&Number.isFinite(cell.entered);
}
function entered(value:unknown):Record<string,unknown>{
  if(value===null||value===undefined||value==='')return {};
  if(typeof value==='string')return {userEnteredValue:{stringValue:value}};
  if(typeof value==='number'&&Number.isFinite(value))return {userEnteredValue:{numberValue:value}};
  if(typeof value==='boolean')return {userEnteredValue:{boolValue:value}};
  throw Error('LEDGER_UAT_APPEND_VALUE_INVALID');
}

/**
 * Request planning experiment only. No caller in this branch sends these
 * requests. Despite an inserted row and marker in one Sheets batch, a human
 * or legacy writer may create the same ID or move data after this snapshot.
 * Production requires exclusive writer cutover, durable intent, ambiguous
 * outcome recovery, source/version proof and provider readback. A batch error
 * is not permission to retry blindly, especially if its outcome is unknown.
 */
export function buildLedgerUatAppendRequests(env:Env,sheetName:string,identity:LedgerWriteIdentity,metadataId:number,values:readonly unknown[],snapshot:LedgerUatAppendSnapshot):unknown[]{
  if(env.RUNTIME_MODE!=='shadow'||env.SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE!=='true'||!env.SHEETS_LEDGER_UAT_SPREADSHEET_ID||!env.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||env.SHEETS_LEDGER_UAT_SPREADSHEET_ID===env.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||env.GOOGLE_SPREADSHEET_ID!==env.SHEETS_LEDGER_UAT_SPREADSHEET_ID)throw Error('LEDGER_UAT_APPEND_DISABLED');
  if(identity.kind==='PURCHASE_DETAILS')throw Error('LEDGER_UAT_APPEND_DETAIL_UNAVAILABLE');
  const kind=identity.kind,size=widths[kind],expectedSheet=kind==='EXPENSE'?env.SHEET_EXPENSE_RAW:env.SHEET_PERSONAL_USE_RAW;
  if(!sheetName||sheetName!==expectedSheet||!identity.entityId||identity.entityId.trim()!==identity.entityId||identity.itemId!==undefined||!Number.isSafeInteger(identity.sheetId)||identity.sheetId<0||!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647||values.length!==size||values[0]!==identity.entityId)throw Error('LEDGER_UAT_APPEND_INVALID');
  // The following insertion grows the grid, which must remain readable under
  // the UAT reader's 10,000-row bound for mandatory postimage verification.
  if(!snapshot||snapshot.sheetId!==identity.sheetId||!Number.isSafeInteger(snapshot.rowCount)||snapshot.rowCount<1||snapshot.rowCount>=10000||!Number.isSafeInteger(snapshot.columnCount)||snapshot.columnCount<size||snapshot.columnCount>64||snapshot.rows.length!==snapshot.rowCount||snapshot.hasProtectedRanges!==false||snapshot.hasMerges!==false)throw Error('LEDGER_UAT_APPEND_GRID_INVALID');
  let last=-1;
  for(let r=0;r<snapshot.rowCount;r++){
    const row=snapshot.rows[r];if(!row||row.length!==snapshot.columnCount)throw Error('LEDGER_UAT_APPEND_GRID_INVALID');
    for(const cell of row){if(!complete(cell))throw Error('LEDGER_UAT_APPEND_GRID_INVALID');if(cell.entered!==null||cell.formula!==null||cell.note!==null||cell.hasValidation)last=r;}
    if(row[0]!.formula!==null)throw Error('LEDGER_UAT_APPEND_ID_UNCERTAIN');
    if(r>0&&row[0]!.entered===identity.entityId)throw Error('LEDGER_UAT_APPEND_DUPLICATE');
  }
  if(snapshot.rows[0]![0]!.entered!==headers[kind])throw Error('LEDGER_UAT_APPEND_HEADER_INVALID');
  const index=Math.max(1,last+1),cells=Array.from({length:snapshot.columnCount},(_,i)=>i<size?entered(values[i]):{});
  return [
    {insertDimension:{range:{sheetId:identity.sheetId,dimension:'ROWS',startIndex:index,endIndex:index+1},inheritFromBefore:true}},
    {updateCells:{start:{sheetId:identity.sheetId,rowIndex:index,columnIndex:0},rows:[{values:cells}],fields:'userEnteredValue,note,dataValidation'}},
    {createDeveloperMetadata:{developerMetadata:{metadataId,metadataKey:keys[kind],visibility:'DOCUMENT',location:{dimensionRange:{sheetId:identity.sheetId,dimension:'ROWS',startIndex:index,endIndex:index+1}}}}}
  ];
}
