import { getEmployeeById } from "../payroll/repository";
import { getSheetValues } from "../sheets/client";
import { isIsoDate,minutesOf } from "../shared/time";
import type { Env } from "../types";
import { insertMissingScheduleRows,parseShiftStatus } from "./shift-schedule";

function asTime(value:unknown,fallback:string):string{const text=String(value??"").trim()||fallback;minutesOf(text);return text;}
export { parseShiftStatus } from "./shift-schedule";
export interface ShiftSheetImportScope{employeeIds?:string[];fromDate?:string;toDate?:string}
export async function importShiftScheduleFromSheet(env:Env,scope:ShiftSheetImportScope={}):Promise<{count:number;existing:number}>{
  const values=await getSheetValues(env,`'${env.SHEET_SHIFT_SCHEDULE}'!A1:Z1000`);if(!values.length)throw new Error(`Sheet ${env.SHEET_SHIFT_SCHEDULE} is empty`);
  const headers=(values[0]||[]).map(v=>String(v??"").trim()),index=new Map(headers.map((h,i)=>[h,i]));for(const name of["Work_Date","Employee_ID","Status"])if(!index.has(name))throw new Error(`Missing shift column: ${name}`);const at=(row:unknown[],name:string)=>row[index.get(name)!];
  const requestedIds=scope.employeeIds===undefined?null:new Set(scope.employeeIds.map(value=>String(value).trim()));
  if(requestedIds&&(!requestedIds.size||requestedIds.size>50||[...requestedIds].some(value=>!/^[A-Za-z0-9_-]{3,64}$/.test(value))))throw new Error("employeeIds must contain 1-50 valid IDs");
  if((scope.fromDate&&!isIsoDate(scope.fromDate))||(scope.toDate&&!isIsoDate(scope.toDate))||(scope.fromDate&&scope.toDate&&scope.fromDate>scope.toDate))throw new Error("fromDate/toDate must be valid and ordered");
  const source=values.slice(1).filter(row=>String(at(row,"Employee_ID")??"").trim()).map(row=>{const employeeId=String(at(row,"Employee_ID")??"").trim(),workDate=String(at(row,"Work_Date")??"").trim(),status=parseShiftStatus(at(row,"Status"));if(!isIsoDate(workDate))throw new Error(`Invalid Work_Date for ${employeeId}`);return{employeeId,workDate,status,scheduledIn:index.has("Scheduled_In")?at(row,"Scheduled_In"):undefined,scheduledOut:index.has("Scheduled_Out")?at(row,"Scheduled_Out"):undefined,note:index.has("Note")?String(at(row,"Note")??"").trim():""};}).filter(row=>(!requestedIds||requestedIds.has(row.employeeId))&&(!scope.fromDate||row.workDate>=scope.fromDate)&&(!scope.toDate||row.workDate<=scope.toDate));
  if(!source.length)throw new Error("Shift schedule has no data rows");
  const employees=new Map<string,Awaited<ReturnType<typeof getEmployeeById>>>();
  for(const employeeId of new Set(source.map(row=>row.employeeId))){const employee=await getEmployeeById(env,employeeId);if(!employee)throw new Error(`Employee not found: ${employeeId}`);if(employee.status!=="ACTIVE")throw new Error(`Employee is not ACTIVE: ${employeeId}`);employees.set(employeeId,employee);}
  const rows=source.map(row=>{const employee=employees.get(row.employeeId)!;return{employeeId:row.employeeId,workDate:row.workDate,status:row.status,scheduledIn:asTime(row.scheduledIn,employee.scheduledIn),scheduledOut:asTime(row.scheduledOut,employee.scheduledOut),reason:row.note};});
  const result=await insertMissingScheduleRows(env,rows,{changedBy:"ADMIN_SHEET_IMPORT",action:"SHEET_IMPORT",reason:"Initial schedule sheet import"});
  return{count:result.inserted,existing:result.existing};
}
