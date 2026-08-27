import { enqueueSheetSyncBatch } from "../db/repositories";
import { employeeFromRow } from "../payroll/repository";
import { addDays,isIsoDate,minutesOf } from "../shared/time";
import type { Employee,Env,SheetsSyncJob,WageSnapshot } from "../types";

export type ShiftStatus="EXPECTED"|"DAY_OFF"|"CANCELLED";
export type ShiftAction="DEFAULT_GENERATION"|"SHEET_IMPORT"|"OWNER_OVERRIDE";

export interface ShiftInsertInput{
  employeeId:string;
  workDate:string;
  scheduledIn:string;
  scheduledOut:string;
  status:ShiftStatus;
  reason?:string;
}

export interface GenerateDefaultScheduleInput{
  employeeIds?:unknown;
  fromDate?:unknown;
  toDate?:unknown;
  scheduledIn?:unknown;
  scheduledOut?:unknown;
  reason?:unknown;
  changedBy?:unknown;
}

export interface OverrideShiftInput{
  employeeId?:unknown;
  workDate?:unknown;
  newStatus?:unknown;
  reason?:unknown;
  changedBy?:unknown;
}

interface WageRow{employee_id:unknown;wage_id:unknown;daily_wage_satang:unknown;effective_from:unknown;effective_to:unknown}
interface ShiftRow{employee_id:unknown;work_date:unknown;scheduled_in:unknown;scheduled_out:unknown;status:unknown;version:unknown}
interface PlannedShift extends ShiftInsertInput{employee:Employee;wage:WageSnapshot}

