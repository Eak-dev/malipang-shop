import { recoverPendingSheetJobs } from "../db/repositories";
import { getEvidence } from "../evidence/r2";
import { bootstrapSheets } from "../sheets/client";
import type { EmployeeImportInput,Env } from "../types";
import { correctAttendance } from "./attendance-correction";
import { evaluateExpenseText } from "./expense-evaluate";
import { importEmployees,importEmployeesFromConfiguredSheet } from "./staff-import";
import { checkReadiness } from "./readiness";
import { reconcileSheets } from "./reconcile-sheets";
import { evaluateUploadedImage } from "./vision-evaluate";
import { inspectLineImage } from "./vision-inspect";
function safeEqual(a:string,b:string):boolean{const aa=new TextEncoder().encode(a),bb=new TextEncoder().encode(b);if(aa.length!==bb.length)return false;let diff=0;for(let i=0;i<aa.length;i++)diff|=aa[i]!^bb[i]!;return diff===0;}
function authorized(request:Request,env:Env):boolean{return env.ADMIN_TOKEN.length>=32&&safeEqual(request.headers.get("authorization")||"",`Bearer ${env.ADMIN_TOKEN}`);}
export async function handleAdmin(request:Request,env:Env,_ctx:ExecutionContext):Promise<Response>{
  if(!authorized(request,env))return new Response("Unauthorized",{status:401});const url=new URL(request.url);
  try{
    if(request.method==="GET"&&url.pathname==="/admin/status"){
      const[inbound,sync,failed]=await Promise.all([env.DB.prepare(`SELECT status,COUNT(*) count FROM inbound_events GROUP BY status`).all(),env.DB.prepare(`SELECT status,COUNT(*) count FROM sync_jobs GROUP BY status`).all(),env.DB.prepare(`SELECT COUNT(*) count FROM failed_jobs WHERE status='OPEN'`).first<{count:number}>()]);return Response.json({ok:true,mode:env.RUNTIME_MODE,inbound:inbound.results,sync:sync.results,openFailedJobs:Number(failed?.count||0),now:new Date().toISOString()});
    }
    if(request.method==="GET"&&url.pathname==="/admin/readiness"){const result=await checkReadiness(env);return Response.json(result,{status:result.ok?200:503});}
    if(request.method==="POST"&&url.pathname==="/admin/bootstrap-sheets"){await bootstrapSheets(env);return Response.json({ok:true});}
    if(request.method==="POST"&&url.pathname==="/admin/import-employees-from-sheet")return Response.json({ok:true,...await importEmployeesFromConfiguredSheet(env)});
    if(request.method==="POST"&&url.pathname==="/admin/import-employees"){const employees=await request.json() as EmployeeImportInput[];await importEmployees(env,employees);return Response.json({ok:true,count:employees.length});}
    if(request.method==="POST"&&url.pathname==="/admin/expense-access"){const body=await request.json() as{lineUserId?:string;enabled?:boolean};if(!body.lineUserId||typeof body.enabled!=="boolean")throw new Error("lineUserId and enabled are required");const result=await env.DB.prepare(`UPDATE employees SET can_submit_expense=?,updated_at=? WHERE line_user_id=?`).bind(body.enabled?1:0,new Date().toISOString(),body.lineUserId).run();if(Number(result.meta.changes||0)!==1)throw new Error("LINE user not found");return Response.json({ok:true});}
    if(request.method==="POST"&&url.pathname==="/admin/expense/evaluate")return Response.json({ok:true,...evaluateExpenseText(await request.json() as{text?:string;now?:string}) as Record<string,unknown>});
    if(request.method==="POST"&&url.pathname==="/admin/attendance/correct")return Response.json({ok:true,...await correctAttendance(env,await request.json())});
    if(request.method==="POST"&&url.pathname==="/admin/retry-sync")return Response.json({ok:true,enqueued:await recoverPendingSheetJobs(env)});
    if(request.method==="POST"&&url.pathname==="/admin/reconcile-sheets")return Response.json({ok:true,...await reconcileSheets(env,await request.json().catch(()=>({})) as never)});
    if(request.method==="POST"&&url.pathname==="/admin/vision/inspect")return Response.json({ok:true,...await inspectLineImage(env,await request.json() as{messageId?:string})});
    if(request.method==="POST"&&url.pathname==="/admin/vision/evaluate")return Response.json({ok:true,...await evaluateUploadedImage(env,request) as Record<string,unknown>});
    if(request.method==="GET"&&url.pathname.startsWith("/admin/evidence/"))return getEvidence(env,decodeURIComponent(url.pathname.slice("/admin/evidence/".length)));
    return new Response("Not found",{status:404});
  }catch(error){return Response.json({ok:false,error:String(error instanceof Error?error.message:error)},{status:400});}
}
