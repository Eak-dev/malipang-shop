import type {RawSourceProof} from './raw-source-proof';
import type {LedgerUatAppendSnapshot} from './ledger-uat-append-planner';
import {planPersonalRawEnrollment} from './personal-raw-enrollment-plan';

/** An already-authenticated provider reader must separately establish these
 * observations. In particular, a 404, timeout, partial grid, or caller-supplied
 * string is not proof of absence. This model never sends or authorizes a
 * mutation and does not return a physical row position. */
export type HistoricalMarkerObservation=
  |{kind:'ABSENT';metadataId:number}
  |{kind:'PRESENT';metadataId:number;metadataKey:string;visibility:string;sheetId:number;dimension:string;startIndex:number;endIndex:number};
export type HistoricalMarkerClassification='MARKER_ABSENT_REVIEW'|'MARKER_WRONG_ROW_REVIEW'|'EVIDENCE_UNAVAILABLE';
export function classifyHistoricalMarkerReview(source:RawSourceProof,sheetId:number,metadataId:number,snapshot:LedgerUatAppendSnapshot,owner:{spreadsheetId:string;sheetName:string;kind:string;entityId:string;metadataId:number},scope:{spreadsheetId:string;sheetName:string},observation:HistoricalMarkerObservation):HistoricalMarkerClassification{
  try{
    if(!scope.spreadsheetId||!scope.sheetName||owner.spreadsheetId!==scope.spreadsheetId||owner.sheetName!==scope.sheetName||owner.kind!=='PERSONAL_USE'||owner.entityId!==source.entityId||owner.metadataId!==metadataId||!observation||observation.metadataId!==metadataId)return 'EVIDENCE_UNAVAILABLE';
    // This validates every row/header, requires exactly one matching source ID,
    // checks all 15 entered fields and rejects formulas/notes/validation and
    // any target-row metadata. The index remains local and is never returned.
    const planned=planPersonalRawEnrollment(source,sheetId,metadataId,snapshot),target=planned.createDeveloperMetadata.developerMetadata.location.dimensionRange.startIndex;
    if(!Array.isArray(snapshot.rowMetadataIds)||snapshot.rowMetadataIds.length!==snapshot.rowCount||snapshot.rowMetadataIds.some((ids,index)=>!Array.isArray(ids)||ids.some(id=>!Number.isSafeInteger(id)||id<1||id>2147483647)||snapshot.rowHasMetadata?.[index]!==Boolean(ids.length))||new Set(snapshot.rowMetadataIds.flat()).size!==snapshot.rowMetadataIds.flat().length)return 'EVIDENCE_UNAVAILABLE';
    const occurrences=snapshot.rowMetadataIds.flat().filter(id=>id===metadataId).length;
    if(observation.kind==='ABSENT')return occurrences===0?'MARKER_ABSENT_REVIEW':'EVIDENCE_UNAVAILABLE';
    if(observation.kind!=='PRESENT'||observation.metadataKey!=='P'||observation.visibility!=='DOCUMENT'||observation.sheetId!==sheetId||observation.dimension!=='ROWS'||!Number.isSafeInteger(observation.startIndex)||observation.startIndex<1||observation.startIndex>=snapshot.rowCount||observation.endIndex!==observation.startIndex+1||observation.startIndex===target||occurrences!==1||snapshot.rowMetadataIds[observation.startIndex]?.length!==1||snapshot.rowMetadataIds[observation.startIndex]?.[0]!==metadataId)return 'EVIDENCE_UNAVAILABLE';
    // This does not establish who controls the other row or permit deletion.
    return 'MARKER_WRONG_ROW_REVIEW';
  }catch{return 'EVIDENCE_UNAVAILABLE';}
}