const employeeIdPattern=/^[A-Za-z0-9_-]{1,40}$/;
function requiredText(value:unknown,name:string,max=300):string{
  const text=String(value??"").trim();
  if(!text||text.length>max)throw new Error(`${name} is required and must be at most ${max} characters`);
  return text;
}
function validateEmployeeId(value:unknown):string{
  const employeeId=String(value??"").trim();
  if(!employeeIdPattern.test(employeeId))throw new Error("Invalid employeeId");
  return employeeId;
}
export function parseShiftStatus(value:unknown):ShiftStatus{
  const status=String(value??"").trim();
  if(status==="EXPECTED"||status==="DAY_OFF"||status==="CANCELLED")return status;
  throw new Error("Invalid shift status: expected EXPECTED, DAY_OFF, or CANCELLED");
}
function validateTime(value:unknown,name:string):string{
  const text=String(value??"").trim();minutesOf(text);
  if(!/^\d{2}:\d{2}$/.test(text))throw new Error(`${name} must use HH:mm`);
  return text;
}
function validateDate(value:unknown,name:string):string{
  const text=String(value??"").trim();
  if(!isIsoDate(text))throw new Error(`${name} must use YYYY-MM-DD`);
  return text;
}
function dateRange(fromDate:string,toDate:string):string[]{
  if(toDate<fromDate)throw new Error("toDate must be on or after fromDate");
  const dates:string[]=[];
  for(let date=fromDate;date<=toDate;date=addDays(date,1)){
    dates.push(date);
    if(dates.length>366)throw new Error("Schedule range cannot exceed 366 days");
  }
  return dates;
}
function placeholders(count:number):string{return Array.from({length:count},()=>"?").join(",");}
async function loadActiveEmployees(env:Env,employeeIds:string[]):Promise<Map<string,Employee>>{
  const result=await env.DB.prepare(`SELECT employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,daily_wage_satang,grace_min,late_deduction_satang,early_deduction_satang,can_submit_expense,status FROM employees WHERE employee_id IN (${placeholders(employeeIds.length)})`).bind(...employeeIds).all<Record<string,unknown>>();
  const employees=new Map((result.results||[]).map(row=>{const employee=employeeFromRow(row);return[employee.employeeId,employee];}));
  for(const employeeId of employeeIds){
    const employee=employees.get(employeeId);
    if(!employee)throw new Error(`Employee not found: ${employeeId}`);
    if(employee.status!=="ACTIVE")throw new Error(`Employee is not ACTIVE: ${employeeId}`);
  }
  return employees;
}
async function loadWages(env:Env,employeeIds:string[],_fromDate:string,_toDate:string):Promise<Map<string,WageRow[]>>{
  const result=await env.DB.prepare(`SELECT employee_id,wage_id,daily_wage_satang,effective_from,effective_to FROM employee_wage_history WHERE employee_id IN (${placeholders(employeeIds.length)}) ORDER BY employee_id,effective_from DESC`).bind(...employeeIds).all<WageRow>();
  const wages=new Map<string,WageRow[]>();
  for(const row of result.results||[]){const key=String(row.employee_id),items=wages.get(key)||[];items.push(row);wages.set(key,items);}
  return wages;
}
export function wageFor(employee:Employee,workDate:string,wages:Map<string,WageRow[]>):WageSnapshot{
  const employeeWages=wages.get(employee.employeeId)||[],row=employeeWages.find(item=>String(item.effective_from)<=workDate&&(item.effective_to==null||String(item.effective_to)>=workDate));
  if(row)return{wageSourceId:String(row.wage_id),dailyWageSatang:Number(row.daily_wage_satang),effectiveFrom:String(row.effective_from),effectiveTo:row.effective_to==null?null:String(row.effective_to)};
  const first=employeeWages.slice().sort((a,b)=>String(a.effective_from).localeCompare(String(b.effective_from)))[0];
  if(first&&String(first.effective_from)>workDate)return{wageSourceId:"PRE_EFFECTIVE_DATE",dailyWageSatang:0,effectiveFrom:String(first.effective_from),effectiveTo:null};
  return{wageSourceId:"EMPLOYEE_CURRENT_FALLBACK",dailyWageSatang:employee.dailyWageSatang,effectiveFrom:workDate,effectiveTo:null};
}
function uniqueRows(rows:ShiftInsertInput[]):void{
  const keys=new Set<string>();
  for(const row of rows){const key=`${row.employeeId}|${row.workDate}`;if(keys.has(key))throw new Error(`Duplicate employee/date in schedule input: ${key}`);keys.add(key);}
}
export async function insertMissingScheduleRows(env:Env,rawRows:ShiftInsertInput[],context:{changedBy:string;action:Exclude<ShiftAction,"OWNER_OVERRIDE">;reason:string}):Promise<{inserted:number;existing:number}>{
  if(!Array.isArray(rawRows)||rawRows.length<1||rawRows.length>2000)throw new Error("Schedule input must contain 1-2000 rows");
  const changedBy=requiredText(context.changedBy,"changedBy",100),defaultReason=requiredText(context.reason,"reason",500);
  const rows=rawRows.map(row=>({employeeId:validateEmployeeId(row.employeeId),workDate:validateDate(row.workDate,"workDate"),scheduledIn:validateTime(row.scheduledIn,"scheduledIn"),scheduledOut:validateTime(row.scheduledOut,"scheduledOut"),status:parseShiftStatus(row.status),reason:String(row.reason??"").trim()}));
  for(const row of rows)if(minutesOf(row.scheduledOut)<=minutesOf(row.scheduledIn))throw new Error(`scheduledOut must be later than scheduledIn for ${row.employeeId}`);
  uniqueRows(rows);
  const employeeIds=[...new Set(rows.map(row=>row.employeeId))],employees=await loadActiveEmployees(env,employeeIds),fromDate=rows.map(row=>row.workDate).sort()[0]!,toDate=rows.map(row=>row.workDate).sort().at(-1)!,wages=await loadWages(env,employeeIds,fromDate,toDate);
  const planned:PlannedShift[]=rows.map(row=>{const employee=employees.get(row.employeeId)!;return{...row,employee,wage:wageFor(employee,row.workDate,wages)};});
  let inserted=0;const jobs:SheetsSyncJob[]=[],operationId=`shift_${crypto.randomUUID()}`,createdAt=new Date().toISOString();
  for(let offset=0;offset<planned.length;offset+=40){
    const chunk=planned.slice(offset,offset+40),statements:D1PreparedStatement[]=[];
    for(const row of chunk){
      const reason=row.reason||defaultReason,auditId=crypto.randomUUID();
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO employee_shift_days(employee_id,work_date,scheduled_in,scheduled_out,daily_wage_snapshot_satang,wage_source_id,status,note,version,created_at,updated_at,created_action_id) VALUES(?,?,?,?,?,?,?,?,1,?,?,?)`).bind(row.employeeId,row.workDate,row.scheduledIn,row.scheduledOut,row.wage.dailyWageSatang,row.wage.wageSourceId,row.status,reason,createdAt,createdAt,operationId));
      statements.push(env.DB.prepare(`INSERT INTO shift_schedule_audit(audit_id,employee_id,work_date,previous_status,new_status,previous_scheduled_in,previous_scheduled_out,new_scheduled_in,new_scheduled_out,changed_by,reason,action,created_at) SELECT ?,employee_id,work_date,NULL,status,NULL,NULL,scheduled_in,scheduled_out,?,?,?,? FROM employee_shift_days WHERE employee_id=? AND work_date=? AND created_action_id=?`).bind(auditId,changedBy,reason,context.action,createdAt,row.employeeId,row.workDate,operationId));
    }
    const results=await env.DB.batch(statements);
    for(let index=0;index<chunk.length;index++){
      const row=chunk[index]!,shiftChanges=Number(results[index*2]?.meta.changes||0),auditChanges=Number(results[index*2+1]?.meta.changes||0);
      if(shiftChanges!==auditChanges)throw new Error(`Schedule audit mismatch for ${row.employeeId}|${row.workDate}`);
      if(shiftChanges===1){inserted++;jobs.push({kind:"SHEETS_SYNC",entityType:"SHIFT_SCHEDULE",entityKey:`${row.employeeId}|${row.workDate}`,entityVersion:1,traceId:operationId});}
    }
  }
  // A full default schedule can contain hundreds of rows. Pace these writes
  // below the Google Sheets per-user quota instead of releasing them at once.
  await enqueueSheetSyncBatch(env,jobs,true);
  return{inserted,existing:planned.length-inserted};
}
export async function generateDefaultSchedule(env:Env,input:GenerateDefaultScheduleInput):Promise<{inserted:number;existing:number;requested:number}>{
  if(!Array.isArray(input.employeeIds)||input.employeeIds.length<1||input.employeeIds.length>50)throw new Error("employeeIds must contain 1-50 employees");
  const employeeIds=input.employeeIds.map(validateEmployeeId);
  if(new Set(employeeIds).size!==employeeIds.length)throw new Error("employeeIds must be unique");
  const fromDate=validateDate(input.fromDate,"fromDate"),toDate=validateDate(input.toDate,"toDate"),scheduledIn=validateTime(input.scheduledIn,"scheduledIn"),scheduledOut=validateTime(input.scheduledOut,"scheduledOut"),changedBy=requiredText(input.changedBy,"changedBy",100),reason=requiredText(input.reason,"reason",500),dates=dateRange(fromDate,toDate);
  const employees=await loadActiveEmployees(env,employeeIds);
  for(const employeeId of employeeIds){const employee=employees.get(employeeId)!;if(employee.scheduledIn!==scheduledIn||employee.scheduledOut!==scheduledOut)throw new Error(`Default shift does not match Staff Config for ${employeeId}`);}
  const rows=employeeIds.flatMap(employeeId=>dates.map(workDate=>({employeeId,workDate,scheduledIn,scheduledOut,status:"EXPECTED" as const,reason}))),result=await insertMissingScheduleRows(env,rows,{changedBy,action:"DEFAULT_GENERATION",reason});
  return{...result,requested:rows.length};
}
export async function overrideShiftSchedule(env:Env,input:OverrideShiftInput):Promise<{employeeId:string;workDate:string;previousStatus:ShiftStatus;newStatus:ShiftStatus;version:number}>{
  const employeeId=validateEmployeeId(input.employeeId),workDate=validateDate(input.workDate,"workDate"),newStatus=parseShiftStatus(input.newStatus),changedBy=requiredText(input.changedBy,"changedBy",100),reason=requiredText(input.reason,"reason",500);
  await loadActiveEmployees(env,[employeeId]);
  const row=await env.DB.prepare(`SELECT employee_id,work_date,scheduled_in,scheduled_out,status,version FROM employee_shift_days WHERE employee_id=? AND work_date=?`).bind(employeeId,workDate).first<ShiftRow>();
  if(!row)throw new Error("Shift schedule row not found; generate defaults before overriding");
  const previousStatus=parseShiftStatus(row.status);
  if(previousStatus===newStatus)throw new Error(`Shift status is already ${newStatus}`);
  const previousVersion=Number(row.version||0),version=previousVersion+1,now=new Date().toISOString(),auditId=crypto.randomUUID();
  const results=await env.DB.batch([
    env.DB.prepare(`INSERT INTO shift_schedule_audit(audit_id,employee_id,work_date,previous_status,new_status,previous_scheduled_in,previous_scheduled_out,new_scheduled_in,new_scheduled_out,changed_by,reason,action,created_at) SELECT ?,employee_id,work_date,status,?,scheduled_in,scheduled_out,scheduled_in,scheduled_out,?,?, 'OWNER_OVERRIDE',? FROM employee_shift_days WHERE employee_id=? AND work_date=? AND version=? AND status=?`).bind(auditId,newStatus,changedBy,reason,now,employeeId,workDate,previousVersion,previousStatus),
    env.DB.prepare(`UPDATE employee_shift_days SET status=?,note=?,version=version+1,updated_at=? WHERE employee_id=? AND work_date=? AND version=? AND status=?`).bind(newStatus,reason,now,employeeId,workDate,previousVersion,previousStatus)
  ]);
  if(Number(results[0]?.meta.changes||0)!==1||Number(results[1]?.meta.changes||0)!==1)throw new Error("Shift changed concurrently; reload before retrying");
  await enqueueSheetSyncBatch(env,[{kind:"SHEETS_SYNC",entityType:"SHIFT_SCHEDULE",entityKey:`${employeeId}|${workDate}`,entityVersion:version,traceId:`shift_override_${auditId}`}]);
  return{employeeId,workDate,previousStatus,newStatus,version};
}
