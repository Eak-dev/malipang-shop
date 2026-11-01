import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {legacySourceWallet,resolvePayment} from "./daily-expense";
import {isIsoDate} from "../shared/time";
import type {DailyExpenseDocumentItem} from "./daily-expense";
import {buildPurchaseDetailEntries,type PurchaseDetailDocument,type PurchaseDetailRecord} from "./purchase-details";
import {findUnambiguousOwnerCorrectionIdentities,type OwnerCorrectionIdentity,type OwnerCorrectionSheetRow} from "./owner-correction-identity";
import {planCategoryMetadata,type CategoryExistingMetadata,type CategoryMetadataTarget} from "./owner-correction-metadata";

interface SheetRow{sheetId:number;rowNumber:number;values:unknown[]}
const empty=(v:unknown)=>v===undefined||v===null?"":v;
const same=(a:unknown,b:unknown)=>empty(a)===empty(b);

/** Caller must supply complete candidate/row sets, including duplicates. */
export function planOwnerCorrectionBootstrap(input:{expense:OwnerCorrectionSnapshot;candidates:OwnerCorrectionIdentity[];dailyRows:Array<OwnerCorrectionSheetRow&{sheetId:number}>;headers:unknown[][];rawRows:SheetRow[];detailRows:SheetRow[];document:PurchaseDetailDocument|null;items:DailyExpenseDocumentItem[];existing:CategoryExistingMetadata[]}):CategoryMetadataTarget[]{
  const {expense,candidates,dailyRows,headers,rawRows,detailRows,document,items,existing}=input;
  if(expense.status!=="CONFIRMED"||candidates.filter(candidate=>candidate.expenseId===expense.expenseId).length!==1)throw new Error("CORRECTION_BOOTSTRAP_EXPENSE_INVALID");
  if(new Set(dailyRows.map(row=>row.sheetId)).size!==1||new Set(dailyRows.map(row=>row.rowNumber)).size!==dailyRows.length||new Set(dailyRows.map(row=>row.sheetYear)).size!==1||new Set(rawRows.map(row=>row.sheetId)).size!==1||(detailRows.length>0&&new Set(detailRows.map(row=>row.sheetId)).size!==1))throw new Error("CORRECTION_BOOTSTRAP_SHEET_AMBIGUOUS");
  const candidate=candidates.find(item=>item.expenseId===expense.expenseId)!;
  if(!isIsoDate(expense.transactionDate))throw new Error("CORRECTION_BOOTSTRAP_SNAPSHOT_CHANGED");
  const [year,month,day]=expense.transactionDate.split("-").map(Number),payment=resolvePayment(headers,expense.paymentKey,year!,month!,day!);
  let col=0;for(const letter of payment.amountColumn)col=col*26+letter.charCodeAt(0)-64;
  if(candidate.description!==expense.description||candidate.amountSatang!==expense.amountSatang||candidate.postingYear!==payment.postingYear||candidate.postingMonth!==payment.postingMonth||candidate.postingDay!==payment.postingDay||candidate.amountColumn!==col-1)throw new Error("CORRECTION_BOOTSTRAP_SNAPSHOT_CHANGED");
  const match=findUnambiguousOwnerCorrectionIdentities(candidates,dailyRows).find(item=>item.expenseId===expense.expenseId),daily=dailyRows.find(row=>row.rowNumber===match?.rowNumber);
  if(!daily||daily.values[21]!==expense.category||daily.values[22]!==legacySourceWallet(expense.paymentKey,expense.sourceWallet))throw new Error("CORRECTION_BOOTSTRAP_DAILY_AMBIGUOUS");
  const rawMatches=rawRows.filter(row=>row.values[0]===expense.expenseId);if(rawMatches.length!==1)throw new Error("CORRECTION_BOOTSTRAP_RAW_AMBIGUOUS");
  const raw=rawMatches[0]!,rawValues=[expense.expenseId,expense.transactionDate,expense.description,expense.amountSatang/100,expense.paymentKey,expense.sourceWallet,expense.category,"CONFIRMED"];
  if(raw.sheetId===daily.sheetId||(detailRows.length>0&&(detailRows[0]!.sheetId===raw.sheetId||detailRows[0]!.sheetId===daily.sheetId)))throw new Error("CORRECTION_BOOTSTRAP_SHEET_AMBIGUOUS");
  if(rawValues.some((value,index)=>!same(raw.values[index],value)))throw new Error("CORRECTION_BOOTSTRAP_RAW_CHANGED");
  const record:PurchaseDetailRecord={expenseId:expense.expenseId,transactionDate:expense.transactionDate,description:expense.description,amountBaht:expense.amountSatang/100,paymentKey:expense.paymentKey,sourceWallet:expense.sourceWallet,category:expense.category,branchId:"",status:"CONFIRMED",createdAt:"",updatedAt:""};
  const expected=buildPurchaseDetailEntries(record,document,items),details=detailRows.filter(row=>row.values[1]===expense.expenseId);
  if(items.length!==expected.length||details.length!==expected.length||new Set(expected.map(row=>row.itemId)).size!==expected.length)throw new Error("CORRECTION_BOOTSTRAP_DETAILS_AMBIGUOUS");
  for(const item of expected){
    const matches=details.filter(row=>row.values[0]===item.itemId);if(matches.length!==1)throw new Error("CORRECTION_BOOTSTRAP_DETAILS_AMBIGUOUS");
    for(const col of [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,16])if(!same(matches[0]!.values[col],item.values[col]))throw new Error("CORRECTION_BOOTSTRAP_DETAIL_CHANGED");
  }
  const targets:CategoryMetadataTarget[]=[{sheetId:daily.sheetId,rowIndex:daily.rowNumber-1,key:"malipang_expense_daily",value:expense.expenseId},{sheetId:raw.sheetId,rowIndex:raw.rowNumber-1,key:"malipang_expense_raw",value:expense.expenseId},...details.map(row=>({sheetId:row.sheetId,rowIndex:row.rowNumber-1,key:"malipang_expense_item",value:String(row.values[0])}))];
  if(planCategoryMetadata(targets,existing).some(item=>item.kind==="CONFLICT"))throw new Error("CORRECTION_BOOTSTRAP_METADATA_CONFLICT");
  return targets;
}
