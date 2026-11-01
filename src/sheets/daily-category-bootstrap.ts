import {findUnambiguousDailyCategoryIdentities,type DailyCategoryIdentity,type DailyCategorySheetRow} from "./daily-category-identity";
import {planCategoryMetadata,type CategoryExistingMetadata,type CategoryMetadataTarget} from "./daily-category-metadata";

export interface CategoryBootstrapExpense extends DailyCategoryIdentity {category:string;transactionDate:string;version:number;itemIds:string[]}
export interface CategoryBootstrapRow extends DailyCategorySheetRow {sheetId:number}
export interface CategoryBootstrapProjectionRow {sheetId:number;rowNumber:number;values:unknown[]}
export interface CategoryBootstrapResult {expenseId:string;kind:"READY"|"CONFLICT";reason?:string;targets:CategoryMetadataTarget[]}

/** Never plan metadata for an ambiguous row, historical mismatch or incomplete projection. */
export function planDailyCategoryBootstrap(expenses:CategoryBootstrapExpense[],dailyRows:CategoryBootstrapRow[],rawRows:CategoryBootstrapProjectionRow[],detailRows:CategoryBootstrapProjectionRow[],existing:CategoryExistingMetadata[]):CategoryBootstrapResult[]{
  const matches=findUnambiguousDailyCategoryIdentities(expenses,dailyRows),byExpense=new Map(matches.map(match=>[match.expenseId,match.rowNumber]));
  return expenses.map(expense=>{
    const conflict=(reason:string):CategoryBootstrapResult=>({expenseId:expense.expenseId,kind:"CONFLICT",reason,targets:[]});
    const rowNumber=byExpense.get(expense.expenseId),daily=dailyRows.find(row=>row.rowNumber===rowNumber);
    if(!daily)return conflict("DAILY_IDENTITY_AMBIGUOUS");
    if(String(daily.values[21]??"").trim()!==expense.category)return conflict("DAILY_CATEGORY_DIFFERS");
    const raws=rawRows.filter(row=>row.values[0]===expense.expenseId);
    if(raws.length!==1)return conflict("RAW_IDENTITY_AMBIGUOUS");
    const raw=raws[0]!,rawAmount=Number(raw.values[3]);
    if(raw.values[1]!==expense.transactionDate||String(raw.values[2]??"").trim()!==expense.description.trim()||!Number.isFinite(rawAmount)||Math.round(rawAmount*100)!==expense.amountSatang||raw.values[6]!==expense.category||raw.values[7]!=="CONFIRMED")return conflict("RAW_SNAPSHOT_DIFFERS");
    if(new Set(expense.itemIds).size!==expense.itemIds.length)return conflict("DUPLICATE_ITEM_IDS");
    const details=detailRows.filter(row=>row.values[1]===expense.expenseId),detailIds=details.map(row=>String(row.values[0]??""));
    if(details.length!==expense.itemIds.length||new Set(detailIds).size!==details.length||expense.itemIds.some(id=>!detailIds.includes(id))||details.some(row=>row.values[14]!==expense.category||row.values[16]!=="CONFIRMED"))return conflict("DETAIL_SNAPSHOT_DIFFERS");
    const targets:CategoryMetadataTarget[]=[{sheetId:daily.sheetId,rowIndex:daily.rowNumber-1,key:"malipang_expense_daily",value:expense.expenseId},
      {sheetId:raw.sheetId,rowIndex:raw.rowNumber-1,key:"malipang_expense_raw",value:expense.expenseId},
      ...details.map(row=>({sheetId:row.sheetId,rowIndex:row.rowNumber-1,key:"malipang_expense_item",value:String(row.values[0])}))];
    const plans=planCategoryMetadata(targets,existing);if(plans.some(plan=>plan.kind==="CONFLICT"))return conflict("METADATA_CONFLICT");
    return {expenseId:expense.expenseId,kind:"READY",targets};
  });
}
