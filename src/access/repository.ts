import { employeeFromRow } from "../payroll/repository";
import type { Employee,Env } from "../types";
import type { AccessActor,AccessScope,StaffRole } from "./authorization";

export interface StaffActor extends AccessActor{employee:Employee;branchName:string|null;}
export interface IdentityLinkRequest{
  requestId:string;
  requestedStaffId:string|null;
  staffName:string|null;
  role:StaffRole|null;
  branchId:string|null;
  branchName:string|null;
  status:string;
  requestedAt:string;
}
type Row=Record<string,unknown>;

function asRole(value:unknown):StaffRole{
  const role=String(value);
  if(role==="OWNER"||role==="BRANCH_MANAGER"||role==="ASSISTANT_MANAGER"||role==="EMPLOYEE")return role;
  throw new Error("Invalid staff role");
}
function asScope(value:unknown):AccessScope{return String(value)==="ORGANIZATION"?"ORGANIZATION":"BRANCH";}
function employeeStatus(value:unknown):"ACTIVE"|"INACTIVE"{return String(value)==="ACTIVE"?"ACTIVE":"INACTIVE";}
function actorFromRow(row:Row):StaffActor{
  const employee=employeeFromRow(row);
  return{
    employee,
    employeeId:employee.employeeId,
    role:asRole(row.role),
    scope:asScope(row.scope),
    branchId:row.branch_id==null?null:String(row.branch_id),
    branchName:row.branch_name==null?null:String(row.branch_name),
    employeeStatus:employeeStatus(row.employee_status??row.status),
    roleStatus:employeeStatus(row.role_status),
  };
}

const employeeColumns=`e.employee_id,e.staff_name,e.line_user_id,e.scheduled_in,e.scheduled_out,e.daily_wage_satang,e.grace_min,e.late_deduction_satang,e.early_deduction_satang,e.can_submit_expense,e.status,e.status employee_status,r.role,r.scope,r.branch_id,r.status role_status,b.branch_name`;

export async function getStaffActorByLineId(env:Env,lineUserId:string):Promise<StaffActor|null>{
  if(!lineUserId)return null;
  const row=await env.DB.prepare(`SELECT ${employeeColumns} FROM line_identity_bindings i JOIN employees e ON e.employee_id=i.employee_id JOIN staff_roles r ON r.employee_id=e.employee_id AND r.status='ACTIVE' LEFT JOIN branches b ON b.branch_id=r.branch_id WHERE i.provider='LINE' AND i.external_user_id=? AND i.status='VERIFIED' LIMIT 1`).bind(lineUserId).first<Row>();
  return row?actorFromRow(row):null;
}

export async function getStaffActorByEmployeeId(env:Env,employeeId:string):Promise<StaffActor|null>{
  const row=await env.DB.prepare(`SELECT ${employeeColumns} FROM employees e JOIN staff_roles r ON r.employee_id=e.employee_id AND r.status='ACTIVE' LEFT JOIN branches b ON b.branch_id=r.branch_id WHERE e.employee_id=? LIMIT 1`).bind(employeeId).first<Row>();
  return row?actorFromRow(row):null;
}

// Legacy aliases exist only to resolve immutable historical evidence.  They
// are not accepted by HR registration or any operational authorization path.
export async function resolveCanonicalStaffId(env:Env,employeeId:string):Promise<string>{
  const alias=await env.DB.prepare(`SELECT canonical_employee_id FROM staff_identity_aliases WHERE legacy_employee_id=? LIMIT 1`).bind(employeeId).first<{canonical_employee_id:string}>();
  return alias?.canonical_employee_id||employeeId;
}

async function audit(env:Env,input:{actorType:"STAFF"|"SYSTEM"|"MIGRATION";actorId:string;action:string;targetEmployeeId?:string|null;branchId?:string|null;reason?:string;before?:unknown;after?:unknown}):Promise<void>{
  await env.DB.prepare(`INSERT INTO access_audit_log(audit_id,actor_type,actor_id,action,target_employee_id,branch_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(
    crypto.randomUUID(),input.actorType,input.actorId,input.action,input.targetEmployeeId??null,input.branchId??null,input.reason??"",input.before===undefined?null:JSON.stringify(input.before),input.after===undefined?null:JSON.stringify(input.after),new Date().toISOString()
  ).run();
}

export async function startHrRegistration(env:Env,lineUserId:string):Promise<{kind:"CONNECTED";actor:StaffActor}|{kind:"NEED_STAFF_ID"}>{
  const actor=await getStaffActorByLineId(env,lineUserId);
  if(actor)return{kind:"CONNECTED",actor};
  const now=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO identity_link_requests(request_id,provider,external_user_id,requested_staff_id,status,requested_at,created_at,updated_at) VALUES(?,?,?,NULL,'PENDING_STAFF_ID',?,?,?) ON CONFLICT(provider,external_user_id) WHERE status IN ('PENDING_STAFF_ID','PENDING_OWNER_APPROVAL') DO UPDATE SET status='PENDING_STAFF_ID',requested_staff_id=NULL,requested_at=excluded.requested_at,updated_at=excluded.updated_at`).bind(crypto.randomUUID(),"LINE",lineUserId,now,now,now).run();
  return{kind:"NEED_STAFF_ID"};
}

