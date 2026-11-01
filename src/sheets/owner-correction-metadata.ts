export interface CategoryMetadataTarget {sheetId:number;rowIndex:number;key:string;value:string}
export interface CategoryExistingMetadata extends CategoryMetadataTarget {metadataId:number}
export type CategoryMetadataPlan=
  | {kind:"EXISTING";target:CategoryMetadataTarget;metadataId:number}
  | {kind:"CREATE";target:CategoryMetadataTarget;request:unknown}
  | {kind:"CONFLICT";target:CategoryMetadataTarget;reason:string};

/** The caller proves the row identity before requesting a metadata association. */
export function planCategoryMetadata(targets:CategoryMetadataTarget[],existing:CategoryExistingMetadata[]):CategoryMetadataPlan[]{
  return targets.map(target=>{
    if(!Number.isSafeInteger(target.sheetId)||target.sheetId<0||!Number.isSafeInteger(target.rowIndex)||target.rowIndex<0||!target.key||!target.value)return {kind:"CONFLICT",target,reason:"INVALID_TARGET"};
    if(targets.filter(t=>t.sheetId===target.sheetId&&t.rowIndex===target.rowIndex&&t.key===target.key).length!==1||targets.filter(t=>t.key===target.key&&t.value===target.value).length!==1)return {kind:"CONFLICT",target,reason:"DUPLICATE_TARGET"};
    const byIdentity=existing.filter(m=>m.key===target.key&&m.value===target.value),byRow=existing.filter(m=>m.key===target.key&&m.sheetId===target.sheetId&&m.rowIndex===target.rowIndex);
    if(byIdentity.length>1||byRow.length>1)return {kind:"CONFLICT",target,reason:"AMBIGUOUS_METADATA"};
    if(byIdentity.length===1){const found=byIdentity[0]!;if(found.sheetId!==target.sheetId||found.rowIndex!==target.rowIndex||byRow[0]?.metadataId!==found.metadataId||!Number.isSafeInteger(found.metadataId)||found.metadataId<1)return {kind:"CONFLICT",target,reason:"METADATA_IDENTITY_MISMATCH"};return {kind:"EXISTING",target,metadataId:found.metadataId};}
    if(byRow.length)return {kind:"CONFLICT",target,reason:"ROW_ALREADY_LINKED"};
    return {kind:"CREATE",target,request:{createDeveloperMetadata:{developerMetadata:{metadataKey:target.key,metadataValue:target.value,visibility:"DOCUMENT",location:{dimensionRange:{sheetId:target.sheetId,dimension:"ROWS",startIndex:target.rowIndex,endIndex:target.rowIndex+1}}}}}};
  });
}
