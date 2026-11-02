import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {correctionPeriodHeaderDigest} from "../expense/owner-correction-period-math";
import {getSheetId,getSheetValues,readSheetRowsByMetadata} from "./client";
import {findMonthBlocks} from "./daily-expense";
import {inspectOwnerCorrectionExistingTargets} from "./owner-correction-bootstrap-service";
import {planOwnerCorrectionCombined} from "./owner-correction-combined-plan";
import {inspectOwnerCorrectionTargets} from "./owner-correction-inspection";
import {classifyCorrectionPatchOutcome} from "./owner-correction-recovery";
import {correctionRawPatchMatches,serializeCorrectionSyncPlan,type CorrectionSyncPlan} from "./owner-correction-sync-plan";
import {loadExpenseDailyPosting} from "./sync";
import {captureOwnerCorrectionReport} from "./owner-correction-report-snapshot";
import {legacyReportCategoryMatches} from "./owner-correction-report-dedupe";
import type {CorrectionReportView} from "./owner-correction-report-view";

interface Ports {
  existing:typeof inspectOwnerCorrectionExistingTargets;
  values:typeof getSheetValues;
  sheetId:typeof getSheetId;
  rows:typeof readSheetRowsByMetadata;
  expense:typeof loadExpenseDailyPosting;
  inspect:typeof inspectOwnerCorrectionTargets;
}

/** A report baseline is required before a same-month plan may be committed. */
export async function prepareVerifiedSameMonthCorrectionPlan(env:Env,before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot,correctionId:string,ports:{plan:typeof prepareSameMonthCorrectionPlan;report:typeof captureOwnerCorrectionReport}={plan:prepareSameMonthCorrectionPlan,report:captureOwnerCorrectionReport},view?:CorrectionReportView):Promise<CorrectionSyncPlan|{kind:"LEGACY_BANK"}|null>{
  // A single selected month cannot prove both sides of a calendar-month move.
  if(before.transactionDate.slice(0,7)!==after.transactionDate.slice(0,7)||!legacyReportCategoryMatches(before)||!legacyReportCategoryMatches(after))return null;
  const plan=await ports.plan(env,before,after,correctionId);if(!plan||plan.rebind)return null;
  const first=await ports.report(env,before,plan.dailyMetadataId,undefined,view),second=await ports.report(env,before,plan.dailyMetadataId,undefined,view);
  if(!first||!second||JSON.stringify(first)!==JSON.stringify(second))return null;
  // The legacy bank panel explicitly says it is awaiting verification. Do not
  // change amounts or funding until that report can independently verify them.
  if(first.bankTotal===null&&(before.amountSatang!==after.amountSatang||before.paymentKey!==after.paymentKey||before.sourceWallet!==after.sourceWallet))return {kind:"LEGACY_BANK"};
  const verified={...plan,reportBaseline:first};return serializeCorrectionSyncPlan(verified,before.expenseId,correctionId)?verified:null;
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
  // Do not rewrite unchanged inputs: a category edit, for example, must not
  // clear and re-enter a payment amount while another person is using Sheets.
  const blank=(value:unknown)=>value===null||value===undefined||value==="";
  const patches=built.patches.map(patch=>patch.metadataId!==d.metadataId?patch:{...patch,cells:patch.cells.filter(cell=>!(source[cell.columnIndex]===cell.value||(blank(source[cell.columnIndex])&&cell.value==="")||(source[cell.columnIndex]===0&&cell.value==="")))});
  // A same-month date can clamp to the same posting day; until that case has
  // a separately verified observation-only row, do not manufacture a write.
  if(patches.some(patch=>patch.cells.length===0))return null;
  const plan:CorrectionSyncPlan={expenseId:before.expenseId,dailyMetadataId:d.metadataId,rawMetadataId:r.metadataId,patches,originalRows:patches.map(row=>({metadataId:row.metadataId,values:rows.get(row.metadataId)||[]})),rebind:null,headerDigest:await correctionPeriodHeaderDigest(body.slice(0,3))};
  if(!serializeCorrectionSyncPlan(plan,before.expenseId,correctionId)||!correctionRawPatchMatches(plan,before,after))return null;
  const [verified,latest,linksAfter]=await Promise.all([ports.inspect(env,plan),ports.expense(env,before.expenseId),ports.existing(env,before)]);
  if(JSON.stringify(linksAfter)!==JSON.stringify(links)||!matches(latest.expense,before)||!verified.identitiesVerified||classifyCorrectionPatchOutcome(plan.patches,new Map(plan.originalRows.map(row=>[row.metadataId,row.values])),verified.rows)!=="BEFORE")return null;
  return plan;
}