export async function submitHrStaffId(env:Env,lineUserId:string,staffId:string):Promise<{ok:true;requestId:string;staffName:string}|{ok:false;code:string}>{
  const request=await env.DB.prepare(`SELECT request_id FROM identity_link_requests WHERE provider='LINE' AND external_user_id=? AND status='PENDING_STAFF_ID' LIMIT 1`).bind(lineUserId).first<{request_id:string}>();
  if(!request)return{ok:false,code:"HR_REGISTRATION_NOT_STARTED"};
  const staff=await env.DB.prepare(`SELECT e.employee_id,e.staff_name,e.status,i.binding_id existing_binding FROM employees e LEFT JOIN line_identity_bindings i ON i.employee_id=e.employee_id AND i.provider='LINE' AND i.status='VERIFIED' WHERE e.employee_id=? LIMIT 1`).bind(staffId).first<{employee_id:string;staff_name:string;status:string;existing_binding:string|null}>();
  if(!staff)return{ok:false,code:"STAFF_ID_NOT_FOUND"};
  if(staff.status!=="ACTIVE")return{ok:false,code:"STAFF_NOT_ACTIVE"};
  if(staff.existing_binding)return{ok:false,code:"STAFF_ALREADY_LINKED"};
  const existing=await env.DB.prepare(`SELECT binding_id FROM line_identity_bindings WHERE provider='LINE' AND external_user_id=? AND status='VERIFIED' LIMIT 1`).bind(lineUserId).first<{binding_id:string}>();
  if(existing)return{ok:false,code:"LINE_ALREADY_LINKED"};
  const now=new Date().toISOString();
  await env.DB.prepare(`UPDATE identity_link_requests SET requested_staff_id=?,status='PENDING_OWNER_APPROVAL',updated_at=? WHERE request_id=? AND status='PENDING_STAFF_ID'`).bind(staff.employee_id,now,request.request_id).run();
  await audit(env,{actorType:"SYSTEM",actorId:"LINE_HR",action:"IDENTITY_LINK_REQUESTED",targetEmployeeId:staff.employee_id,reason:"LINE HR registration request",after:{requestId:request.request_id,status:"PENDING_OWNER_APPROVAL"}});
  return{ok:true,requestId:request.request_id,staffName:staff.staff_name};
}

export async function listIdentityLinkRequests(env:Env,status="PENDING_OWNER_APPROVAL"):Promise<IdentityLinkRequest[]>{
  const result=await env.DB.prepare(`SELECT q.request_id,q.requested_staff_id,q.status,q.requested_at,e.staff_name,r.role,r.branch_id,b.branch_name FROM identity_link_requests q LEFT JOIN employees e ON e.employee_id=q.requested_staff_id LEFT JOIN staff_roles r ON r.employee_id=q.requested_staff_id AND r.status='ACTIVE' LEFT JOIN branches b ON b.branch_id=r.branch_id WHERE q.status=? ORDER BY q.requested_at ASC LIMIT 100`).bind(status).all<Row>();
  return(result.results||[]).map(row=>({requestId:String(row.request_id),requestedStaffId:row.requested_staff_id==null?null:String(row.requested_staff_id),staffName:row.staff_name==null?null:String(row.staff_name),role:row.role==null?null:asRole(row.role),branchId:row.branch_id==null?null:String(row.branch_id),branchName:row.branch_name==null?null:String(row.branch_name),status:String(row.status),requestedAt:String(row.requested_at)}));
}

