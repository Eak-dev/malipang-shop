import { recoverPendingSheetJobs } from "../db/repositories";
import { getEvidence } from "../evidence/r2";
import { finalizeMissingPunchPayrolls } from "../payroll/finalize";
import { applyPayrollRange,previewPayrollRange } from "../payroll/range";
import { bootstrapSheets } from "../sheets/client";
import type { EmployeeImportInput,Env } from "../types";
import { correctAttendance } from "./attendance-correction";
import { evaluateExpenseText } from "./expense-evaluate";
import { createFixedOtRequest,finalizeFixedOt,setEmployeeWage } from "./payroll-admin";
import { importEmployees,importEmployeesFromConfiguredSheet } from "./staff-import";
import { importShiftScheduleFromSheet } from "./shift-import";
import { generateDefaultSchedule,overrideShiftSchedule } from "./shift-schedule";
import { checkReadiness } from "./readiness";
import { reconcileSheets } from "./reconcile-sheets";
import { evaluateEvidenceImage,evaluateUploadedImage } from "./vision-evaluate";
import { inspectLineImage } from "./vision-inspect";
import { enqueueAttendanceNotification } from "../line/attendance-notification";
import { getLineBotInfo,getLineMessageQuota } from "../line/api";
import { authorize } from "../access/authorization";
import { approveIdentityLinkRequest,assignStaffRole,getStaffActorByEmployeeId,listIdentityLinkRequests,rejectIdentityLinkRequest } from "../access/repository";
function safeEqual(a:string,b:string):boolean{const aa=new TextEncoder().encode(a),bb=new TextEncoder().encode(b);if(aa.length!==bb.length)return false;let diff=0;for(let i=0;i<aa.length;i++)diff|=aa[i]!^bb[i]!;return diff===0;}
function authorized(request:Request,env:Env):boolean{return env.ADMIN_TOKEN.length>=32&&safeEqual(request.headers.get("authorization")||"",`Bearer ${env.ADMIN_TOKEN}`);}
async function requireOwnerActor(request:Request,env:Env){
  const employeeId=(request.headers.get("x-malipang-actor")||"").trim();
  if(!employeeId)throw new Error("OWNER_ACTOR_REQUIRED");
  const actor=await getStaffActorByEmployeeId(env,employeeId);
  if(!actor||actor.role!=="OWNER"||!authorize(actor,"identity.approve"))throw new Error("FORBIDDEN");
  return actor;
}
export async function handleAdmin(request:Request,env:Env,_ctx:ExecutionContext):Promise<Response>{
  if(!authorized(request,env))return new Response("Unauthorized",{status:401});const url=new URL(request.url);
  try{
    if(request.method==="GET"&&url.pathname==="/admin/status"){
      const[inbound,sync,failed,lineAuth,lineQuota]=await Promise.all([env.DB.prepare(`SELECT status,COUNT(*) count FROM inbound_events GROUP BY status`).all(),env.DB.prepare(`SELECT status,COUNT(*) count FROM sync_jobs GROUP BY status`).all(),env.DB.prepare(`SELECT COUNT(*) count FROM failed_jobs WHERE status='OPEN'`).first<{count:number}>(),getLineBotInfo(env).then(()=>true).catch(()=>false),getLineMessageQuota(env).catch(error=>({pushCapacity:"UNKNOWN",warning:String(error instanceof Error?error.message:error)}))]);return Response.json({ok:true,mode:env.RUNTIME_MODE,inbound:inbound.results,sync:sync.results,openFailedJobs:Number(failed?.count||0),line:{auth:lineAuth?"PASS":"FAIL",replyCapability:lineAuth?"PASS":"FAIL",push:lineQuota},now:new Date().toISOString()});
    }
    if(request.method==="GET"&&url.pathname==="/admin/readiness"){const result=await checkReadiness(env);return Response.json(result,{status:result.ok?200:503});}
    if(request.method==="POST"&&url.pathname==="/admin/bootstrap-sheets"){await bootstrapSheets(env);return Response.json({ok:true});}
    if(request.method==="POST"&&url.pathname==="/admin/import-employees-from-sheet")return Response.json({ok:true,...await importEmployeesFromConfiguredSheet(env)});
    if(request.method==="POST"&&url.pathname==="/admin/import-shifts-from-sheet")return Response.json({ok:true,...await importShiftScheduleFromSheet(env)});
    if(request.method==="POST"&&url.pathname==="/admin/shifts/generate-defaults"){const body=await request.json() as Record<string,unknown>;return Response.json({ok:true,...await generateDefaultSchedule(env,{...body,changedBy:request.headers.get("x-malipang-actor")})});}
    if(request.method==="POST"&&url.pathname==="/admin/shifts/override"){const body=await request.json() as Record<string,unknown>;return Response.json({ok:true,...await overrideShiftSchedule(env,{...body,changedBy:request.headers.get("x-malipang-actor")})});}
    if(request.method==="POST"&&url.pathname==="/admin/import-employees"){const employees=await request.json() as EmployeeImportInput[];await importEmployees(env,employees);return Response.json({ok:true,count:employees.length});}
    if(request.method==="GET"&&url.pathname==="/admin/identity/requests"){await requireOwnerActor(request,env);return Response.json({ok:true,requests:await listIdentityLinkRequests(env,url.searchParams.get("status")||"PENDING_OWNER_APPROVAL")});}
    if(request.method==="POST"&&url.pathname.startsWith("/admin/identity/requests/")&&url.pathname.endsWith("/approve")){const owner=await requireOwnerActor(request,env),requestId=decodeURIComponent(url.pathname.slice("/admin/identity/requests/".length,-"/approve".length));return Response.json({ok:true,...await approveIdentityLinkRequest(env,requestId,owner)});}
    if(request.method==="POST"&&url.pathname.startsWith("/admin/identity/requests/")&&url.pathname.endsWith("/reject")){const owner=await requireOwnerActor(request,env),requestId=decodeURIComponent(url.pathname.slice("/admin/identity/requests/".length,-"/reject".length)),body=await request.json() as{reason?:unknown},reason=String(body.reason||"").trim();if(reason.length<3)throw new Error("REJECTION_REASON_REQUIRED");await rejectIdentityLinkRequest(env,requestId,owner,reason);return Response.json({ok:true,requestId,status:"REJECTED"});}
    if(request.method==="POST"&&url.pathname==="/admin/staff/role"){const owner=await requireOwnerActor(request,env),body=await request.json() as{employeeId?:unknown;role?:unknown;branchId?:unknown;reason?:unknown},role=String(body.role||"");if(role!=="OWNER"&&role!=="BRANCH_MANAGER"&&role!=="ASSISTANT_MANAGER"&&role!=="EMPLOYEE")throw new Error("INVALID_ROLE");return Response.json({ok:true,...await assignStaffRole(env,owner,{employeeId:String(body.employeeId||""),role,branchId:body.branchId==null?null:String(body.branchId),reason:String(body.reason||"")})});}
    if(request.method==="POST"&&url.pathname==="/admin/payroll/wage")return Response.json({ok:true,...await setEmployeeWage(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/payroll/finalize-missing")return Response.json({ok:true,...await finalizeMissingPunchPayrolls(env)});
    if(request.method==="POST"&&url.pathname==="/admin/payroll/preview")return Response.json({ok:true,...await previewPayrollRange(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/payroll/apply")return Response.json({ok:true,...await applyPayrollRange(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/ot/request")return Response.json({ok:true,...await createFixedOtRequest(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/ot/finalize")return Response.json({ok:true,...await finalizeFixedOt(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/expense-access"){const body=await request.json() as{lineUserId?:string;enabled?:boolean};if(!body.lineUserId||typeof body.enabled!=="boolean")throw new Error("lineUserId and enabled are required");const result=await env.DB.prepare(`UPDATE employees SET can_submit_expense=?,updated_at=? WHERE line_user_id=?`).bind(body.enabled?1:0,new Date().toISOString(),body.lineUserId).run();if(Number(result.meta.changes||0)!==1)throw new Error("LINE user not found");return Response.json({ok:true});}
    if(request.method==="POST"&&url.pathname==="/admin/expense/evaluate")return Response.json({ok:true,...evaluateExpenseText(await request.json() as{text?:string;now?:string}) as Record<string,unknown>});
    if(request.method==="POST"&&url.pathname==="/admin/attendance/correct")return Response.json({ok:true,...await correctAttendance(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/attendance/notification-smoke"){
      const body=await request.json() as{employeeId?:string;scenario?:string;runId?:string};
      if(body.employeeId!=="EMP_TEST")throw new Error("notification smoke is restricted to EMP_TEST");
      if(body.scenario!=="SUCCESS"&&body.scenario!=="REJECTION")throw new Error("scenario must be SUCCESS or REJECTION");
      if(!body.runId||!/^[A-Za-z0-9_-]{8,64}$/.test(body.runId))throw new Error("valid runId is required");
      const employee=await env.DB.prepare(`SELECT line_user_id,status FROM employees WHERE employee_id='EMP_TEST' LIMIT 1`).first<{line_user_id:string;status:string}>();
      if(!employee||employee.status!=="ACTIVE"||!employee.line_user_id)throw new Error("EMP_TEST must be ACTIVE and linked to LINE");
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
    if(request.method==="POST"&&url.pathname==="/admin/retry-sync"){const body=await request.json().catch(()=>({})) as{staleAfterSeconds?:number};return Response.json({ok:true,enqueued:await recoverPendingSheetJobs(env,body.staleAfterSeconds??300)});}
    if(request.method==="POST"&&url.pathname==="/admin/reconcile-sheets")return Response.json({ok:true,...await reconcileSheets(env,await request.json().catch(()=>({})) as never)});
    if(request.method==="POST"&&url.pathname==="/admin/vision/inspect")return Response.json({ok:true,...await inspectLineImage(env,await request.json() as{messageId?:string})});
    if(request.method==="POST"&&url.pathname==="/admin/vision/evaluate")return Response.json({ok:true,...await evaluateUploadedImage(env,request) as Record<string,unknown>});
    if(request.method==="POST"&&url.pathname==="/admin/vision/evaluate-evidence")return Response.json({ok:true,...await evaluateEvidenceImage(env,await request.json() as{key?:string},url) as Record<string,unknown>});
    if(request.method==="GET"&&url.pathname.startsWith("/admin/evidence/"))return getEvidence(env,decodeURIComponent(url.pathname.slice("/admin/evidence/".length)));
    return new Response("Not found",{status:404});
  }catch(error){return Response.json({ok:false,error:String(error instanceof Error?error.message:error)},{status:400});}
}
