import type {Env} from '../types';
import type {LedgerUatAppendSnapshot} from './ledger-uat-append-planner';
import type {LedgerCellState} from './ledger-metadata-writer';
import {RAW_PROJECTION_HEADERS} from './raw-projection';
import {rawProjectionValuesMatch,rawSourceStillMatches,type RawSourceProof} from './raw-source-proof';

export type LegacyRawEnrollmentObservation='SINGLE_MATCH'|'MISSING'|'DUPLICATE'|'VALUES_DIFFER'|'SCHEMA_OR_ANNOTATION_UNSAFE'|'SOURCE_CHANGED_OR_UNAVAILABLE';
/** Read-only diagnostic. Every result stays REVIEW: an exact current value
 * match is not provenance, metadata ownership, editor exclusion, or authority
 * to enroll. This function neither returns nor persists a physical row number. */
export async function auditLegacyExpenseRawEnrollment(env:Env,source:RawSourceProof,snapshot:LedgerUatAppendSnapshot):Promise<{status:'REVIEW';observation:LegacyRawEnrollmentObservation}>{
  const result=(observation:LegacyRawEnrollmentObservation)=>({status:'REVIEW' as const,observation});
  try{
    if(!source||source.kind!=='EXPENSE'||!snapshot||!Number.isSafeInteger(snapshot.sheetId)||snapshot.sheetId<0||!Number.isSafeInteger(snapshot.rowCount)||snapshot.rowCount<1||snapshot.rowCount>=10000||!Number.isSafeInteger(snapshot.columnCount)||snapshot.columnCount<17||snapshot.columnCount>64||(snapshot.rowCount+1)*snapshot.columnCount>50000||!Array.isArray(snapshot.rows)||snapshot.rows.length!==snapshot.rowCount||snapshot.hasProtectedRanges!==false||snapshot.hasMerges!==false)return result('SCHEMA_OR_ANNOTATION_UNSAFE');
    if(!await rawSourceStillMatches(env,source))return result('SOURCE_CHANGED_OR_UNAVAILABLE');
    let found:typeof snapshot.rows[number]|undefined,count=0;
    for(let r=0;r<snapshot.rowCount;r++){
      const row=snapshot.rows[r];if(!row||row.length!==snapshot.columnCount)return result('SCHEMA_OR_ANNOTATION_UNSAFE');
      if(r===0&&!RAW_PROJECTION_HEADERS.EXPENSE.every((name,i)=>row[i]?.entered===name&&row[i]?.formula===null))return result('SCHEMA_OR_ANNOTATION_UNSAFE');
      if(row[0]?.formula!==null)return result('SCHEMA_OR_ANNOTATION_UNSAFE');
      if(r>0&&row[0]?.entered===source.entityId){found=row;count++;}
    }
    if(count>1)return result('DUPLICATE');if(count===0||!found)return result('MISSING');
    const cells=found.slice(0,17) as readonly LedgerCellState[];if(cells.some(cell=>!cell||cell.note!==null||cell.hasValidation!==false||cell.formula!==null))return result('SCHEMA_OR_ANNOTATION_UNSAFE');
    if(!rawProjectionValuesMatch(source,cells))return result('VALUES_DIFFER');
    if(!await rawSourceStillMatches(env,source))return result('SOURCE_CHANGED_OR_UNAVAILABLE');
    return result('SINGLE_MATCH');
  }catch{return result('SCHEMA_OR_ANNOTATION_UNSAFE');}
}