export async function approveIdentityLinkRequest(env:Env,requestId:string,owner:StaffActor):Promise<{requestId:string;employeeId:string;idempotent:boolean}>{
  const request=await env.DB.prepare(`SELECT request_id,external_user_id,requested_staff_id,status FROM identity_link_requests WHERE request_id=? LIMIT 1`).bind(requestId).first<{request_id:string;external_user_id:string;requested_staff_id:string|null;status:string}>();
  if(!request||!request.requested_staff_id)throw new Error("IDENTITY_REQUEST_NOT_FOUND");
  if(request.status==="APPROVED")return{requestId,employeeId:request.requested_staff_id,idempotent:true};
  if(request.status!=="PENDING_OWNER_APPROVAL")throw new Error("IDENTITY_REQUEST_NOT_PENDING");
  const staff=await env.DB.prepare(`SELECT employee_id,staff_name,status,line_user_id FROM employees WHERE employee_id=? LIMIT 1`).bind(request.requested_staff_id).first<{employee_id:string;staff_name:string;status:string;line_user_id:string}>();
  if(!staff||staff.status!=="ACTIVE")throw new Error("STAFF_NOT_ACTIVE");
  const now=new Date().toISOString(),bindingId=`line_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO line_identity_bindings(binding_id,provider,external_user_id,employee_id,status,verified_at,verified_by,reason,created_at,updated_at) VALUES(?,?,?,?,'VERIFIED',?,?,?, ?,?)`).bind(bindingId,"LINE",request.external_user_id,staff.employee_id,now,owner.employeeId,"Owner-approved HR registration",now,now),
    env.DB.prepare(`UPDATE employees SET line_user_id=?,updated_at=? WHERE employee_id=?`).bind(request.external_user_id,now,staff.employee_id),
    env.DB.prepare(`UPDATE identity_link_requests SET status='APPROVED',reviewed_at=?,reviewed_by=?,updated_at=? WHERE request_id=? AND status='PENDING_OWNER_APPROVAL'`).bind(now,owner.employeeId,now,requestId),
    env.DB.prepare(`INSERT INTO access_audit_log(audit_id,actor_type,actor_id,action,target_employee_id,branch_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),"STAFF",owner.employeeId,"IDENTITY_LINK_APPROVED",staff.employee_id,owner.branchId,"Owner-approved HR registration",JSON.stringify({status:request.status}),JSON.stringify({requestId,bindingStatus:"VERIFIED"}),now)
  ]);
  return{requestId,employeeId:staff.employee_id,idempotent:false};
}

export async function rejectIdentityLinkRequest(env:Env,requestId:string,owner:StaffActor,reason:string):Promise<void>{
  const request=await env.DB.prepare(`SELECT requested_staff_id,status FROM identity_link_requests WHERE request_id=? LIMIT 1`).bind(requestId).first<{requested_staff_id:string|null;status:string}>();
  if(!request||request.status!=="PENDING_OWNER_APPROVAL")throw new Error("IDENTITY_REQUEST_NOT_PENDING");
  const now=new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE identity_link_requests SET status='REJECTED',reviewed_at=?,reviewed_by=?,rejection_reason=?,updated_at=? WHERE request_id=? AND status='PENDING_OWNER_APPROVAL'`).bind(now,owner.employeeId,reason,now,requestId),
    env.DB.prepare(`INSERT INTO access_audit_log(audit_id,actor_type,actor_id,action,target_employee_id,branch_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),"STAFF",owner.employeeId,"IDENTITY_LINK_REJECTED",request.requested_staff_id,owner.branchId,reason,JSON.stringify({status:request.status}),JSON.stringify({requestId,status:"REJECTED"}),now)
  ]);
}

export async function assignStaffRole(env:Env,owner:StaffActor,input:{employeeId:string;role:StaffRole;branchId?:string|null;reason:string}):Promise<{employeeId:string;role:StaffRole;branchId:string|null}>{
  const employeeId=input.employeeId.trim(),role=input.role,branchId=role==="OWNER"?null:(input.branchId||"").trim()||null;
  if(!employeeId||!input.reason.trim())throw new Error("ROLE_ASSIGNMENT_INVALID");
  if(employeeId===owner.employeeId)throw new Error("OWNER_CANNOT_CHANGE_OWN_ROLE");
  if(role!=="OWNER"&&!branchId)throw new Error("BRANCH_REQUIRED");
  const employee=await env.DB.prepare(`SELECT employee_id,status FROM employees WHERE employee_id=? LIMIT 1`).bind(employeeId).first<{employee_id:string;status:string}>();
  if(!employee)throw new Error("STAFF_NOT_FOUND");
  if(employee.status!=="ACTIVE")throw new Error("STAFF_NOT_ACTIVE");
  if(branchId){const branch=await env.DB.prepare(`SELECT branch_id,status FROM branches WHERE branch_id=? LIMIT 1`).bind(branchId).first<{branch_id:string;status:string}>();if(!branch||branch.status!=="ACTIVE")throw new Error("BRANCH_NOT_ACTIVE");}
  const previous=await env.DB.prepare(`SELECT role_assignment_id,role,scope,branch_id,status FROM staff_roles WHERE employee_id=? AND status='ACTIVE' LIMIT 1`).bind(employeeId).first<Row>(),now=new Date().toISOString(),scope=role==="OWNER"?"ORGANIZATION":"BRANCH";
  await env.DB.batch([
    env.DB.prepare(`UPDATE staff_roles SET status='INACTIVE',effective_to=?,updated_at=? WHERE employee_id=? AND status='ACTIVE'`).bind(now,now,employeeId),
    env.DB.prepare(`INSERT INTO staff_roles(role_assignment_id,employee_id,role,scope,branch_id,status,effective_from,effective_to,assigned_by,reason,created_at,updated_at) VALUES(?,?,?,?,?,'ACTIVE',?,NULL,?,?,?,?)`).bind(`role_${crypto.randomUUID()}`,employeeId,role,scope,branchId,now,owner.employeeId,input.reason.trim(),now,now),
    env.DB.prepare(`INSERT INTO access_audit_log(audit_id,actor_type,actor_id,action,target_employee_id,branch_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),"STAFF",owner.employeeId,"STAFF_ROLE_ASSIGNED",employeeId,branchId,input.reason.trim(),previous?JSON.stringify(previous):null,JSON.stringify({role,scope,branchId}),now)
  ]);
  return{employeeId,role,branchId};
}

