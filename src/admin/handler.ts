import {armSingleNormalExpense} from '../sheets/continuous-normal-recovery';
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
import {inspectRecoveryProvider} from './stable-recovery-provider';
import {operateContinuousCutover} from './continuous-cutover-operator';
import {operateContinuousCanary} from './continuous-canary-operator';
import {stepCanaryUnwrittenRecovery} from './canary-unwritten-dispatch';
import {stepCompletedCanaryRecovery} from './canary-completed-recovery';
import {closeExactCanaryDailyIncident,closeExactCanaryRawIncident,closeExactCanaryRawUndoIncident} from '../sheets/continuous-review-close';
import {prepareProviderCanary,stepProviderCanary} from '../sheets/continuous-provider-canary';
import {ReviewRequestBudget} from '../sheets/review-request-budget';
import {SheetsHttpError,SheetsReadNetworkError,SheetsMutationOutcomeUnknownError} from '../sheets/client';
import {GoogleOAuthHttpError,GoogleOAuthPreflightError} from '../sheets/google-auth';
import {OperationTimeoutError} from '../shared/async';
import {operateMonthlyReport} from '../sheets/monthly-report-operator';
function safeEqual(a:string,b:string):boolean{const aa=new TextEncoder().encode(a),bb=new TextEncoder().encode(b);if(aa.length!==bb.length)return false;let diff=0;for(let i=0;i<aa.length;i++)diff|=aa[i]!^bb[i]!;return diff===0;}
function authorized(request:Request,env:Env):boolean{return env.ADMIN_TOKEN.length>=32&&safeEqual(request.headers.get("authorization")||"",`Bearer ${env.ADMIN_TOKEN}`);}
export async function handleAdmin(request:Request,env:Env,_ctx:ExecutionContext):Promise<Response>{
  if(!authorized(request,env))return new Response("Unauthorized",{status:401});const url=new URL(request.url);
  // Prevent an old or mixed deployment from executing a cutover/canary step.
  // The authenticated caller pins the Worker version obtained independently
  // from Cloudflare; an absent/malformed metadata binding fails closed.
  const guardedMutation=request.method==='POST'&&['/admin/stable-sync/continuous-cutover','/admin/stable-sync/continuous-canary','/admin/stable-sync/provider-canary','/admin/stable-sync/canary-unwritten-recovery','/admin/stable-sync/canary-daily-incident','/admin/stable-sync/canary-raw-incident','/admin/stable-sync/canary-completed-incident','/admin/stable-sync/canary-raw-undo-incident','/admin/stable-sync/monthly-report','/admin/stable-sync/normal-expense-pilot'].includes(url.pathname);
  const versionPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const served=typeof env.CF_VERSION_METADATA?.id==='string'&&versionPattern.test(env.CF_VERSION_METADATA.id)?env.CF_VERSION_METADATA.id:null;
  if(guardedMutation){
    if(!served)return Response.json({ok:false,error:'WORKER_VERSION_UNAVAILABLE',servedVersion:null},{status:503,headers:{'cache-control':'no-store'}});
    const expected=request.headers.get('x-malipang-expected-worker-version');
    if(!expected||!versionPattern.test(expected)||expected!==served)return Response.json({ok:false,error:'WORKER_VERSION_MISMATCH',servedVersion:served},{status:409,headers:{'cache-control':'no-store'}});
  }
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
      // Do not silently ignore the explicit override: a terminal delivery can
      // have written before its acknowledgement was lost. It needs its own
      // reconciliation; enqueueing it cannot prove that a replay is safe.
      if(env.STABLE_PHASE1_ENABLED==='true'&&env.STABLE_REDRIVE_HOLD_ENABLED==='true'&&body.includeTerminalDlq===true)
        return Response.json({ok:false,error:'TERMINAL_RECONCILIATION_REQUIRED'},{status:409});
      // Preserve the legacy administrative enqueue behavior when stable mode
      // is off; the separate terminal claim fence still applies.
      return Response.json({ok:true,enqueued:await recoverPendingSheetJobs(env,body.staleAfterSeconds??300,body.includeTerminalDlq===true)});
    }
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/resume-capacity'){const body=await request.json() as {expenseId?:unknown;version?:unknown};await resumeStableCapacity(env,typeof body.expenseId==='string'?body.expenseId:'',typeof body.version==='number'?body.version:0);return Response.json({ok:true,queued:true});}
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/continuous-cutover'){
      const body=await request.json().catch(()=>({})) as {action?:unknown;expenseIds?:unknown};
      return Response.json({...await operateContinuousCutover(env,body.action,body.expenseIds),servedVersion:served},{headers:{'cache-control':'no-store'}});
    }
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/provider-canary'){
      if(env.CONTINUOUS_PROVIDER_CANARY_ENABLED!=='true')return Response.json({ok:false,error:'PROVIDER_CANARY_DISABLED',servedVersion:served},{status:409,headers:{'cache-control':'no-store'}});
      const body=await request.json().catch(()=>({})) as {action?:unknown;canaryId?:unknown};
      try{
        if(body.action==='prepare'){const canaryId=await prepareProviderCanary(env,new ReviewRequestBudget(40));return Response.json({ok:!!canaryId,canaryId,servedVersion:served},{status:canaryId?200:409,headers:{'cache-control':'no-store'}});}
        if(body.action==='step'&&typeof body.canaryId==='string'){const outcome=await stepProviderCanary(env,body.canaryId,new ReviewRequestBudget(40));return Response.json({ok:outcome==='VERIFIED',outcome,servedVersion:served},{headers:{'cache-control':'no-store'}});}
        return Response.json({ok:false,error:'PROVIDER_CANARY_ACTION_INVALID',servedVersion:served},{status:400,headers:{'cache-control':'no-store'}});
      }catch(error){const code=error instanceof SheetsMutationOutcomeUnknownError?'SHEETS_MUTATION_OUTCOME_UNKNOWN':error instanceof SheetsReadNetworkError?'SHEETS_READ_NETWORK':error instanceof SheetsHttpError?`SHEETS_HTTP_${error.status}`:error instanceof GoogleOAuthHttpError?`GOOGLE_OAUTH_HTTP_${error.status}`:error instanceof GoogleOAuthPreflightError?error.code:error instanceof OperationTimeoutError?'TIMEOUT':'PROVIDER_CANARY_UNCERTAIN';return Response.json({ok:false,error:code,servedVersion:served},{status:503,headers:{'cache-control':'no-store'}});}
    }
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/continuous-canary'){
      const body=await request.json().catch(()=>({})) as {action?:unknown};
      return Response.json({...await operateContinuousCanary(env,body.action),servedVersion:served},{headers:{'cache-control':'no-store'}});
    }
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/normal-expense-pilot'&&env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED==='true'){
      const body=await request.json().catch(()=>null) as {jobId?:unknown}|null;
      const headers={'cache-control':'no-store'};
      if(!body||Object.keys(body).length!==1||typeof body.jobId!=='string')return Response.json({error:'PILOT_INPUT_INVALID',servedVersion:served},{status:400,headers});
      try{
        const armed=await armSingleNormalExpense(env,body.jobId);
        return Response.json({status:armed?'ARMED':'HELD',servedVersion:served},{status:armed?200:409,headers});
      }catch{return Response.json({status:'UNVERIFIED',servedVersion:served},{status:503,headers});}
    }
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/monthly-report'&&env.MONTHLY_REPORT_OPERATOR_ENABLED==='true'){
      const value=await request.json().catch(()=>null) as unknown;if(!value||typeof value!=='object'||Array.isArray(value))return Response.json({ok:false,error:'MONTHLY_REPORT_INVALID'},{status:400,headers:{'cache-control':'no-store'}});
      const body=value as {action?:unknown;candidate?:unknown},keys=Object.keys(value),action=body.action;
      if((action!=='PREVIEW'&&action!=='APPEND_ONE'&&action!=='INSPECT')||keys.some(k=>k!=='action'&&k!=='candidate')||(action==='APPEND_ONE'?keys.length!==2||typeof body.candidate!=='string'||!/^[0-9a-f]{64}$/.test(body.candidate):keys.length!==1))return Response.json({ok:false,error:'MONTHLY_REPORT_INVALID'},{status:400,headers:{'cache-control':'no-store'}});
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(served!)),workerHash=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
      const result=await operateMonthlyReport(env,action,workerHash,typeof body.candidate==='string'?body.candidate:undefined),ok=result.status==='READY'||result.status==='DONE';
      return Response.json({ok,action,...result,servedVersion:served},{status:ok?200:409,headers:{'cache-control':'no-store'}});
    }
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/canary-unwritten-recovery'&&env.CANARY_UNWRITTEN_RECOVERY_ENABLED==='true'){
      const body=await request.json().catch(()=>null) as unknown;
      const action=body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===1?(body as {action?:unknown}).action:null;
      if(action!=='PROBE'&&action!=='PROBE_TIME'&&action!=='TIME'&&action!=='STATUS'&&action!=='COMMIT')return Response.json({ok:false,error:'CANARY_UNWRITTEN_ACTION_INVALID',servedVersion:served},{status:400,headers:{'cache-control':'no-store'}});
      const diagnostic=action==='PROBE'||action==='PROBE_TIME'?{stage:'OPERATOR_STATE',reason:'CHECK_FAILED'}:undefined;
      const outcome=await stepCanaryUnwrittenRecovery(env,action,diagnostic),ok=['READY','IN_PROGRESS','RESUMED','ALREADY_COMMITTED'].includes(outcome);
      return Response.json({ok,action,outcome,...(diagnostic?{diagnostic}:{}),servedVersion:served},{status:ok?200:409,headers:{'cache-control':'no-store'}});
    }
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/canary-daily-incident'&&env.CANARY_UNWRITTEN_RECOVERY_ENABLED==='true'){
      const body=await request.json().catch(()=>null) as unknown;
      const action=body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===1?(body as {action?:unknown}).action:null;
      if(action!=='VERIFY'&&action!=='TIME'&&action!=='TIME_READBACK'&&action!=='PROBE_STATUS'&&action!=='STATUS'&&action!=='COMMIT')return Response.json({ok:false,error:'CANARY_DAILY_ACTION_INVALID',servedVersion:served},{status:400,headers:{'cache-control':'no-store'}});
      const diagnostic=action==='PROBE_STATUS'?{stage:'PRECHECK',remaining:-1}:undefined;
      try{
        const outcome=await closeExactCanaryDailyIncident(env,action,diagnostic),ok=outcome==='IN_PROGRESS'||outcome==='RESUMED'||outcome==='READY';
        return Response.json({ok,action,outcome,...(diagnostic?{diagnostic}:{}),servedVersion:served},{status:ok?200:409,headers:{'cache-control':'no-store'}});
      }catch{return Response.json({ok:false,error:'CANARY_DAILY_UNVERIFIED_NO_RETRY',...(diagnostic?{diagnostic}:{}),servedVersion:served},{status:409,headers:{'cache-control':'no-store'}});}
    }
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/canary-raw-incident'&&env.CANARY_UNWRITTEN_RECOVERY_ENABLED==='true'){
      const body=await request.json().catch(()=>null) as unknown;
      const action=body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===1?(body as {action?:unknown}).action:null;
      if(action!=='VERIFY'&&action!=='TIME'&&action!=='TIME_READBACK'&&action!=='PROBE_STATUS'&&action!=='STATUS'&&action!=='COMMIT')return Response.json({ok:false,error:'CANARY_RAW_ACTION_INVALID',servedVersion:served},{status:400,headers:{'cache-control':'no-store'}});
      try{const outcome=await closeExactCanaryRawIncident(env,action),ok=outcome==='IN_PROGRESS'||outcome==='RESUMED'||outcome==='READY';return Response.json({ok,action,outcome,servedVersion:served},{status:ok?200:409,headers:{'cache-control':'no-store'}});}
      catch{return Response.json({ok:false,error:'CANARY_RAW_UNVERIFIED_NO_RETRY',servedVersion:served},{status:409,headers:{'cache-control':'no-store'}});}
    }
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/canary-completed-incident'&&env.CANARY_UNWRITTEN_RECOVERY_ENABLED==='true'){
      const body=await request.json().catch(()=>null) as unknown;
      const action=body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===1?(body as {action?:unknown}).action:null;
      if(action!=='PROBE'&&action!=='TIME'&&action!=='PROBE_STATUS'&&action!=='STATUS'&&action!=='COMMIT')return Response.json({ok:false,error:'CANARY_COMPLETED_ACTION_INVALID',servedVersion:served},{status:400,headers:{'cache-control':'no-store'}});
      try{const outcome=await stepCompletedCanaryRecovery(env,action),ok=outcome==='READY'||outcome==='IN_PROGRESS'||outcome==='COMPLETE';return Response.json({ok,action,outcome,servedVersion:served},{status:ok?200:409,headers:{'cache-control':'no-store'}});}
      catch{return Response.json({ok:false,error:'CANARY_COMPLETED_UNVERIFIED_NO_RETRY',servedVersion:served},{status:409,headers:{'cache-control':'no-store'}});}
    }
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/canary-raw-undo-incident'&&env.CANARY_UNWRITTEN_RECOVERY_ENABLED==='true'){
      const body=await request.json().catch(()=>null) as unknown;
      const action=body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===1?(body as {action?:unknown}).action:null;
      if(action!=='VERIFY'&&action!=='TIME'&&action!=='TIME_READBACK'&&action!=='PROBE_STATUS'&&action!=='STATUS'&&action!=='COMMIT')return Response.json({ok:false,error:'CANARY_RAW_UNDO_ACTION_INVALID',servedVersion:served},{status:400,headers:{'cache-control':'no-store'}});
      try{const outcome=await closeExactCanaryRawUndoIncident(env,action),ok=outcome==='IN_PROGRESS'||outcome==='RESUMED'||outcome==='READY';return Response.json({ok,action,outcome,servedVersion:served},{status:ok?200:409,headers:{'cache-control':'no-store'}});}
      catch{return Response.json({ok:false,error:'CANARY_RAW_UNDO_UNVERIFIED_NO_RETRY',servedVersion:served},{status:409,headers:{'cache-control':'no-store'}});}
    }
    // R6: default off, so the route is absent (404) exactly as on main.
    if(request.method==='POST'&&url.pathname==='/admin/stable-sync/expense-provider-diagnostic'&&env.EXPENSE_PROVIDER_DIAGNOSTIC_ENABLED==='true'){
      const body=await request.json().catch(()=>({})) as {expenseId?:unknown};
      const evidence=await inspectRecoveryProvider(env,typeof body.expenseId==='string'?body.expenseId:'','รายวัน','รายวันต่อเนื่อง_แบบร่าง');
      return Response.json({ok:true,...evidence},{headers:{'cache-control':'no-store'}});
    }
    if(request.method==='GET'&&url.pathname==='/admin/stable-sync/status'){
      if(env.STABLE_PHASE1_ENABLED!=='true')return Response.json({ok:false,error:'STABLE_PHASE1_DISABLED'},{status:409});
      // phase/review_reason come from migration 0022; fall back before it is applied.
      const claimQuery=(columns:string)=>env.DB.prepare(`SELECT ${columns} FROM stable_workbook_claims WHERE spreadsheet_id=?`).bind(env.GOOGLE_SPREADSHEET_ID).first();
      const [claim,reviews,inFlight,recoveryGate,sheetPacing,syncBacklog,expiredProcessing,openTerminalDlq]=await Promise.all([claimQuery('state,updated_at,notice_stamp,phase,review_reason').catch(()=>claimQuery('state,updated_at,notice_stamp')),env.DB.prepare("SELECT CASE WHEN last_error='STABLE_DAILY_CAPACITY' THEN 'CAPACITY' WHEN last_error='STABLE_HISTORICAL_OR_SOURCE_REVIEW' THEN 'HISTORICAL_OR_SOURCE' ELSE 'OTHER' END AS reason,count(*) AS n FROM sync_jobs WHERE status='REVIEW' GROUP BY reason").all(),env.DB.prepare("SELECT count(*) AS n FROM stable_projection_writes WHERE spreadsheet_id=? AND state='IN_FLIGHT'").bind(env.GOOGLE_SPREADSHEET_ID).first<{n:number}>(),stableRecoveryGateDiagnostic(env),stablePacingDiagnostic(env),env.DB.prepare("SELECT entity_type,status,count(*) n FROM sync_jobs WHERE status!='COMPLETED' GROUP BY entity_type,status ORDER BY entity_type,status").all(),env.DB.prepare("SELECT count(*) n FROM sync_jobs WHERE status='PROCESSING' AND lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')").first<{n:number}>(),env.DB.prepare("SELECT count(*) n FROM failed_jobs WHERE status='OPEN' AND error='DEAD_LETTER_MAX_RETRIES'").first<{n:number}>()]);
      // Additive, allowlisted breakdown; do not expose raw error text or record IDs.
      // Keep the existing `reviews` categories unchanged for existing clients.
      const reviewDetails=await (async()=>{try{const result=await env.DB.prepare(`SELECT CASE
        WHEN last_error='STABLE_DAILY_MONTH_OPENING_UNVERIFIED' THEN 'DAILY_MONTH_OPENING'
        WHEN last_error='STABLE_DAILY_ROW_HELPER_FORMULA_UNVERIFIED' THEN 'DAILY_ROW_FORMULA'
        WHEN last_error IN ('STABLE_CANCELLED_SOURCE_REVIEW','STABLE_SUPERSEDED_SOURCE_REVIEW','STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED','CONTINUOUS_CANCEL_PREDECESSOR_REVIEW') THEN 'CANCELLED_OR_SUPERSEDED'
        ELSE 'OTHER' END AS reason,COUNT(*) AS n FROM sync_jobs WHERE status='REVIEW' GROUP BY reason`).all();
        return result.success!==false&&Array.isArray(result.results)?result.results:null;
      }catch{return null;}})();
      return Response.json({ok:true,claim:claim??null,reviews:reviews.results??[],reviewDetails,inFlightProjections:Number(inFlight?.n??0),recoveryGate,sheetPacing,syncBacklog:(syncBacklog.results||[]).map((x:any)=>({entityType:x.entity_type,status:x.status,count:Number(x.n)})),expiredProcessing:Number(expiredProcessing?.n||0),openTerminalDlq:Number(openTerminalDlq?.n||0)},{headers:{'cache-control':'no-store'}});
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
  }catch(error){return Response.json({ok:false,error:String(error instanceof Error?error.message:error),...(guardedMutation?{servedVersion:served}:{})},{status:400,...(guardedMutation?{headers:{'cache-control':'no-store'}}:{})});}
}
