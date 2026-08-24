import { batchWriteValues,getSheetValues } from "./client";
import type { Env,StaffConfigSyncJob } from "../types";

const REQUIRED_HEADERS=["Employee_ID","Staff_Name","Scheduled_In","Scheduled_Out","Status","Daily_Wage","Grace_Min"] as const;
const LEASE_MS=15*60*1000;

function columnName(index:number):string{let n=index,result="";while(n>0){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result;}
function asBoolean(value:unknown):boolean{return Number(value||0)!==0;}

export interface StaffConfigRecord{
  employeeId:string;
  staffName:string;
  lineUserId:string;
  scheduledIn:string;
  scheduledOut:string;
  status:string;
  dailyWageBaht:number;
  graceMin:number;
  lateDeductionBaht:number;
  earlyDeductionBaht:number;
  canSubmitExpense:boolean;
  role:string;
  branchId:string;
}

export function buildStaffConfigRow(headers:string[],existing:unknown[],record:StaffConfigRecord):unknown[]{
  const row=Array.from({length:headers.length},(_,i)=>existing[i]??"");
  const set=(name:string,value:unknown)=>{const index=headers.indexOf(name);if(index>=0)row[index]=value;};
  set("Employee_ID",record.employeeId);
  set("Staff_Name",record.staffName);
  set("LINE_User_ID",record.lineUserId);
  set("Scheduled_In",record.scheduledIn);
  set("Scheduled_Out",record.scheduledOut);
  set("Status",record.status);
  set("Daily_Wage",record.dailyWageBaht);
  set("Grace_Min",record.graceMin);
  set("Deduct_Late",record.lateDeductionBaht>0);
  set("Late_Deduction_Baht",record.lateDeductionBaht);
  set("Deduct_Early",record.earlyDeductionBaht>0);
  set("Early_Deduction_Baht",record.earlyDeductionBaht);
  set("Can_Submit_Expense",record.canSubmitExpense);
  set("Role",record.role);
  set("Branch_ID",record.branchId);
  return row;
}

async function loadStaffConfigRecord(env:Env,employeeId:string):Promise<StaffConfigRecord>{
  const row=await env.DB.prepare(`SELECT e.employee_id,e.staff_name,e.line_user_id,e.scheduled_in,e.scheduled_out,e.status,e.daily_wage_satang,e.grace_min,e.late_deduction_satang,e.early_deduction_satang,e.can_submit_expense,r.role,r.branch_id FROM employees e JOIN staff_roles r ON r.employee_id=e.employee_id AND r.status='ACTIVE' WHERE e.employee_id=? LIMIT 1`).bind(employeeId).first<Record<string,unknown>>();
  if(!row)throw new Error(`STAFF_CONFIG_EMPLOYEE_NOT_FOUND:${employeeId}`);
  return{
    employeeId:String(row.employee_id),staffName:String(row.staff_name),lineUserId:String(row.line_user_id||""),
    scheduledIn:String(row.scheduled_in),scheduledOut:String(row.scheduled_out),status:String(row.status),
    dailyWageBaht:Number(row.daily_wage_satang||0)/100,graceMin:Number(row.grace_min||0),
    lateDeductionBaht:Number(row.late_deduction_satang||0)/100,earlyDeductionBaht:Number(row.early_deduction_satang||0)/100,
    canSubmitExpense:asBoolean(row.can_submit_expense),role:String(row.role),branchId:String(row.branch_id||"")
  };
}

export async function syncStaffConfigEmployee(env:Env,employeeId:string):Promise<{rowNumber:number;mode:"APPEND"|"UPDATE"}>{
  const values=await getSheetValues(env,`'${env.SHEET_STAFF_CONFIG}'!A1:Z500`);
  if(!values.length)throw new Error(`Sheet ${env.SHEET_STAFF_CONFIG} is empty`);
  const headers=(values[0]||[]).map(value=>String(value??"").trim());
  for(const header of REQUIRED_HEADERS)if(!headers.includes(header))throw new Error(`Missing staff column: ${header}`);
  const employeeIndex=headers.indexOf("Employee_ID"),matches:number[]=[];
  for(let i=1;i<values.length;i++)if(String(values[i]?.[employeeIndex]??"").trim()===employeeId)matches.push(i);
  if(matches.length>1)throw new Error(`Duplicate HR_STAFF_CONFIG Employee_ID: ${employeeId}`);
  const record=await loadStaffConfigRecord(env,employeeId),existingIndex=matches[0],mode:typeof existingIndex==="number"?"UPDATE":"APPEND",rowNumber=typeof existingIndex==="number"?existingIndex+1:values.length+1,existing=typeof existingIndex==="number"?(values[existingIndex]||[]):[];
  const row=buildStaffConfigRow(headers,existing,record),end=columnName(headers.length);
  await batchWriteValues(env,[{range:`'${env.SHEET_STAFF_CONFIG}'!A${rowNumber}:${end}${rowNumber}`,values:[row]}]);
  return{rowNumber,mode};
}

export function staffConfigSyncOutboxStatement(env:Env,job:StaffConfigSyncJob,now=new Date().toISOString()):D1PreparedStatement{
  return env.DB.prepare(`INSERT INTO staff_config_sync_outbox(employee_id,version,trace_id,status,attempt_count,next_attempt_at,last_error,created_at,updated_at) VALUES(?,?,?,'PENDING',0,?,NULL,?,?) ON CONFLICT(employee_id,version) DO UPDATE SET trace_id=excluded.trace_id,status=CASE WHEN staff_config_sync_outbox.status='COMPLETED' THEN 'COMPLETED' ELSE 'PENDING' END,next_attempt_at=CASE WHEN staff_config_sync_outbox.status='COMPLETED' THEN staff_config_sync_outbox.next_attempt_at ELSE excluded.next_attempt_at END,last_error=CASE WHEN staff_config_sync_outbox.status='COMPLETED' THEN staff_config_sync_outbox.last_error ELSE NULL END,updated_at=excluded.updated_at`).bind(job.employeeId,job.version,job.traceId,now,now,now);
}

export async function enqueueStaffConfigSync(env:Env,job:StaffConfigSyncJob):Promise<void>{
  try{await env.JOB_QUEUE.send(job);}catch(error){console.error("staff-config-sync-enqueue",{employeeId:job.employeeId,code:error instanceof Error?error.name:"ERROR"});}
}

export async function processStaffConfigSyncJob(env:Env,job:StaffConfigSyncJob,nowMs=Date.now()):Promise<void>{
  const now=new Date(nowMs).toISOString(),leaseUntil=new Date(nowMs+LEASE_MS).toISOString();
  const claim=await env.DB.prepare(`UPDATE staff_config_sync_outbox SET status='PROCESSING',attempt_count=attempt_count+1,next_attempt_at=?,last_error=NULL,updated_at=? WHERE employee_id=? AND version=? AND ((status IN ('PENDING','FAILED') AND (next_attempt_at IS NULL OR next_attempt_at<=?)) OR (status='PROCESSING' AND updated_at<=?)) RETURNING attempt_count`).bind(leaseUntil,now,job.employeeId,job.version,now,new Date(nowMs-LEASE_MS).toISOString()).first<{attempt_count:number}>();
  if(!claim)return;
  try{
    if(env.SHEETS_SYNC_ENABLED!=="true")throw new Error("SHEETS_SYNC_DISABLED");
    await syncStaffConfigEmployee(env,job.employeeId);
    await env.DB.prepare(`UPDATE staff_config_sync_outbox SET status='COMPLETED',next_attempt_at=NULL,last_error=NULL,updated_at=? WHERE employee_id=? AND version=? AND status='PROCESSING'`).bind(new Date().toISOString(),job.employeeId,job.version).run();
  }catch(error){
    const attempt=Math.max(1,Number(claim.attempt_count||1)),delay=Math.min(1800,30*Math.pow(2,Math.min(6,attempt-1))),retryAt=new Date(Date.now()+delay*1000).toISOString();
    await env.DB.prepare(`UPDATE staff_config_sync_outbox SET status='FAILED',next_attempt_at=?,last_error=?,updated_at=? WHERE employee_id=? AND version=? AND status='PROCESSING'`).bind(retryAt,String(error),new Date().toISOString(),job.employeeId,job.version).run();
    throw error;
  }
}

export async function recoverPendingStaffConfigSyncs(env:Env,limit=40):Promise<number>{
  if(env.SHEETS_SYNC_ENABLED!=="true")return 0;
  const now=new Date().toISOString(),rows=await env.DB.prepare(`SELECT employee_id,version,trace_id FROM staff_config_sync_outbox WHERE status IN ('PENDING','FAILED') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY updated_at ASC LIMIT ?`).bind(now,Math.max(1,Math.min(100,Math.floor(limit)))).all<{employee_id:string;version:number;trace_id:string}>();
  const jobs:StaffConfigSyncJob[]=(rows.results||[]).map(row=>({kind:"STAFF_CONFIG_SYNC",employeeId:String(row.employee_id),version:Number(row.version),traceId:String(row.trace_id)}));
  if(!jobs.length)return 0;
  for(let offset=0;offset<jobs.length;offset+=100)await env.JOB_QUEUE.sendBatch(jobs.slice(offset,offset+100).map(body=>({body})));
  return jobs.length;
}
