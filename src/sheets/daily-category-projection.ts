import type {MetadataColumnWrite} from "./client";
import {expenseCategories} from "../expense/document";

export interface MetadataRow {metadataId:number;sheetId:number;metadataKey:string;metadataValue:string;values:unknown[]}
export interface CategoryProjection {
  expenseId:string;expenseVersion:number;jobVersion:number;status:string;
  fromCategory:string;toCategory:string;currentCategory:string;
  rawSheetId:number;detailSheetId:number;
  raw:MetadataRow;details:MetadataRow[];expectedItemIds:string[];
}

/**
 * Build category-only writes after reading each target by its unique metadata
 * ID. Reject changed, missing, duplicate, or unrelated rows before dispatch.
 */
export function planDailyCategoryProjection(input:CategoryProjection):MetadataColumnWrite[]{
  const {expenseId,expenseVersion,jobVersion,status,fromCategory,toCategory,currentCategory,raw,details,expectedItemIds,rawSheetId,detailSheetId}=input;
  if(!expenseId||status!=="CONFIRMED"||!Number.isSafeInteger(jobVersion)||jobVersion<1||expenseVersion!==jobVersion||currentCategory!==toCategory||!expenseCategories.has(fromCategory)||!expenseCategories.has(toCategory)||fromCategory===toCategory)throw new Error("CATEGORY_PROJECTION_STALE");
  const allowed=(value:unknown)=>value===fromCategory||value===toCategory;
  if(!Number.isSafeInteger(rawSheetId)||rawSheetId<0||!Number.isSafeInteger(detailSheetId)||detailSheetId<0||rawSheetId===detailSheetId||!Number.isSafeInteger(raw.metadataId)||raw.metadataId<1||raw.sheetId!==rawSheetId||raw.metadataKey!=="malipang_expense_raw"||raw.metadataValue!==expenseId||raw.values[0]!==expenseId||raw.values[7]!=="CONFIRMED"||!allowed(raw.values[6]))throw new Error("CATEGORY_RAW_IDENTITY_MISMATCH");
  const expected=new Set(expectedItemIds),seenItems=new Set<string>(),seenMetadata=new Set<number>([raw.metadataId]);
  if(expected.size!==expectedItemIds.length||details.length!==expected.size)throw new Error("CATEGORY_DETAIL_SET_MISMATCH");
  for(const detail of details){
    const itemId=String(detail.values[0]??"");
    if(!Number.isSafeInteger(detail.metadataId)||detail.metadataId<1||seenMetadata.has(detail.metadataId)||detail.sheetId!==detailSheetId||detail.metadataKey!=="malipang_expense_item"||detail.metadataValue!==itemId||!expected.has(itemId)||seenItems.has(itemId)||detail.values[1]!==expenseId||detail.values[16]!=="CONFIRMED"||!allowed(detail.values[14]))throw new Error("CATEGORY_DETAIL_IDENTITY_MISMATCH");
    seenMetadata.add(detail.metadataId);seenItems.add(itemId);
  }
  return [{metadataId:raw.metadataId,columnIndex:6,value:toCategory},...details.map(detail=>({metadataId:detail.metadataId,columnIndex:14,value:toCategory}))];
}
