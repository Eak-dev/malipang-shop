import type {MetadataRowPatch} from "./client";

export type CorrectionPatchOutcome="BEFORE"|"AFTER"|"CONFLICT";
const norm=(value:unknown)=>value===undefined||value===null?"":value;

/**
 * Caller must independently verify each metadata identity and wait out any
 * possibly in-flight Sheets request before acting on BEFORE. A mixed or
 * unexpected state is never considered safely retryable.
 */
export function classifyCorrectionPatchOutcome(patches:MetadataRowPatch[],original:Map<number,unknown[]>,observed:Map<number,unknown[]>):CorrectionPatchOutcome{
  if(!patches.length||new Set(patches.map(p=>p.metadataId)).size!==patches.length)return "CONFLICT";
  let allBefore=true,allAfter=true;
  for(const patch of patches){
    const prior=original.get(patch.metadataId),current=observed.get(patch.metadataId);
    if(!Number.isSafeInteger(patch.metadataId)||patch.metadataId<1||!prior||!current||!patch.cells.length||new Set(patch.cells.map(c=>c.columnIndex)).size!==patch.cells.length)return "CONFLICT";
    for(const cell of patch.cells){
      if(!Number.isSafeInteger(cell.columnIndex)||cell.columnIndex<0||cell.columnIndex>25)return "CONFLICT";
      if(norm(current[cell.columnIndex])!==norm(prior[cell.columnIndex]))allBefore=false;
      if(norm(current[cell.columnIndex])!==norm(cell.value))allAfter=false;
    }
  }
  return allAfter?"AFTER":allBefore?"BEFORE":"CONFLICT";
}
