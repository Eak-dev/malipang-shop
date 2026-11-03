import type { LedgerKind } from './ledger-identity-inspection';
import {RAW_PROJECTION_HEADERS} from './raw-projection';

/**
 * Prototype request builder for a pre-enrolled, single row metadata identity.
 * No numeric row is persisted or used as the mutation target.
 * This is deliberately NOT wired to a production sync route: Google Sheets
 * does not offer compare-and-swap for cell contents, so partial-column sort
 * or an old writer can invalidate a preflight before dispatch.
 */
export interface LedgerMetadataWitness {
  metadataId:number;
  metadataKey:string;
  sheetId:number;
  dimension:'ROWS';
  startIndex:number;
  endIndex:number;
  visibility:'DOCUMENT';
}
export interface LedgerWriteIdentity {
  kind:LedgerKind;
  sheetId:number;
  entityId:string;
  itemId?:string;
}
export interface LedgerMetadataValueRange {
  dataFilter:{developerMetadataLookup:{metadataId:number}};
  majorDimension:'ROWS';
  values:unknown[][];
}
/** Complete user-entered cell state from a previous trusted projection and a
 * fresh Sheets read (including note and dataValidation fields). null means
 * empty; a formula is never accepted as a writable value. */
export interface LedgerCellState {
  entered:string|number|boolean|null;
  formula:string|null;
  note:string|null;
  hasValidation:boolean;
}
export interface LedgerWriteGuard {
  /** Explicit zero-based columns to change. A/B identity columns are forbidden. */
  fields:readonly number[];
  expected:readonly LedgerCellState[];
  observed:readonly LedgerCellState[];
}
const head:Record<LedgerKind,readonly string[]>={
  EXPENSE:RAW_PROJECTION_HEADERS.EXPENSE, PERSONAL_USE:RAW_PROJECTION_HEADERS.PERSONAL_USE, PURCHASE_DETAILS:['Purchase_Item_ID','Expense_ID']
};
const key:Record<LedgerKind,string>={EXPENSE:'E',PERSONAL_USE:'P',PURCHASE_DETAILS:'D'};
const size:Record<LedgerKind,number>={EXPENSE:17,PERSONAL_USE:15,PURCHASE_DETAILS:20};
const completeCell=(cell:LedgerCellState|undefined):cell is LedgerCellState=>{
  if(!cell||!('entered' in cell)||!('formula' in cell)||!('note' in cell)||typeof cell.hasValidation!=='boolean')return false;
  const value=cell.entered;
  return (value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))
    &&(cell.formula===null||typeof cell.formula==='string')&&(cell.note===null||typeof cell.note==='string');
};

/** Check complete current identity-column snapshot and exact metadata location. */
export function verifyLedgerMetadataWitness(identity:LedgerWriteIdentity,witness:LedgerMetadataWitness,identityRows:unknown[][]):void {
  const target=identity.kind==='PURCHASE_DETAILS'?identity.itemId:identity.entityId;
  if(!target || target.trim()!==target || !identity.entityId || identity.entityId.trim()!==identity.entityId)throw new Error('LEDGER_IDENTITY_INVALID');
  if(!Number.isSafeInteger(identity.sheetId)||identity.sheetId<0||!Number.isSafeInteger(witness.metadataId)||witness.metadataId<=0||witness.metadataId>2147483647||witness.sheetId!==identity.sheetId||witness.dimension!=='ROWS'||witness.visibility!=='DOCUMENT'||witness.metadataKey!==key[identity.kind]||!Number.isSafeInteger(witness.startIndex)||witness.startIndex<1||witness.endIndex!==witness.startIndex+1)throw new Error('LEDGER_METADATA_INVALID');
  if(!head[identity.kind].every((h,i)=>identityRows[0]?.[i]===h))throw new Error('LEDGER_HEADER_INVALID');
  const matches:number[]=[];
  for(let i=1;i<identityRows.length;i++)if(identityRows[i]?.[0]===target)matches.push(i);
  if(matches.length!==1||matches[0]!==witness.startIndex)throw new Error('LEDGER_IDENTITY_MISSING_DUPLICATE_OR_MOVED');
  if(identity.kind==='PURCHASE_DETAILS'&&identityRows[witness.startIndex]?.[1]!==identity.entityId)throw new Error('LEDGER_ITEM_EXPENSE_MISMATCH');
}

/**
 * Only explicitly selected, preimage-verified fields may be written. The
 * caller must source expected from trusted earlier evidence and read observed
 * with formula, note, and validation metadata. A read/write race remains.
 */
export function buildLedgerMetadataValueRange(identity:LedgerWriteIdentity,metadataId:number,values:readonly unknown[],guard:LedgerWriteGuard,mode:'PATCH'|'CANCEL_DETAIL'='PATCH'):LedgerMetadataValueRange {
  if(!Number.isSafeInteger(metadataId)||metadataId<=0||metadataId>2147483647||values.length!==size[identity.kind])throw new Error('LEDGER_WRITE_INVALID');
  const target=identity.kind==='PURCHASE_DETAILS'?identity.itemId:identity.entityId;
  if(!target||values[0]!==target||identity.kind==='PURCHASE_DETAILS'&&values[1]!==identity.entityId)throw new Error('LEDGER_WRITE_ID_MISMATCH');
  if(mode==='CANCEL_DETAIL'&&identity.kind!=='PURCHASE_DETAILS')throw new Error('LEDGER_WRITE_MODE_INVALID');
  if(!guard||!Array.isArray(guard.fields)||!guard.fields.length||new Set(guard.fields).size!==guard.fields.length||!Array.isArray(guard.expected)||!Array.isArray(guard.observed)||guard.expected.length!==values.length||guard.observed.length!==values.length)throw new Error('LEDGER_WRITE_GUARD_INVALID');
  const minimum=identity.kind==='PURCHASE_DETAILS'?2:1;
  for(const index of guard.fields){
    if(!Number.isInteger(index)||index<minimum||index>=values.length||(mode==='CANCEL_DETAIL'&&index!==16&&index!==19))throw new Error('LEDGER_WRITE_FIELD_FORBIDDEN');
    const expected=guard.expected[index], observed=guard.observed[index];
    if(!completeCell(expected)||!completeCell(observed)||expected.formula!==null||observed.formula!==null||expected.note!==null||observed.note!==null||expected.hasValidation!==false||observed.hasValidation!==false||expected.entered!==observed.entered)throw new Error('LEDGER_WRITE_PREIMAGE_CHANGED_OR_UNSAFE');
    const next=values[index];if(next!==null&&next!==undefined&&typeof next!=='string'&&typeof next!=='number'&&typeof next!=='boolean')throw new Error('LEDGER_WRITE_VALUE_INVALID');
    if(typeof next==='number'&&!Number.isFinite(next))throw new Error('LEDGER_WRITE_VALUE_INVALID');
  }
  const row:Array<unknown>=Array(size[identity.kind]).fill(null);
  if(mode==='CANCEL_DETAIL'){
    if(guard.fields.length!==2||!guard.fields.includes(16)||!guard.fields.includes(19)||values[16]!=='CANCELLED'||typeof values[19]!=='string'||!values[19])throw new Error('LEDGER_CANCEL_INVALID');
    row[16]=values[16];row[19]=values[19];
  }else{
    for(const i of guard.fields){
      // JSON null would mean 'skip', which can leave stale old data. Clear
      // D1 nulls explicitly for writable fields; never write A/B identity.
      row[i]=values[i]??'';
    }
  }
  return {dataFilter:{developerMetadataLookup:{metadataId}},majorDimension:'ROWS',values:[row]};
}
