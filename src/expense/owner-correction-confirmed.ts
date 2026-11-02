import type {Env} from "../types";
import {enqueueSheetSync} from "../db/repositories";
import {getSheetValues} from "../sheets/client";
import {loadExpenseDailyPosting} from "../sheets/sync";
import {prepareVerifiedSameMonthCorrectionPlan} from "../sheets/owner-correction-plan-service";
import {inspectOwnerCorrectionCategoryProtection} from "../sheets/owner-correction-protection";
import {inspectOwnerCorrectionReportDeduplication} from "../sheets/owner-correction-report-inspection";
import {bootstrapStableOwnerCorrectionTargets} from "../sheets/owner-correction-stable-bootstrap";
import {ensureOwnerCorrectionCellGuards} from "../sheets/owner-correction-cell-guard-service";
import {ensureOwnerCorrectionReportView} from "../sheets/owner-correction-report-view";
import {correctionPeriodHeaderDigest,correctionPostingDate} from "./owner-correction-period-math";
import {inspectOwnerCorrectionPeriods} from "./owner-correction-periods";
import {commitOwnerCorrection,loadOwnerCorrectionDraft,ownerCorrectionStatus} from "./owner-correction-repository";
import type {OwnerCorrectionSnapshot} from "./owner-correction";
import type {OwnerReviewIdentity} from "./online-order-review-repository";

export type ConfirmedCorrectionResult="APPLIED"|"STALE"|"PERIOD_REVIEW"|"PROTECTION"|"DUPLICATE"|"ALLOCATION"|"SHEET_REVIEW"|"LEGACY_BANK_REVIEW"|"METADATA_PENDING"|"GUARD_PENDING"|"REPORT_PENDING"|"MOVE_REVIEW"|"UNSUPPORTED";
export interface ConfirmedCorrectionPorts{
  periods:typeof inspectOwnerCorrectionPeriods;
  headers:typeof getSheetValues;
  protection:typeof inspectOwnerCorrectionCategoryProtection;
  dedupe:typeof inspectOwnerCorrectionReportDeduplication;
  posting:typeof loadExpenseDailyPosting;
  bootstrap:typeof bootstrapStableOwnerCorrectionTargets;
  guards:typeof ensureOwnerCorrectionCellGuards;
  view:typeof ensureOwnerCorrectionReportView;
  plan:typeof prepareVerifiedSameMonthCorrectionPlan;
  commit:typeof commitOwnerCorrection;
  enqueue:typeof enqueueSheetSync;
  status:typeof ownerCorrectionStatus;
}
const defaults:ConfirmedCorrectionPorts={periods:inspectOwnerCorrectionPeriods,headers:getSheetValues,protection:inspectOwnerCorrectionCategoryProtection,dedupe:inspectOwnerCorrectionReportDeduplication,posting:loadExpenseDailyPosting,bootstrap:bootstrapStableOwnerCorrectionTargets,guards:ensureOwnerCorrectionCellGuards,view:ensureOwnerCorrectionReportView,plan:prepareVerifiedSameMonthCorrectionPlan,commit:commitOwnerCorrection,enqueue:enqueueSheetSync,status:ownerCorrectionStatus};
const quote=(value:string)=>`'${value.replace(/'/g,"''")}'`;