export async function ensureImportedStaffRole(env:Env,input:{employeeId:string;role?:StaffRole;branchId?:string;status:"ACTIVE"|"INACTIVE"}):Promise<void>{
  const existing=await env.DB.prepare(`SELECT role_assignment_id,role,scope,branch_id,status FROM staff_roles WHERE employee_id=? AND status='ACTIVE' LIMIT 1`).bind(input.employeeId).first<Row>();
  if(existing&&!input.role&&input.status==="ACTIVE")return;
  const role=input.role||(existing?asRole(existing.role):"EMPLOYEE"),branchId=role==="OWNER"?null:(input.branchId||String(existing?.branch_id||"B001")),scope=role==="OWNER"?"ORGANIZATION":"BRANCH",status=input.status==="ACTIVE"?"ACTIVE":"INACTIVE",now=new Date().toISOString();
  if(existing&&String(existing.role)===role&&String(existing.scope)===scope&&(existing.branch_id==null?null:String(existing.branch_id))===branchId&&status==="ACTIVE")return;
  if(branchId){const branch=await env.DB.prepare(`SELECT branch_id FROM branches WHERE branch_id=? AND status='ACTIVE' LIMIT 1`).bind(branchId).first<{branch_id:string}>();if(!branch)throw new Error("BRANCH_NOT_ACTIVE");}
  await env.DB.batch([
    env.DB.prepare(`UPDATE staff_roles SET status='INACTIVE',effective_to=?,updated_at=? WHERE employee_id=? AND status='ACTIVE'`).bind(now,now,input.employeeId),
    env.DB.prepare(`INSERT INTO staff_roles(role_assignment_id,employee_id,role,scope,branch_id,status,effective_from,effective_to,assigned_by,reason,created_at,updated_at) VALUES(?,?,?,?,?,?,?,NULL,'SYSTEM_IMPORT','HR_STAFF_CONFIG import',?,?)`).bind(`role_${crypto.randomUUID()}`,input.employeeId,role,scope,branchId,status,now,now,now),
    env.DB.prepare(`INSERT INTO access_audit_log(audit_id,actor_type,actor_id,action,target_employee_id,branch_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),"SYSTEM","HR_STAFF_CONFIG_IMPORT","STAFF_ROLE_IMPORTED",input.employeeId,branchId,"HR_STAFF_CONFIG import",existing?JSON.stringify(existing):null,JSON.stringify({role,scope,branchId,status}),now)
  ]);
}

export async function createEmployeeChangeRequest(env:Env,actor:StaffActor,input:{requestType:"ATTENDANCE_CORRECTION"|"PROFILE_CORRECTION";workDate?:string;fieldName?:string;proposedValue?:string;reason:string}):Promise<{requestId:string}>{
  const now=new Date().toISOString(),requestId=`chg_${crypto.randomUUID()}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO employee_change_requests(change_request_id,employee_id,request_type,work_date,field_name,proposed_value,reason,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'PENDING',?,?)`).bind(requestId,actor.employeeId,input.requestType,input.workDate??null,input.fieldName??null,input.proposedValue??null,input.reason,now,now),
    env.DB.prepare(`INSERT INTO access_audit_log(audit_id,actor_type,actor_id,action,target_employee_id,branch_id,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),"STAFF",actor.employeeId,"EMPLOYEE_CHANGE_REQUEST_CREATED",actor.employeeId,actor.branchId,input.reason,null,JSON.stringify({requestId,requestType:input.requestType}),now)
  ]);
  return{requestId};
}
