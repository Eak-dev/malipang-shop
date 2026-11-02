import type {Env} from "../types";
import type {OwnerCorrectionSnapshot} from "../expense/owner-correction";
import {loadExpenseDailyPosting} from "./sync";
import {verifyOwnerCorrectionProjectionRows} from "./owner-correction-bootstrap-service";
import {inspectOwnerCorrectionPlacement} from "./owner-correction-placement-service";
import {captureOwnerCorrectionReport,ownerCorrectionReportMatches} from "./owner-correction-report-snapshot";
import {inspectOwnerCorrectionCategoryProtection} from "./owner-correction-protection";
import {inspectOwnerCorrectionReportView} from "./owner-correction-report-view";
import type {CorrectionSyncPlan} from "./owner-correction-sync-plan";
import type {CorrectionReconciliationEvidence} from "./owner-correction-sync-state";
import type {OwnerCorrectionJob} from "./owner-correction-lease";

interface Saved{before:OwnerCorrectionSnapshot;after:OwnerCorrectionSnapshot}
export interface CorrectionReconciliationPorts{
  saved:(env:Env,job:OwnerCorrectionJob)=>Promise<Saved|null>;
  posting:typeof loadExpenseDailyPosting;
  projection:typeof verifyOwnerCorrectionProjectionRows;
  placement:typeof inspectOwnerCorrectionPlacement;
  report:typeof captureOwnerCorrectionReport;
  protection:typeof inspectOwnerCorrectionCategoryProtection;
  view?:typeof inspectOwnerCorrectionReportView;
}
async function saved(env:Env,job:OwnerCorrectionJob):Promise<Saved|null>{
  const row=await env.DB.prepare(`SELECT c.before_json,c.after_json FROM expense_owner_correction_sync s JOIN expense_owner_corrections c ON c.correction_id=s.correction_id WHERE s.expense_id=? AND s.expense_version=? AND s.phase='IDENTITY_VERIFIED' AND c.status='APPLIED'`).bind(job.expenseId,job.version).first<{before_json:string;after_json:string}>();
  if(!row)return null;try{const before=JSON.parse(row.before_json) as OwnerCorrectionSnapshot,after=JSON.parse(row.after_json) as OwnerCorrectionSnapshot;return before?.expenseId===job.expenseId&&after?.expenseId===job.expenseId?{before,after}:null;}catch{return null;}
}
const defaults:CorrectionReconciliationPorts={saved,posting:loadExpenseDailyPosting,projection:verifyOwnerCorrectionProjectionRows,placement:inspectOwnerCorrectionPlacement,report:captureOwnerCorrectionReport,protection:inspectOwnerCorrectionCategoryProtection,view:inspectOwnerCorrectionReportView};
const matches=(e:Record<string,unknown>,s:OwnerCorrectionSnapshot,version:number)=>e.expense_id===s.expenseId&&e.status==="CONFIRMED"&&Number(e.version)===version&&e.description===s.description&&e.category===s.category&&Number(e.amount_satang)===s.amountSatang&&e.transaction_date===s.transactionDate&&e.payment_key===s.paymentKey&&e.source_wallet===s.sourceWallet;

/** Independently re-read every supported projection; an unsupported case stays in review. */
export async function reconcileOwnerCorrection(env:Env,plan:CorrectionSyncPlan,job:OwnerCorrectionJob,ports:CorrectionReconciliationPorts=defaults):Promise<CorrectionReconciliationEvidence|null>{
  if(!plan.reportBaseline||plan.expenseId!==job.expenseId||!Number.isSafeInteger(job.version)||job.version<1)return null;
  const [snapshots,posting]=await Promise.all([ports.saved(env,job),ports.posting(env,job.expenseId)]);
  if(!snapshots||!matches(posting.expense,snapshots.after,job.version))return null;
  const expected:OwnerCorrectionSnapshot={...snapshots.after,status:"CONFIRMED",version:job.version,updatedAt:posting.expense.updated_at==null?null:String(posting.expense.updated_at)};
  const destination=plan.rebind?.reservationMetadataId??plan.dailyMetadataId;
  const [projection,placement,report,protectedCategory,reportView]=await Promise.all([
    ports.projection(env,expected,plan),
    ports.placement(env,{before:snapshots.before,after:expected,sourceMetadataId:plan.dailyMetadataId,destinationMetadataId:destination,committedVersion:job.version}),
    ports.report(env,expected,destination,undefined,plan.reportView),ports.protection(env),plan.reportView&&ports.view?ports.view(env,plan.reportView.correctionId,plan.reportView):Promise.resolve(plan.reportView?"CONFLICT":"VERIFIED")
  ]);
  if(!projection||!placement||!protectedCategory||reportView!=="VERIFIED"||!report||!ownerCorrectionReportMatches(plan.reportBaseline,report))return null;
  const latest=await ports.posting(env,job.expenseId);if(!matches(latest.expense,expected,job.version)||latest.expense.updated_at!==posting.expense.updated_at)return null;
  return {expenseId:job.expenseId,version:job.version,dailyMatches:true,rawMatches:true,detailsMatch:true,reportsMatch:true,duplicateCount:0,lostCount:0};
}
