import { enqueueSheetSync } from "../db/repositories";
import { calculatePayroll } from "../domain/payroll";
import { isIsoDate,isoDateInBangkok,weeklyPayrollEntityKey } from "../shared/time";
import type { Env } from "../types";
import { getEmployeeById,refreshWeeklyPayroll,resolveWageSnapshot } from "./repository";
import { recalculateDailyPayroll } from "./recalculate";
import { PayrollContextReviewError,resolvePayrollDayContext } from "./day-context";

interface DailyRow{employee_id:string;work_date:string}
interface ShiftRow{employee_id:string;work_date:string;scheduled_in:string;scheduled_out:string;daily_wage_snapshot_satang:number;wage_source_id:string;version:number}
export function shiftStatusCreatesMissingPunch(status:string,employeeStatus="ACTIVE"):boolean{return status==="EXPECTED"&&employeeStatus==="ACTIVE";}
export interface MissingPunchFinalizeScope{employeeIds?:string[];fromDate?:string;toDate?:string}
function finalizeScope(scope:MissingPunchFinalizeScope,today:string):{clause:string;args:unknown[]}{
  const ids=scope.employeeIds?.map(value=>String(value).trim());
  if(ids&&(!ids.length||ids.length>50||ids.some(value=>!/^[A-Za-z0-9_-]{3,64}$/.test(value))))throw new Error("employeeIds must contain 1-50 valid IDs");
  if((scope.fromDate&&!isIsoDate(scope.fromDate))||(scope.toDate&&!isIsoDate(scope.toDate))||(scope.fromDate&&scope.toDate&&scope.fromDate>scope.toDate))throw new Error("fromDate/toDate must be valid and ordered");
  const clauses=["work_date<?"],args:unknown[]=[today];
  if(scope.fromDate){clauses.push("work_date>=?");args.push(scope.fromDate);}
  if(scope.toDate){clauses.push("work_date<=?");args.push(scope.toDate);}
  if(ids){clauses.push(`employee_id IN (${ids.map(()=>"?").join(",")})`);args.push(...ids);}
  return{clause:clauses.join(" AND "),args};
}
export async function finalizeMissingPunchPayrolls(env:Env,scope:MissingPunchFinalizeScope={}):Promise<{onePunch:number;noPunch:number;reviewRequired:number;reviewReasons:Record<string,number>;scanLimitReached:boolean}>{
  const today=isoDateInBangkok(),filter=finalizeScope(scope,today);
  const oneClause=`${filter.clause} AND finalized_at IS NULL AND review_flag=0 AND ((time_in IS NULL AND time_out IS NOT NULL) OR (time_in IS NOT NULL AND time_out IS NULL))`;
  const afterCursor=`(work_date>? OR (work_date=? AND employee_id>?))`;
  let onePunch=0,reviewRequired=0,scanned=0,cursorDate="",cursorEmployee="";const reviewReasons:Record<string,number>={};
  // Scan past blocked rows without unbounded cron work or silently marking them finalized.
  while(scanned<300&&onePunch<100){
    const one=await env.DB.prepare(`SELECT employee_id,work_date FROM attendance_daily WHERE ${oneClause} AND ${afterCursor} ORDER BY work_date,employee_id LIMIT 100`).bind(...filter.args,cursorDate,cursorDate,cursorEmployee).all<DailyRow>();
    const rows=one.results||[];
    for(const row of rows){
      scanned++;cursorDate=String(row.work_date);cursorEmployee=String(row.employee_id);
      try{await recalculateDailyPayroll(env,cursorEmployee,cursorDate,{finalizeMissingPunch:true,traceId:`missing_punch_${cursorEmployee}_${cursorDate}`});onePunch++;}
      catch(error){if(!(error instanceof PayrollContextReviewError))throw error;reviewRequired++;reviewReasons[error.reason]=(reviewReasons[error.reason]||0)+1;}
      if(onePunch>=100)break;
    }
    if(rows.length<100)break;
  }
  const scanLimitReached=scanned>=300&&Boolean(await env.DB.prepare(`SELECT employee_id FROM attendance_daily WHERE ${oneClause} AND ${afterCursor} LIMIT 1`).bind(...filter.args,cursorDate,cursorDate,cursorEmployee).first());
  const shiftClause=filter.clause.replaceAll("work_date","s.work_date").replaceAll("employee_id","s.employee_id"),missing=await env.DB.prepare(`SELECT s.employee_id,s.work_date,s.scheduled_in,s.scheduled_out,s.daily_wage_snapshot_satang,s.wage_source_id,s.version FROM employee_shift_days s JOIN employees e ON e.employee_id=s.employee_id AND e.status='ACTIVE' LEFT JOIN attendance_daily d ON d.employee_id=s.employee_id AND d.work_date=s.work_date WHERE s.status=? AND ${shiftClause} AND d.employee_id IS NULL ORDER BY s.work_date,s.employee_id LIMIT 100`).bind("EXPECTED",...filter.args).all<ShiftRow>();
  let noPunch=0;for(const shift of missing.results||[]){const employee=await getEmployeeById(env,String(shift.employee_id));if(!employee||!shiftStatusCreatesMissingPunch("EXPECTED",employee.status))continue;const wage=await resolveWageSnapshot(env,employee,String(shift.work_date));
    const context=resolvePayrollDayContext(env,{employee:{...employee,scheduledIn:String(shift.scheduled_in),scheduledOut:String(shift.scheduled_out),dailyWageSatang:wage.dailyWageSatang},workDate:String(shift.work_date),timeIn:null,timeOut:null,expectedAbsence:true});
    const payroll=calculatePayroll({...context,timeIn:null,timeOut:null,review:true,finalizeMissingPunch:true}),now=new Date().toISOString(),version=1,shiftVersion=Number(shift.version||0)+1;
    await env.DB.batch([
      env.DB.prepare(`UPDATE employee_shift_days SET daily_wage_snapshot_satang=?,wage_source_id=?,version=version+1,updated_at=? WHERE employee_id=? AND work_date=?`).bind(wage.dailyWageSatang,wage.wageSourceId,now,shift.employee_id,shift.work_date),
      env.DB.prepare(`INSERT OR IGNORE INTO attendance_daily(employee_id,work_date,scheduled_in,scheduled_out,grace_min,late_deduction_satang,early_deduction_satang,time_in,time_out,work_minutes,late_minutes,early_out_minutes,daily_wage_satang,confirmed_wage_satang,pending_wage_satang,pay_status,review_flag,version,updated_at,wage_source_id,daily_wage_snapshot_satang,late_deduction_applied_satang,missing_punch_type,missing_punch_deduction_satang,ot_approved_satang,other_adjustment_satang,net_pay_satang,payroll_policy_code,finalized_at) VALUES(?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(shift.employee_id,shift.work_date,context.employee.scheduledIn,context.employee.scheduledOut,context.employee.graceMin,context.employee.lateDeductionSatang,context.employee.earlyDeductionSatang,payroll.workMinutes,payroll.lateMinutes,payroll.earlyOutMinutes,wage.dailyWageSatang,payroll.confirmedWageSatang,payroll.pendingWageSatang,payroll.payStatus,version,now,wage.wageSourceId,wage.dailyWageSatang,payroll.lateDeductionSatang,payroll.missingPunchType,payroll.missingPunchDeductionSatang,payroll.otApprovedSatang,payroll.otherAdjustmentSatang,payroll.netPaySatang,payroll.policyCode,now)
    ]);
    const weeklyVersion=await refreshWeeklyPayroll(env,String(shift.employee_id),String(shift.work_date),version,now),traceId=`absence_${shift.employee_id}_${shift.work_date}`;await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"SHIFT_SCHEDULE",entityKey:`${shift.employee_id}|${shift.work_date}`,entityVersion:shiftVersion,traceId});await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"DAILY_PAYROLL",entityKey:`${shift.employee_id}|${shift.work_date}`,entityVersion:version,traceId});await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"WEEKLY_PAYROLL",entityKey:weeklyPayrollEntityKey(String(shift.employee_id),String(shift.work_date)),entityVersion:weeklyVersion,traceId});noPunch++;}
  if(reviewRequired||scanLimitReached)console.error("payroll_context_review_required",{count:reviewRequired,reasons:reviewReasons,scanLimitReached});
  return{onePunch,noPunch,reviewRequired,reviewReasons,scanLimitReached};
}
