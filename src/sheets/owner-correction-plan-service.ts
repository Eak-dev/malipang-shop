import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {getSheetId,getSheetValues,readSheetRowsByMetadata} from "./client";
import {findMonthBlocks} from "./daily-expense";
import {inspectOwnerCorrectionExistingTargets} from "./owner-correction-bootstrap-service";
import {planOwnerCorrectionCombined} from "./owner-correction-combined-plan";
import {inspectOwnerCorrectionTargets} from "./owner-correction-inspection";
import {classifyCorrectionPatchOutcome} from "./owner-correction-recovery";
import {correctionRawPatchMatches,serializeCorrectionSyncPlan,type CorrectionSyncPlan} from "./owner-correction-sync-plan";
import {loadExpenseDailyPosting} from "./sync";

interface Ports {
  existing:typeof inspectOwnerCorrectionExistingTargets;
  values:typeof getSheetValues;
  sheetId:typeof getSheetId;
  rows:typeof readSheetRowsByMetadata;
  expense:typeof loadExpenseDailyPosting;
  inspect:typeof inspectOwnerCorrectionTargets;
}
const defaults:Ports={existing:inspectOwnerCorrectionExistingTargets,values:getSheetValues,sheetId:getSheetId,rows:readSheetRowsByMetadata,expense:loadExpenseDailyPosting,inspect:inspectOwnerCorrectionTargets};
const quote=(name:string)=>`'${name.replace(/'/g,"''")}'`;
function matches(record:Record<string,unknown>,s:OwnerCorrectionSnapshot):boolean{
  return record.expense_id===s.expenseId&&record.status===s.status&&Number(record.version)===s.version&&(record.updated_at??null)===s.updatedAt&&record.description===s.description&&record.category===s.category&&Number(record.amount_satang)===s.amountSatang&&record.transaction_date===s.transactionDate&&record.payment_key===s.paymentKey&&record.source_wallet===s.sourceWallet;
}

/** Read-only planner for changes that remain in the same posting month.
 * It deliberately rejects moves: those need a separately fenced reservation. */
export async function prepareSameMonthCorrectionPlan(env:Env,before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot,correctionId:string,ports:Ports=defaults):Promise<CorrectionSyncPlan|null>{
  if(!correctionId||before.expenseId!==after.expenseId||before.status!=="CONFIRMED")return null;
  const links=await ports.existing(env,before);if(!links)return null;
  const daily=links.filter(link=>link.target.key==="malipang_expense_daily"),raw=links.filter(link=>link.target.key==="malipang_expense_raw"),details=links.filter(link=>link.target.key==="malipang_expense_item");
  if(daily.length!==1||raw.length!==1||links.length!==2+details.length||new Set(links.map(link=>link.metadataId)).size!==links.length)return null;
  const [body,rows,posting,detailSheetId]=await Promise.all([ports.values(env,`${quote(env.SHEET_EXPENSE_DAILY)}!A:W`),ports.rows(env,links.map(link=>link.metadataId)),ports.expense(env,before.expenseId),ports.sheetId(env,env.SHEET_PURCHASE_DETAILS||"รายละเอียดการซื้อ")]);
  if(!matches(posting.expense,before)||rows.size!==links.length)return null;
  const d=daily[0]!,r=raw[0]!,source=rows.get(d.metadataId),rawValues=rows.get(r.metadataId),year=Number(body[4]?.[0]);
  if(!source||!rawValues||!Number.isSafeInteger(year)||year<2000)return null;
  const projectionRow=(link:typeof d)=>({metadataId:link.metadataId,metadataKey:link.target.key,metadataValue:link.target.value,sheetId:link.target.sheetId,values:rows.get(link.metadataId)||[]});
  const built=planOwnerCorrectionCombined({sheet:{before,after,headers:body.slice(0,3),source:{rowNumber:d.target.rowIndex+1,sheetYear:year,metadataExpenseId:d.target.value,values:source},destination:null,blocks:findMonthBlocks(body)},projection:{before,after,rawSheetId:r.target.sheetId,detailSheetId,raw:projectionRow(r),details:details.map(projectionRow),document:posting.document,items:posting.items,requireOriginal:true},sourceMetadataId:d.metadataId,destinationMetadataId:d.metadataId});
  const plan:CorrectionSyncPlan={expenseId:before.expenseId,dailyMetadataId:d.metadataId,rawMetadataId:r.metadataId,patches:built.patches,originalRows:built.patches.map(row=>({metadataId:row.metadataId,values:rows.get(row.metadataId)||[]})),rebind:null};
  if(!serializeCorrectionSyncPlan(plan,before.expenseId,correctionId)||!correctionRawPatchMatches(plan,before,after))return null;
  const [verified,latest,linksAfter]=await Promise.all([ports.inspect(env,plan),ports.expense(env,before.expenseId),ports.existing(env,before)]);
  if(JSON.stringify(linksAfter)!==JSON.stringify(links)||!matches(latest.expense,before)||!verified.identitiesVerified||classifyCorrectionPatchOutcome(plan.patches,new Map(plan.originalRows.map(row=>[row.metadataId,row.values])),verified.rows)!=="BEFORE")return null;
  return plan;
}