/** Prepare and commit independently verified, same-month and same-row edits. */
export async function confirmOwnerCorrection(env:Env,owner:OwnerReviewIdentity,id:string,version:number,traceId:string,ports:ConfirmedCorrectionPorts=defaults):Promise<ConfirmedCorrectionResult>{
  if(env.OWNER_EXPENSE_CORRECTION_ENABLED!=="true"||env.SHEETS_SYNC_ENABLED!=="true")return "UNSUPPORTED";
  const applied=async()=>{const state=await ports.status(env,owner,id);return state==="SYNC_PENDING"||state==="SYNC_FAILED"||state==="SYNC_REVIEW"||state==="COMPLETED";};
  const row=await loadOwnerCorrectionDraft(env,owner,id);if(!row)return await applied()?"APPLIED":"STALE";
  let before:OwnerCorrectionSnapshot,after:OwnerCorrectionSnapshot;try{before=JSON.parse(String(row.before_json)) as OwnerCorrectionSnapshot;after=JSON.parse(String(row.after_json)) as OwnerCorrectionSnapshot;}catch{return "STALE";}
  if(!before||!after||before.status!=="CONFIRMED"||before.version!==version)return "STALE";
  // A calendar or posting-month move needs a separately fenced reservation.
  if(before.transactionDate.slice(0,7)!==after.transactionDate.slice(0,7))return "UNSUPPORTED";
  const periods=await ports.periods(env,owner,id);if(!periods||periods.version!==version)return "STALE";if(periods.periods.some(item=>item.decision!=="OPEN"))return "PERIOD_REVIEW";
  if(!await ports.protection(env))return "PROTECTION";
  const headers=await ports.headers(env,`${quote(env.SHEET_EXPENSE_DAILY)}!A1:W3`);if(await correctionPeriodHeaderDigest(headers)!==periods.headerDigest)return "STALE";
  try{if(correctionPostingDate(before,headers).slice(0,7)!==correctionPostingDate(after,headers).slice(0,7))return "MOVE_REVIEW";}catch{return "SHEET_REVIEW";}
  if(!await ports.dedupe(env,before,after))return "DUPLICATE";
  const posting=await ports.posting(env,before.expenseId);
  // Multiple receipt lines do not make a description, date or payment edit
  // an allocation. Amount and category edits remain held until allocated.
  if(posting.items.length>1&&(before.amountSatang!==after.amountSatang||before.category!==after.category))return "ALLOCATION";
  const linked=await ports.bootstrap(env,owner,id,before);if(linked==="PENDING")return "METADATA_PENDING";if(linked==="STALE")return "STALE";if(linked!=="READY")return "SHEET_REVIEW";
  const report=await ports.view(env,owner,id,before,before.transactionDate.slice(0,7));if(report.kind==="PENDING")return "REPORT_PENDING";if(report.kind==="STALE")return "STALE";if(report.kind!=="READY")return "SHEET_REVIEW";
  const prepared=await ports.plan(env,before,after,id,undefined,report.view);if(!prepared)return "SHEET_REVIEW";if("kind" in prepared)return "LEGACY_BANK_REVIEW";let plan=prepared;
  const guard=await ports.guards(env,owner,id,before,plan);if(guard.kind==="PENDING")return "GUARD_PENDING";if(guard.kind==="STALE")return "STALE";if(guard.kind!=="READY")return "PROTECTION";
  if(guard.guards.length){
    const fresh=await ports.plan(env,before,after,id,undefined,report.view);if(!fresh||"kind" in fresh||JSON.stringify(fresh)!==JSON.stringify(plan))return "SHEET_REVIEW";
    const checked=await ports.guards(env,owner,id,before,fresh);if(checked.kind!=="READY"||JSON.stringify(checked.guards)!==JSON.stringify(guard.guards))return "PROTECTION";
    plan={...fresh,cellGuards:{correctionId:id,guards:checked.guards}};
  }
  const reportAgain=await ports.view(env,owner,id,before,before.transactionDate.slice(0,7));if(reportAgain.kind!=="READY"||JSON.stringify(reportAgain.view)!==JSON.stringify(report.view))return "SHEET_REVIEW";
  plan={...plan,reportView:report.view};
  const rechecked=await ports.periods(env,owner,id);
  if(!rechecked||rechecked.headerDigest!==periods.headerDigest)return "STALE";if(rechecked.periods.some(item=>item.decision!=="OPEN"))return "PERIOD_REVIEW";
  if(!await ports.protection(env))return "PROTECTION";
  if(!await ports.dedupe(env,before,after))return "DUPLICATE";
  let next:number|null;
  try{next=await ports.commit(env,owner,id,{ownerVerified:true,snapshotCurrent:true,sourcePeriod:"OPEN",destinationPeriod:"OPEN",itemCount:posting.items.length,receiptAllocationVerified:false,rowIdentityVerified:true,projectionTargetsVerified:true,reportDeduplicationVerified:true,syncInProgress:false,periodHeaders:headers},traceId,Date.now(),plan);}
  catch(error){if(await applied())return "APPLIED";throw error;}
  if(next===null)return await applied()?"APPLIED":"STALE";
  try{await ports.enqueue(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE_CORRECTION",entityKey:before.expenseId,entityVersion:next,traceId});}catch{/* durable outbox remains available to scheduled recovery */}
  return "APPLIED";
}
