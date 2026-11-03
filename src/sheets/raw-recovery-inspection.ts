import type {Env} from '../types';
import {verifyLedgerMetadataWitness,type LedgerWriteIdentity,type LedgerMetadataWitness,type LedgerCellState} from './ledger-metadata-writer';
import {baselineMatches,type LedgerBaseline,type LedgerCellValue} from './ledger-stable-journal';
import {rawProjectionValuesMatch,rawSourceStillMatches,type RawSourceProof} from './raw-source-proof';

export type RawRecoveryObservation='MATCHES_DESIRED'|'MATCHES_BASELINE'|'MATCHES_BOTH'|'DIFFERS'|'SOURCE_CHANGED_OR_UNAVAILABLE'|'UNAVAILABLE';
export interface RawRecoveryInspection{status:'REVIEW';observation:RawRecoveryObservation;}
/**
 * Read-only evidence for investigating an ambiguous metadata write. This never
 * releases an intent, proves who wrote a value, grants a retry, or completes
 * a sync job. Caller must provide a fresh authenticated provider observation;
 * metadata/values can move or change after this check. Never log cell values.
 */
export async function inspectRawRecovery(env:Env,source:RawSourceProof,identity:LedgerWriteIdentity,witness:LedgerMetadataWitness,expectedMetadataId:number,identityRows:unknown[][],cells:readonly LedgerCellState[],baseline:LedgerBaseline):Promise<RawRecoveryInspection>{
  const result=(observation:RawRecoveryObservation):RawRecoveryInspection=>({status:'REVIEW',observation});
  try{
    if(identity.kind!==source.kind||identity.entityId!==source.entityId||identity.itemId!==undefined||!Number.isSafeInteger(expectedMetadataId)||witness.metadataId!==expectedMetadataId)throw Error('RAW_RECOVERY_ID_INVALID');
    verifyLedgerMetadataWitness(identity,witness,identityRows);
    const size=source.kind==='EXPENSE'?17:source.kind==='PERSONAL_USE'?15:0;
    if(!size||!Array.isArray(cells)||cells.length!==size||!baseline||typeof baseline!=='object'||Array.isArray(baseline))throw Error('RAW_RECOVERY_INVALID');
    if(cells[0]?.entered!==identity.entityId)throw Error('RAW_RECOVERY_ID_INVALID');
    const keys=Object.keys(baseline);if(keys.length!==size-1||keys.some(k=>!/^[1-9]\d*$/.test(k)||Number(k)>=size||!/^[0-9a-f]{64}$/.test(baseline[k]!)))throw Error('RAW_RECOVERY_BASELINE_INVALID');
    const current:Record<string,LedgerCellValue>={};
    for(let i=0;i<size;i++){
      const cell=cells[i];if(!cell||cell.formula!==null||cell.note!==null||cell.hasValidation!==false||!('entered' in cell))throw Error('RAW_RECOVERY_CELL_UNCERTAIN');
      if(i>0)current[String(i)]=cell.entered;
    }
    if(!await rawSourceStillMatches(env,source))return result('SOURCE_CHANGED_OR_UNAVAILABLE');
    const desired=rawProjectionValuesMatch(source,cells),previous=await baselineMatches(baseline,current);
    return result(desired&&previous?'MATCHES_BOTH':desired?'MATCHES_DESIRED':previous?'MATCHES_BASELINE':'DIFFERS');
  }catch{return result('UNAVAILABLE');}
}
