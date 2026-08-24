import { isoDateInBangkok } from "../shared/time";
import { enqueueStaffConfigSync,staffConfigSyncOutboxStatement } from "../sheets/staff-config";
import type { Env,StaffConfigSyncJob } from "../types";
import type { StaffActor } from "./repository";

export interface HrOnboardingRequest{
  requestId:string;
  externalUserId:string;
  displayName:string;
  pictureUrl:string;
  status:"PENDING_OWNER_SETUP"|"APPROVED"|"REJECTED"|"CANCELLED";
  employeeId:string|null;
  requestedAt:string;
  reviewedBy:string|null;
}

export interface UnboundStaff{
  employeeId:string;
  staffName:string;
  role:string;
  branchId:string|null;
  scheduledIn:string;
  scheduledOut:string;
  dailyWageBaht:number;
}

type RequestRow={request_id:string;external_user_id:string;display_name:string;picture_url:string;status:HrOnboardingRequest["status"];employee_id:string|null;requested_at:string;reviewed_by:string|null};

function requestFromRow(row:RequestRow):HrOnboardingRequest{return{requestId:row.request_id,externalUserId:row.external_user_id,displayName:row.display_name,pictureUrl:row.picture_url,status:row.status,employeeId:row.employee_id,requestedAt:row.requested_at,reviewedBy:row.reviewed_by};}
function syncVersion():number{return Math.floor(Date.now()*1000+Math.random()*1000);}

