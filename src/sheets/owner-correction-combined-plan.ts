import {buildMetadataRowPatchRequest,type MetadataRowPatch} from "./client";
import {ownerCorrectionRowPatches,planOwnerCorrectionSheet} from "./owner-correction-plan";
import {planOwnerCorrectionProjections} from "./owner-correction-projections";

const writableColumns=[1,2,3,4,5,6,7,10,11,12,13,14,15,16,21,22];
type SheetInput=Parameters<typeof planOwnerCorrectionSheet>[0];
type ProjectionInput=Parameters<typeof planOwnerCorrectionProjections>[0];

/** A combined plan does no I/O and does not itself authorize mutation. */
export function planOwnerCorrectionCombined(input:{sheet:SheetInput;projection:ProjectionInput;sourceMetadataId:number;destinationMetadataId:number}):{patches:MetadataRowPatch[];request:unknown}{
  const {sheet,projection}=input;
  if(JSON.stringify(sheet.before)!==JSON.stringify(projection.before)||JSON.stringify(sheet.after)!==JSON.stringify(projection.after))throw new Error("CORRECTION_PROJECTION_SNAPSHOT_MISMATCH");
  const daily=planOwnerCorrectionSheet(sheet),dailyPatches=ownerCorrectionRowPatches(daily,input.sourceMetadataId,input.destinationMetadataId),other=planOwnerCorrectionProjections(projection),patches=[...dailyPatches,...other];
  // This also rejects overlapping metadata IDs before any external dispatch.
  return {patches,request:buildMetadataRowPatchRequest(patches,writableColumns)};
}
