import { recoverPendingSheetJobs } from "../db/repositories";
import { getEvidence } from "../evidence/r2";
import { finalizeMissingPunchPayrolls } from "../payroll/finalize";
import { applyPayrollRange,previewPayrollRange } from "../payroll/range";
import { bootstrapSheets } from "../sheets/client";
import type { EmployeeImportInput,Env } from "../types";
import { correctAttendance } from "./attendance-correction";
import { evaluateExpenseText } from "./expense-evaluate";
import { createFixedOtRequest,finalizeFixedOt,setEmployeeWage } from "./payroll-admin";
import { importEmployees,importEmployeesFromConfiguredSheet,syncStaffStatusesFromConfiguredSheet } from "./staff-import";
import { importShiftScheduleFromSheet } from "./shift-import";
import { generateDefaultSchedule,overrideShiftSchedule } from "./shift-schedule";
import { checkReadiness } from "./readiness";
import { reconcileSheets } from "./reconcile-sheets";
import { reconcileExpenseItemRows } from "../sheets/sync";
import { evaluateEvidenceImage,evaluateUploadedImage } from "./vision-evaluate";
import { inspectLineImage } from "./vision-inspect";
import { enqueueAttendanceNotification,recoverQuotaExhaustedLineNotifications } from "../line/attendance-notification";
import { getLineBotInfo,getLineMessageQuota } from "../line/api";
import { reconcileHistoricalFailedJobs } from "./failed-job-reconciliation";
import { onlineOrderReviewSummary } from "../expense/online-order-review-repository";
import { operationsSummary } from "../operations/summary";
import {resumeStableCapacity} from './stable-capacity-resume';
import {stableNoticeReady} from '../sheets/stable-edit-notice';
import {readOriginalPausedNotice} from './stable-paused-notice';
import {stableRecoveryGateDiagnostic,recoveryGateConfigured} from '../sheets/stable-recovery-admission';
import {stablePacingDiagnostic,stablePacingConfigured,stablePacingValid} from '../sheets/stable-sheet-pacing';
import {stableWorkbookInReview} from '../sheets/stable-workbook-claim';
function safeEqual(a:string,b:string):boolean{const aa=new TextEncoder().encode(a),bb=new TextEncoder().encode(b);if(aa.length!==bb.length)return false;let diff=0;for(let i=0;i<aa.length;i++)diff|=aa[i]!^bb[i]!;return diff===0;}
function authorized(request:Request,env:Env):boolean{return env.ADMIN_TOKEN.length>=32&&safeEqual(request.headers.get("authorization")||"",`Bearer ${env.ADMIN_TOKEN}`);}
export async function handleAdmin(request:Request,env:Env,_ctx:ExecutionContext):Promise<Response>{
  if(!authorized(request,env))return new Response("Unauthorized",{status:401});const url=new URL(request.url);
  try{
    if(request.method==="GET"&&url.pathname==="/admin/status"){
      const[inbound,sync,failed,lineAuth,lineQuota]=await Promise.all([env.DB.prepare(`SELECT status,COUNT(*) count FROM inbound_events GROUP BY status`).all(),env.DB.prepare(`SELECT status,COUNT(*) count FROM sync_jobs GROUP BY status`).all(),env.DB.prepare(`SELECT COUNT(*) count FROM failed_jobs WHERE status='OPEN'`).first<{count:number}>(),getLineBotInfo(env).then(()=>true).catch(()=>false),getLineMessageQuota(env).catch(error=>({pushCapacity:"UNKNOWN",warning:String(error instanceof Error?error.message:error)}))]);return Response.json({ok:true,mode:env.RUNTIME_MODE,inbound:inbound.results,sync:sync.results,openFailedJobs:Number(failed?.count||0),line:{auth:lineAuth?"PASS":"FAIL",replyCapability:lineAuth?"PASS":"FAIL",push:lineQuota},now:new Date().toISOString()});
    }
    if(request.method==='GET'&&url.pathname==='/admin/stable-sync/notice-readiness'){const ready=env.STABLE_PHASE1_ENABLED==='true'&&await stableNoticeReady(env);return Response.json({ok:ready},{status:ready?200:503});}
    if(request.method==='GET'&&url.pathname==='/admin/stable-sync/original-paused-notice')return await readOriginalPausedNotice(request,env);
    if(request.method==='GET'&&url.pathname==='/admin/stable-sync/original-ready-notice')return await readOriginalPausedNotice(request,env,'READY');
    if(request.method==="GET"&&url.pathname==="/admin/readiness"){const result=await checkReadiness(env);return Response.json(result,{status:result.ok?200:503});}
    if(request.method==="GET"&&url.pathname==="/admin/operations/summary"){
      try{return Response.json(await operationsSummary(env));}catch{return Response.json({ok:false,error:"OPERATIONS_SUMMARY_UNAVAILABLE"},{status:503});}
    }
    if(request.method==="GET"&&url.pathname==="/admin/expenses/review-summary")return Response.json({ok:true,...await onlineOrderReviewSummary(env)});
    if(request.method==="POST"&&url.pathname==="/admin/bootstrap-sheets"){if(env.STABLE_PHASE1_ENABLED==='true')return Response.json({ok:false,error:'STABLE_LEGACY_WRITE_REVIEW'},{status:409});await bootstrapSheets(env);return Response.json({ok:true});}
    if(request.method==="POST"&&url.pathname==="/admin/import-employees-from-sheet")return Response.json({ok:true,...await importEmployeesFromConfiguredSheet(env)});
    if(request.method==="POST"&&url.pathname==="/admin/import-employees-from-sheet-scoped")return Response.json({ok:true,...await importEmployeesFromConfiguredSheet(env,await request.json().catch(()=>({})) as never)});
    if(request.method==="POST"&&url.pathname==="/admin/sync-staff-statuses-from-sheet-scoped")return Response.json({ok:true,...await syncStaffStatusesFromConfiguredSheet(env,await request.json().catch(()=>({})) as never)});
    if(request.method==="POST"&&url.pathname==="/admin/import-shifts-from-sheet")return Response.json({ok:true,...await importShiftScheduleFromSheet(env,await request.json().catch(()=>({})) as never)});
    if(request.method==="POST"&&url.pathname==="/admin/shifts/generate-defaults"){const body=await request.json() as Record<string,unknown>;return Response.json({ok:true,...await generateDefaultSchedule(env,{...body,changedBy:request.headers.get("x-malipang-actor")})});}
    if(request.method==="POST"&&url.pathname==="/admin/shifts/override"){const body=await request.json() as Record<string,unknown>;return Response.json({ok:true,...await overrideShiftSchedule(env,{...body,changedBy:request.headers.get("x-malipang-actor")})});}
    if(request.method==="POST"&&url.pathname==="/admin/import-employees"){const employees=await request.json() as EmployeeImportInput[];await importEmployees(env,employees);return Response.json({ok:true,count:employees.length});}
    if(request.method==="POST"&&url.pathname==="/admin/payroll/wage")return Response.json({ok:true,...await setEmployeeWage(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/payroll/finalize-missing")return Response.json({ok:true,...await finalizeMissingPunchPayrolls(env,await request.json().catch(()=>({})) as never)});
    if(request.method==="POST"&&url.pathname==="/admin/payroll/preview")return Response.json({ok:true,...await previewPayrollRange(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/payroll/apply")return Response.json({ok:true,...await applyPayrollRange(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/ot/request")return Response.json({ok:true,...await createFixedOtRequest(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/ot/finalize")return Response.json({ok:true,...await finalizeFixedOt(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/expense-access"){const body=await request.json() as{lineUserId?:string;enabled?:boolean};if(!body.lineUserId||typeof body.enabled!=="boolean")throw new Error("lineUserId and enabled are required");const result=await env.DB.prepare(`UPDATE employees SET can_submit_expense=?,updated_at=? WHERE line_user_id=?`).bind(body.enabled?1:0,new Date().toISOString(),body.lineUserId).run();if(Number(result.meta.changes||0)!==1)throw new Error("LINE user not found");return Response.json({ok:true});}
    if(request.method==="POST"&&url.pathname==="/admin/expense/evaluate")return Response.json({ok:true,...evaluateExpenseText(await request.json() as{text?:string;now?:string}) as Record<string,unknown>});
    if(request.method==="POST"&&url.pathname==="/admin/attendance/correct")return Response.json({ok:true,...await correctAttendance(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/attendance/notification-smoke"){
      const body=await request.json() as{employeeId?:string;scenario?:string;runId?:string};
      if(body.employeeId!=="OWN001")throw new Error("notification smoke is restricted to OWN001");
      if(body.scenario!=="SUCCESS"&&body.scenario!=="REJECTION")throw new Error("scenario must be SUCCESS or REJECTION");
      if(!body.runId||!/^[A-Za-z0-9_-]{8,64}$/.test(body.runId))throw new Error("valid runId is required");
      const employee=await env.DB.prepare(`SELECT line_user_id,status FROM employees WHERE employee_id='OWN001' LIMIT 1`).first<{line_user_id:string;status:string}>();
      if(!employee||employee.status!=="ACTIVE"||!employee.line_user_id)throw new Error("OWN001 must be ACTIVE and linked to LINE");
      const success=body.scenario==="SUCCESS";
      await enqueueAttendanceNotification(env,{
        to:employee.line_user_id,
        text:success
          ?"✅ [SMOKE TEST] Attendance success notification is operational. No attendance record was created."
          :"❌ [SMOKE TEST] Attendance rejection notification is operational. No attendance record was created.",
        identity:`attendance-smoke:${body.runId}:${body.scenario}`,
        purpose:"ATTENDANCE_SMOKE",
        traceId:`attendance_smoke_${body.runId}_${body.scenario.toLowerCase()}`
      });
      return Response.json({ok:true,queued:true,scenario:body.scenario,businessRecordCreated:false});
    }
    if(request.method==="POST"&&url.pathname==="/admin/retry-sync"){
      if(await stableWorkbookInReview(env))return Response.json({ok:true,enqueued:0,blockedBy:'WORKBOOK_REVIEW'});
      if(recoveryGateConfigured(env))return Response.json({ok:true,enqueued:0,blockedBy:'RECOVERY_GATE'});
      if(stablePacingConfigured(env)&&!stablePacingValid(env))return Response.json({ok:true,enqueued:0,blockedBy:'PACING_INVALID_CONFIG'});
      const body=await request.json().catch(()=>({})) as{staleAfterSeconds?:number;includeTerminalDlq?:boolean};
      // Exclude terminal DLQ by default. Explicit true retains the existing
      // authorized recovery path; operators must reconcile stable IDs first.
      return Response.json({ok:true,enqueued:await recoverPendingSheetJobs(env,body.staleAfterSeconds??300,body.includeTerminalDlq===true)});
    }
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/resume-capacity'){const body=await request.json() as {expenseId?:unknown;version?:unknown};await resumeStableCapacity(env,typeof body.expenseId==='string'?body.expenseId:'',typeof body.version==='number'?body.version:0);return Response.json({ok:true,queued:true});}
    if(request.method==='GET'&&url.pathname==='/admin/stable-sync/status'){
      if(env.STABLE_PHASE1_ENABLED!=='true')return Response.json({ok:false,error:'STABLE_PHASE1_DISABLED'},{status:409});
      // phase/review_reason come from migration 0022; fall back before it is applied.
      const claimQuery=(columns:string)=>env.DB.prepare(`SELECT ${columns} FROM stable_workbook_claims WHERE spreadsheet_id=?`).bind(env.GOOGLE_SPREADSHEET_ID).first();
      const [claim,reviews,inFlight,recoveryGate,sheetPacing,syncBacklog,expiredProcessing,openTerminalDlq]=await Promise.all([claimQuery('state,updated_at,notice_stamp,phase,review_reason').catch(()=>claimQuery('state,updated_at,notice_stamp')),env.DB.prepare("SELECT CASE WHEN last_error='STABLE_DAILY_CAPACITY' THEN 'CAPACITY' WHEN last_error='STABLE_HISTORICAL_OR_SOURCE_REVIEW' THEN 'HISTORICAL_OR_SOURCE' ELSE 'OTHER' END AS reason,count(*) AS n FROM sync_jobs WHERE status='REVIEW' GROUP BY reason").all(),env.DB.prepare("SELECT count(*) AS n FROM stable_projection_writes WHERE spreadsheet_id=? AND state='IN_FLIGHT'").bind(env.GOOGLE_SPREADSHEET_ID).first<{n:number}>(),stableRecoveryGateDiagnostic(env),stablePacingDiagnostic(env),env.DB.prepare("SELECT entity_type,status,count(*) n FROM sync_jobs WHERE status!='COMPLETED' GROUP BY entity_type,status ORDER BY entity_type,status").all(),env.DB.prepare("SELECT count(*) n FROM sync_jobs WHERE status='PROCESSING' AND lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')").first<{n:number}>(),env.DB.prepare("SELECT count(*) n FROM failed_jobs WHERE status='OPEN' AND error='DEAD_LETTER_MAX_RETRIES'").first<{n:number}>()]);
      return Response.json({ok:true,claim:claim??null,reviews:reviews.results??[],inFlightProjections:Number(inFlight?.n??0),recoveryGate,sheetPacing,syncBacklog:(syncBacklog.results||[]).map((x:any)=>({entityType:x.entity_type,status:x.status,count:Number(x.n)})),expiredProcessing:Number(expiredProcessing?.n||0),openTerminalDlq:Number(openTerminalDlq?.n||0)},{headers:{'cache-control':'no-store'}});
    }
    if(request.method==="POST"&&url.pathname==="/admin/recover-line-notifications"){
      const body=await request.json().catch(()=>({})) as{purpose?:unknown;limit?:unknown};
      const purpose=typeof body.purpose==="string"?body.purpose:undefined;
      const allowed=new Set(["ATTENDANCE_RESULT","ATTENDANCE_REJECTION","ATTENDANCE_SMOKE","EMPLOYEE_RESPONSE","EXPENSE_RESPONSE","OWNER_RESPONSE"]);
      if(purpose!==undefined&&!allowed.has(purpose))throw new Error("valid notification purpose is required");
      const limit=typeof body.limit==="number"?body.limit:undefined;
      return Response.json({ok:true,enqueued:await recoverQuotaExhaustedLineNotifications(env,{...(purpose?{purpose:purpose as import("../types").LineNotificationPurpose}:{}),...(limit===undefined?{}:{limit})})});
    }
    if(request.method==="POST"&&url.pathname==="/admin/reconcile-historical-failed-jobs"){
      const body=await request.json().catch(()=>({})) as{createdBefore?:unknown;dryRun?:unknown};
      const createdBefore=typeof body.createdBefore==="string"?body.createdBefore:"";
      return Response.json({ok:true,...await reconcileHistoricalFailedJobs(env,{createdBefore,dryRun:body.dryRun===true})});
    }
    if(request.method==="POST"&&url.pathname==="/admin/reconcile-sheets")return Response.json({ok:true,...await reconcileSheets(env,await request.json().catch(()=>({})) as never)});
    if(request.method==="POST"&&url.pathname==="/admin/reconcile-expense-items"){
      if(env.STABLE_PHASE1_ENABLED==='true')return Response.json({ok:false,error:'STABLE_LEGACY_WRITE_REVIEW'},{status:409});
      const body=await request.json().catch(()=>({})) as{expenseId?:unknown};
      const expenseId=typeof body.expenseId==="string"?body.expenseId.trim():"";
      if(!/^[A-Za-z0-9_-]{8,128}$/.test(expenseId))throw new Error("valid expenseId is required");
      return Response.json({ok:true,...await reconcileExpenseItemRows(env,expenseId)});
    }
    if(request.method==="POST"&&url.pathname==="/admin/vision/inspect")return Response.json({ok:true,...await inspectLineImage(env,await request.json() as{messageId?:string})});
    if(request.method==="POST"&&url.pathname==="/admin/vision/evaluate")return Response.json({ok:true,...await evaluateUploadedImage(env,request) as Record<string,unknown>});
    if(request.method==="POST"&&url.pathname==="/admin/vision/evaluate-evidence")return Response.json({ok:true,...await evaluateEvidenceImage(env,await request.json() as{key?:string},url) as Record<string,unknown>});
    if(request.method==="GET"&&url.pathname.startsWith("/admin/evidence/"))return getEvidence(env,decodeURIComponent(url.pathname.slice("/admin/evidence/".length)));
    return new Response("Not found",{status:404});
  }catch(error){return Response.json({ok:false,error:String(error instanceof Error?error.message:error)},{status:400});}
}
