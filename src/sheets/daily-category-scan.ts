import {findUnambiguousDailyCategoryIdentities,type DailyCategoryIdentity,type DailyCategorySheetRow} from "./daily-category-identity";
import {observeDailyCategory,type CategoryObservation,type CategorySnapshot} from "./daily-category-review";

export interface CategoryScanExpense extends DailyCategoryIdentity {category:string;version:number;fingerprint:string;transactionDate:string}
export interface CategoryScanRow extends DailyCategorySheetRow {metadataId:number|null;metadataExpenseId:string|null}
export interface CategoryScanResult {expenseId:string;rowNumber:number;metadataId:number|null;observation:CategoryObservation}
export interface CategoryScanBaseline extends CategorySnapshot {rowNumber:number;metadataId:number;fingerprint:string}

/**
 * Caller supplies all relevant confirmed expenses and all rows, including
 * duplicates. Missing, duplicate, or foreign metadata never authorizes a
 * request. This pure planner does not write Sheet or D1 data.
 */
export function planDailyCategoryScan(expenses:CategoryScanExpense[],rows:CategoryScanRow[],baselines:Map<string,CategoryScanBaseline>):CategoryScanResult[]{
  const matches=findUnambiguousDailyCategoryIdentities(expenses,rows),expenseById=new Map(expenses.map(e=>[e.expenseId,e])),rowByNumber=new Map(rows.map(r=>[r.rowNumber,r]));
  const duplicateExpenseIds=new Set(expenses.filter((item,i)=>expenses.findIndex(other=>other.expenseId===item.expenseId)!==i).map(item=>item.expenseId));
  const duplicateMetadata=new Set(rows.filter((item,i)=>item.metadataId!=null&&rows.findIndex(other=>other.metadataId===item.metadataId)!==i).map(item=>item.metadataId));
  return matches.map(match=>{
    const expense=expenseById.get(match.expenseId)!,row=rowByNumber.get(match.rowNumber)!;
    const baseline=baselines.get(expense.expenseId)||null;
    const baselineIdentityValid=!baseline||(baseline.rowNumber===row.rowNumber&&baseline.metadataId===row.metadataId&&baseline.fingerprint===expense.fingerprint);
    const metadataValid=!duplicateExpenseIds.has(expense.expenseId)&&Number.isSafeInteger(row.metadataId)&&Number(row.metadataId)>0&&!duplicateMetadata.has(row.metadataId)&&row.metadataExpenseId===expense.expenseId&&Boolean(expense.fingerprint)&&baselineIdentityValid;
    const observation=observeDailyCategory({identityVerified:metadataValid,observed:String(row.values[21]??""),current:{category:expense.category,version:expense.version},baseline});
    return {expenseId:expense.expenseId,rowNumber:row.rowNumber,metadataId:row.metadataId,observation};
  });
}