export async function startLineFirstOnboarding(env:Env,lineUserId:string,profile:{displayName:string;pictureUrl:string}):Promise<HrOnboardingRequest>{
  const bound=await env.DB.prepare(`SELECT binding_id FROM line_identity_bindings WHERE provider='LINE' AND external_user_id=? AND status='VERIFIED' LIMIT 1`).bind(lineUserId).first<{binding_id:string}>();
  if(bound)throw new Error("LINE_ALREADY_LINKED");
  const now=new Date().toISOString(),requestId=crypto.randomUUID(),displayName=profile.displayName.trim().slice(0,80)||"LINE user",pictureUrl=/^https:\/\//i.test(profile.pictureUrl)?profile.pictureUrl.slice(0,500):"";
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO hr_onboarding_requests(request_id,provider,external_user_id,display_name,picture_url,status,employee_id,requested_at,reviewed_at,reviewed_by,rejection_reason,claimed_by,created_at,updated_at) VALUES(?,'LINE',?,?,?,'PENDING_OWNER_SETUP',NULL,?,NULL,NULL,'',NULL,?,?) ON CONFLICT(provider,external_user_id) WHERE status='PENDING_OWNER_SETUP' DO UPDATE SET display_name=excluded.display_name,picture_url=excluded.picture_url,updated_at=excluded.updated_at`).bind(requestId,lineUserId,displayName,pictureUrl,now,now,now),
    env.DB.prepare(`UPDATE identity_link_requests SET status='CANCELLED',updated_at=? WHERE provider='LINE' AND external_user_id=? AND status IN ('PENDING_STAFF_ID','PENDING_OWNER_APPROVAL')`).bind(now,lineUserId)
  ]);
  const row=await env.DB.prepare(`SELECT request_id,external_user_id,display_name,picture_url,status,employee_id,requested_at,reviewed_by FROM hr_onboarding_requests WHERE provider='LINE' AND external_user_id=? AND status='PENDING_OWNER_SETUP' LIMIT 1`).bind(lineUserId).first<RequestRow>();
  if(!row)throw new Error("HR_ONBOARDING_CREATE_FAILED");
  return requestFromRow(row);
}

export async function hasPendingLineFirstOnboarding(env:Env,lineUserId:string):Promise<boolean>{
  const row=await env.DB.prepare(`SELECT request_id FROM hr_onboarding_requests WHERE provider='LINE' AND external_user_id=? AND status='PENDING_OWNER_SETUP' LIMIT 1`).bind(lineUserId).first<{request_id:string}>();
  return Boolean(row);
}

export async function getLineFirstOnboardingRequest(env:Env,requestId:string):Promise<HrOnboardingRequest|null>{
  const row=await env.DB.prepare(`SELECT request_id,external_user_id,display_name,picture_url,status,employee_id,requested_at,reviewed_by FROM hr_onboarding_requests WHERE request_id=? LIMIT 1`).bind(requestId).first<RequestRow>();
  return row?requestFromRow(row):null;
}

export async function listPendingLineFirstOnboarding(env:Env):Promise<HrOnboardingRequest[]>{
  const rows=await env.DB.prepare(`SELECT request_id,external_user_id,display_name,picture_url,status,employee_id,requested_at,reviewed_by FROM hr_onboarding_requests WHERE status='PENDING_OWNER_SETUP' ORDER BY requested_at ASC LIMIT 20`).all<RequestRow>();
  return(rows.results||[]).map(requestFromRow);
}

export async function listUnboundActiveStaff(env:Env):Promise<UnboundStaff[]>{
  const rows=await env.DB.prepare(`SELECT e.employee_id,e.staff_name,e.scheduled_in,e.scheduled_out,e.daily_wage_satang,r.role,r.branch_id FROM employees e JOIN staff_roles r ON r.employee_id=e.employee_id AND r.status='ACTIVE' LEFT JOIN line_identity_bindings i ON i.employee_id=e.employee_id AND i.provider='LINE' AND i.status='VERIFIED' WHERE e.status='ACTIVE' AND r.role<>'OWNER' AND i.binding_id IS NULL ORDER BY e.employee_id LIMIT 20`).all<Record<string,unknown>>();
  return(rows.results||[]).map(row=>({employeeId:String(row.employee_id),staffName:String(row.staff_name),role:String(row.role),branchId:row.branch_id==null?null:String(row.branch_id),scheduledIn:String(row.scheduled_in),scheduledOut:String(row.scheduled_out),dailyWageBaht:Number(row.daily_wage_satang||0)/100}));
}

async function claimRequest(env:Env,requestId:string,owner:StaffActor):Promise<HrOnboardingRequest>{
  const now=new Date().toISOString(),row=await env.DB.prepare(`UPDATE hr_onboarding_requests SET claimed_by=?,updated_at=? WHERE request_id=? AND status='PENDING_OWNER_SETUP' AND (claimed_by IS NULL OR claimed_by=?) RETURNING request_id,external_user_id,display_name,picture_url,status,employee_id,requested_at,reviewed_by`).bind(owner.employeeId,now,requestId,owner.employeeId).first<RequestRow>();
  if(row)return requestFromRow(row);
  const existing=await getLineFirstOnboardingRequest(env,requestId);
  if(existing?.status==="APPROVED")return existing;
  if(existing?.status==="REJECTED"||existing?.status==="CANCELLED")throw new Error("HR_ONBOARDING_NOT_PENDING");
  throw new Error("HR_ONBOARDING_BUSY");
}

async function releaseClaim(env:Env,requestId:string,owner:StaffActor):Promise<void>{
  await env.DB.prepare(`UPDATE hr_onboarding_requests SET claimed_by=NULL,updated_at=? WHERE request_id=? AND status='PENDING_OWNER_SETUP' AND claimed_by=?`).bind(new Date().toISOString(),requestId,owner.employeeId).run();
}

async function ensureLineAvailable(env:Env,lineUserId:string):Promise<void>{
  const binding=await env.DB.prepare(`SELECT binding_id FROM line_identity_bindings WHERE provider='LINE' AND external_user_id=? AND status='VERIFIED' LIMIT 1`).bind(lineUserId).first<{binding_id:string}>();
  if(binding)throw new Error("LINE_ALREADY_LINKED");
  const employee=await env.DB.prepare(`SELECT employee_id FROM employees WHERE line_user_id=? LIMIT 1`).bind(lineUserId).first<{employee_id:string}>();
  if(employee)throw new Error("LINE_ALREADY_ASSIGNED");
}

async function reserveEmployeeId(env:Env):Promise<string>{
  for(let attempt=0;attempt<50;attempt++){
    const now=new Date().toISOString(),row=await env.DB.prepare(`UPDATE staff_id_sequences SET next_number=next_number+1,updated_at=? WHERE prefix='EMP' RETURNING next_number-1 allocated_number`).bind(now).first<{allocated_number:number}>();
    if(!row)throw new Error("STAFF_ID_SEQUENCE_MISSING");
    const employeeId=`EMP${String(Number(row.allocated_number)).padStart(3,"0")}`;
    const exists=await env.DB.prepare(`SELECT employee_id FROM employees WHERE employee_id=? LIMIT 1`).bind(employeeId).first<{employee_id:string}>();
    if(!exists)return employeeId;
  }
  throw new Error("STAFF_ID_ALLOCATION_EXHAUSTED");
}

async function activeBranch(env:Env,branchId:string):Promise<void>{
  const branch=await env.DB.prepare(`SELECT branch_id FROM branches WHERE branch_id=? AND status='ACTIVE' LIMIT 1`).bind(branchId).first<{branch_id:string}>();
  if(!branch)throw new Error(`BRANCH_NOT_ACTIVE:${branchId}`);
}

function staffSyncJob(employeeId:string,traceId:string):StaffConfigSyncJob{return{kind:"STAFF_CONFIG_SYNC",employeeId,version:syncVersion(),traceId};}

export async function approveOnboardingAsNewEmployee(env:Env,requestId:string,owner:StaffActor,traceId:string):Promise<{employeeId:string;staffName:string;idempotent:boolean}>{
  const before=await getLineFirstOnboardingRequest(env,requestId);
  if(before?.status==="APPROVED"&&before.employeeId)return{employeeId:before.employeeId,staffName:before.displayName,idempotent:true};
  if(!before||before.status!=="PENDING_OWNER_SETUP")throw new Error("HR_ONBOARDING_NOT_PENDING");
  const request=await claimRequest(env,requestId,owner);
  if(request.status==="APPROVED"&&request.employeeId)return{employeeId:request.employeeId,staffName:request.displayName,idempotent:true};
  try{
    await ensureLineAvailable(env,request.externalUserId);
    await activeBranch(env,"B001");
    const employeeId=await reserveEmployeeId(env),staffName=request.displayName.trim()||employeeId,now=new Date().toISOString(),today=isoDateInBangkok(),wageId=`wage_${employeeId}_${today.replaceAll("-","")}`,bindingId=`line_${crypto.randomUUID()}`,roleId=`role_${crypto.randomUUID()}`,job=staffSyncJob(employeeId,traceId);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO employees(employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,daily_wage_satang,grace_min,late_deduction_satang,early_deduction_satang,can_submit_expense,status,updated_at) VALUES(?,?,?,'04:00','16:00',50000,10,0,0,0,'ACTIVE',?)`).bind(employeeId,staffName,request.externalUserId,now),
      env.DB.prepare(`INSERT INTO employee_wage_history(wage_id,employee_id,daily_wage_satang,effective_from,effective_to,source,note,version,created_at,updated_at) VALUES(?,?,50000,?,NULL,'LINE_HR_ONBOARDING','Owner-confirmed LINE onboarding',1,?,?)`).bind(wageId,employeeId,today,now,now),
      env.DB.prepare(`INSERT INTO staff_roles(role_assignment_id,employee_id,role,scope,branch_id,status,effective_from,effective_to,assigned_by,reason,created_at,updated_at) VALUES(?,?,'EMPLOYEE','BRANCH','B001','ACTIVE',?,NULL,?,'Owner-confirmed LINE onboarding',?,?)`).bind(roleId,employeeId,now,owner.employeeId,now,now),
      env.DB.prepare(`INSERT INTO line_identity_bindings(binding_id,provider,external_user_id,employee_id,status,verified_at,verified_by,reason,created_at,updated_at) VALUES(?,'LINE',?,?,'VERIFIED',?,?, 'Owner-confirmed LINE onboarding',?,?)`).bind(bindingId,request.externalUserId,employeeId,now,owner.employeeId,now,now),
      env.DB.prepare(`UPDATE hr_onboarding_requests SET status='APPROVED',employee_id=?,reviewed_at=?,reviewed_by=?,claimed_by=NULL,updated_at=? WHERE request_id=? AND status='PENDING_OWNER_SETUP' AND claimed_by=?`).bind(employeeId,now,owner.employeeId,now,requestId,owner.employeeId),
      env.DB.prepare(`UPDATE identity_link_requests SET status='CANCELLED',updated_at=? WHERE provider='LINE' AND external_user_id=? AND status IN ('PENDING_STAFF_ID','PENDING_OWNER_APPROVAL')`).bind(now,request.externalUserId),
      env.DB.prepare(`INSERT INTO access_audit_log(audit_id,actor_type,actor_id,action,target_employee_id,branch_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),"STAFF",owner.employeeId,"HR_ONBOARDING_EMPLOYEE_CREATED",employeeId,"B001","Owner-confirmed LINE onboarding",JSON.stringify({requestId,displayName:request.displayName}),JSON.stringify({employeeId,role:"EMPLOYEE",branchId:"B001",dailyWageBaht:500,scheduledIn:"04:00",scheduledOut:"16:00",bindingStatus:"VERIFIED"}),now),
      staffConfigSyncOutboxStatement(env,job,now)
    ]);
    await enqueueStaffConfigSync(env,job);
    return{employeeId,staffName,idempotent:false};
  }catch(error){await releaseClaim(env,requestId,owner);throw error;}
}

export async function linkOnboardingToExistingStaff(env:Env,requestId:string,employeeId:string,owner:StaffActor,traceId:string):Promise<{employeeId:string;staffName:string;idempotent:boolean}>{
  const before=await getLineFirstOnboardingRequest(env,requestId);
  if(before?.status==="APPROVED"&&before.employeeId){if(before.employeeId!==employeeId)throw new Error("HR_ONBOARDING_ALREADY_APPROVED_OTHER_STAFF");const employee=await env.DB.prepare(`SELECT staff_name FROM employees WHERE employee_id=?`).bind(employeeId).first<{staff_name:string}>();return{employeeId,staffName:employee?.staff_name||employeeId,idempotent:true};}
  if(!before||before.status!=="PENDING_OWNER_SETUP")throw new Error("HR_ONBOARDING_NOT_PENDING");
  const request=await claimRequest(env,requestId,owner);
  try{
    await ensureLineAvailable(env,request.externalUserId);
    const target=await env.DB.prepare(`SELECT e.employee_id,e.staff_name,e.status,r.role,r.branch_id,i.binding_id FROM employees e JOIN staff_roles r ON r.employee_id=e.employee_id AND r.status='ACTIVE' LEFT JOIN line_identity_bindings i ON i.employee_id=e.employee_id AND i.provider='LINE' AND i.status='VERIFIED' WHERE e.employee_id=? LIMIT 1`).bind(employeeId).first<{employee_id:string;staff_name:string;status:string;role:string;branch_id:string|null;binding_id:string|null}>();
    if(!target)throw new Error("STAFF_NOT_FOUND");
    if(target.status!=="ACTIVE")throw new Error("STAFF_NOT_ACTIVE");
    if(target.role==="OWNER")throw new Error("OWNER_LINK_REQUIRES_SEPARATE_FLOW");
    if(target.binding_id)throw new Error("STAFF_ALREADY_LINKED");
    const now=new Date().toISOString(),bindingId=`line_${crypto.randomUUID()}`,job=staffSyncJob(employeeId,traceId);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO line_identity_bindings(binding_id,provider,external_user_id,employee_id,status,verified_at,verified_by,reason,created_at,updated_at) VALUES(?,'LINE',?,?,'VERIFIED',?,?, 'Owner-linked existing staff from LINE onboarding',?,?)`).bind(bindingId,request.externalUserId,employeeId,now,owner.employeeId,now,now),
      env.DB.prepare(`UPDATE employees SET line_user_id=?,updated_at=? WHERE employee_id=?`).bind(request.externalUserId,now,employeeId),
      env.DB.prepare(`UPDATE hr_onboarding_requests SET status='APPROVED',employee_id=?,reviewed_at=?,reviewed_by=?,claimed_by=NULL,updated_at=? WHERE request_id=? AND status='PENDING_OWNER_SETUP' AND claimed_by=?`).bind(employeeId,now,owner.employeeId,now,requestId,owner.employeeId),
      env.DB.prepare(`UPDATE identity_link_requests SET status='CANCELLED',updated_at=? WHERE provider='LINE' AND external_user_id=? AND status IN ('PENDING_STAFF_ID','PENDING_OWNER_APPROVAL')`).bind(now,request.externalUserId),
      env.DB.prepare(`INSERT INTO access_audit_log(audit_id,actor_type,actor_id,action,target_employee_id,branch_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),"STAFF",owner.employeeId,"HR_ONBOARDING_EXISTING_STAFF_LINKED",employeeId,target.branch_id,"Owner-linked existing staff from LINE onboarding",JSON.stringify({requestId,displayName:request.displayName}),JSON.stringify({employeeId,bindingStatus:"VERIFIED"}),now),
      staffConfigSyncOutboxStatement(env,job,now)
    ]);
    await enqueueStaffConfigSync(env,job);
    return{employeeId,staffName:target.staff_name,idempotent:false};
  }catch(error){await releaseClaim(env,requestId,owner);throw error;}
}

export async function rejectLineFirstOnboarding(env:Env,requestId:string,owner:StaffActor,reason="Owner declined onboarding"):Promise<void>{
  const request=await getLineFirstOnboardingRequest(env,requestId);
  if(!request)throw new Error("HR_ONBOARDING_NOT_FOUND");
  if(request.status==="REJECTED")return;
  if(request.status!=="PENDING_OWNER_SETUP")throw new Error("HR_ONBOARDING_NOT_PENDING");
  const now=new Date().toISOString(),result=await env.DB.prepare(`UPDATE hr_onboarding_requests SET status='REJECTED',reviewed_at=?,reviewed_by=?,rejection_reason=?,claimed_by=NULL,updated_at=? WHERE request_id=? AND status='PENDING_OWNER_SETUP'`).bind(now,owner.employeeId,reason.slice(0,300),now,requestId).run();
  if(Number(result.meta.changes||0)!==1)throw new Error("HR_ONBOARDING_STATE_CHANGED");
  await env.DB.prepare(`INSERT INTO access_audit_log(audit_id,actor_type,actor_id,action,target_employee_id,branch_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,NULL,NULL,?,?,?,?)`).bind(crypto.randomUUID(),"STAFF",owner.employeeId,"HR_ONBOARDING_REJECTED",reason.slice(0,300),JSON.stringify({requestId,displayName:request.displayName}),JSON.stringify({status:"REJECTED"}),now).run();
}
