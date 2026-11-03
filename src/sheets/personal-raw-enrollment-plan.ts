import type {LedgerUatAppendSnapshot} from './ledger-uat-append-planner';
import type {LedgerCellState} from './ledger-metadata-writer';
import {RAW_PROJECTION_HEADERS} from './raw-projection';
import {rawProjectionValuesMatch,type RawSourceProof} from './raw-source-proof';
/** A request derived from a single fresh provider snapshot. It is not proof of
 * exclusivity or permission to send and its row index must never be persisted. */
export function planPersonalRawEnrollment(source:RawSourceProof,sheetId:number,metadataId:number,snapshot:LedgerUatAppendSnapshot):{createDeveloperMetadata:{developerMetadata:{metadataId:number;metadataKey:'P';visibility:'DOCUMENT';location:{dimensionRange:{sheetId:number;dimension:'ROWS';startIndex:number;endIndex:number}}}}}{
  if(!source||source.kind!=='PERSONAL_USE'||!/^personal_[A-Za-z0-9_-]{1,128}$/.test(source.entityId)||!Number.isSafeInteger(sheetId)||sheetId<0||!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647||!snapshot||snapshot.sheetId!==sheetId||!Number.isSafeInteger(snapshot.rowCount)||snapshot.rowCount<2||snapshot.rowCount>=10000||!Number.isSafeInteger(snapshot.columnCount)||snapshot.columnCount<15||snapshot.columnCount>64||(snapshot.rowCount+1)*snapshot.columnCount>50000||snapshot.hasProtectedRanges!==false||snapshot.hasMerges!==false||!Array.isArray(snapshot.rows)||snapshot.rows.length!==snapshot.rowCount)throw Error('PERSONAL_ENROLLMENT_GRID_INVALID');
  let found=-1;for(let r=0;r<snapshot.rowCount;r++){
    const row=snapshot.rows[r];if(!row||row.length!==snapshot.columnCount)throw Error('PERSONAL_ENROLLMENT_GRID_INVALID');
    if(r===0&&!RAW_PROJECTION_HEADERS.PERSONAL_USE.every((name,i)=>row[i]?.entered===name&&row[i]?.formula===null))throw Error('PERSONAL_ENROLLMENT_HEADER_INVALID');
    if(row[0]?.formula!==null)throw Error('PERSONAL_ENROLLMENT_ID_INVALID');
    if(r>0&&row[0]?.entered===source.entityId){if(found!==-1)throw Error('PERSONAL_ENROLLMENT_DUPLICATE');found=r;}
  }
  if(found<0)throw Error('PERSONAL_ENROLLMENT_MISSING');if(!Array.isArray(snapshot.rowHasMetadata)||snapshot.rowHasMetadata.length!==snapshot.rowCount||snapshot.rowHasMetadata.some(v=>typeof v!=='boolean')||snapshot.rowHasMetadata[found])throw Error('PERSONAL_ENROLLMENT_METADATA_UNSAFE');const cells=snapshot.rows[found]!.slice(0,15);
  if(cells.some((cell:LedgerCellState)=>!cell||cell.note!==null||cell.hasValidation!==false||cell.formula!==null)||!rawProjectionValuesMatch(source,cells))throw Error('PERSONAL_ENROLLMENT_PREIMAGE_INVALID');
  return {createDeveloperMetadata:{developerMetadata:{metadataId,metadataKey:'P',visibility:'DOCUMENT',location:{dimensionRange:{sheetId,dimension:'ROWS',startIndex:found,endIndex:found+1}}}}};
}
