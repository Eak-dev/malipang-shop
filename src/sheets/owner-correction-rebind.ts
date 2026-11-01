import type {SheetRowMetadata} from "./client";

/** The reservation must be a private correction-specific marker, not another expense. */
export function buildOwnerCorrectionRebind(input:{expenseId:string;correctionId:string;source:SheetRowMetadata;reservation:SheetRowMetadata}):unknown[]{
  const {expenseId,correctionId,source,reservation}=input;
  if(!expenseId||!correctionId||source.metadataKey!=="malipang_expense_daily"||source.metadataValue!==expenseId||reservation.metadataKey!=="malipang_correction_reservation"||reservation.metadataValue!==correctionId||!Number.isSafeInteger(source.metadataId)||source.metadataId<1||!Number.isSafeInteger(reservation.metadataId)||reservation.metadataId<1||source.metadataId===reservation.metadataId||!Number.isSafeInteger(source.sheetId)||source.sheetId<0||source.sheetId!==reservation.sheetId||!Number.isSafeInteger(source.rowIndex)||source.rowIndex<0||!Number.isSafeInteger(reservation.rowIndex)||reservation.rowIndex<0||source.rowIndex===reservation.rowIndex)throw new Error("CORRECTION_REBIND_IDENTITY_INVALID");
  return [
    {updateDeveloperMetadata:{dataFilters:[{developerMetadataLookup:{metadataId:source.metadataId}}],developerMetadata:{location:{dimensionRange:{sheetId:reservation.sheetId,dimension:"ROWS",startIndex:reservation.rowIndex,endIndex:reservation.rowIndex+1}}},fields:"location"}},
    {deleteDeveloperMetadata:{dataFilter:{developerMetadataLookup:{metadataId:reservation.metadataId}}}}
  ];
}

/** Identity and both relevant rows must be re-read before acting on this result. */
export function classifyOwnerCorrectionRebind(input:{expenseId:string;correctionId:string;source:SheetRowMetadata|null;reservation:SheetRowMetadata|null;sourceRowIndex:number;destinationRowIndex:number;sheetId:number}):"BEFORE"|"AFTER"|"CONFLICT"{
  const {expenseId,correctionId,source,reservation,sourceRowIndex,destinationRowIndex,sheetId}=input;
  if(!expenseId||!correctionId||!source||!Number.isSafeInteger(source.metadataId)||source.metadataId<1||!Number.isSafeInteger(sheetId)||sheetId<0||source.metadataKey!=="malipang_expense_daily"||source.metadataValue!==expenseId||source.sheetId!==sheetId||!Number.isSafeInteger(sourceRowIndex)||!Number.isSafeInteger(destinationRowIndex)||sourceRowIndex<0||destinationRowIndex<0||sourceRowIndex===destinationRowIndex)return "CONFLICT";
  if(source.rowIndex===destinationRowIndex&&!reservation)return "AFTER";
  if(source.rowIndex===sourceRowIndex&&reservation&&Number.isSafeInteger(reservation.metadataId)&&reservation.metadataId>0&&reservation.metadataKey==="malipang_correction_reservation"&&reservation.metadataValue===correctionId&&reservation.sheetId===sheetId&&reservation.rowIndex===destinationRowIndex&&reservation.metadataId!==source.metadataId)return "BEFORE";
  return "CONFLICT";
}
