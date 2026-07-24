import { enqueueSheetSync } from "../db/repositories";
import { calculatePayroll } from "../domain/payroll";
import { approvedOtSatangForDay,getEmployeeById,refreshWeeklyPayroll,resolveWageSnapshot } from "./repository";
import { weekStartMonday } from "../shared/time";
import type { Env } from "../types";

export async function recalculateDailyPayroll(env:Env,employeeId:string,workDate:string,options:{finalizeMissingPunch?:boolean;forceReview?:boolean;traceId?:string}={}):Promise<{version:number;weeklyVersion:number}>{
  const employee=await getEmployeeById(env,employeeId);if(!employee)throw new Error("Employee not found");
  const row=await env.DB.prepare(`SELECT * FROM attendance_daily WHERE employee_id=? AND work_date=?`).bind(employeeId,workDate).first<Record<string,unknown>>();if(!row)throw new Error("Daily payroll not found");
  const previousWage=Number(row.daily_wage_snapshot_satang||row.daily_wage_satang||0),resolved=previousWage>0?{wageSourceId:String(row.wage_source_id||"LEGACY_SNAPSHOT"),dailyWageSatang:previousWage}:await resolveWageSnapshot(env,employee,workDate),otApprovedSatang=await approvedOtSatangForDay(env,employeeId,workDate);
  const review=options.forceReview===true||Number(row.review_flag||0)===1,payroll=calculatePayroll({employee:{...employee,dailyWageSatang:resolved.dailyWageSatang},timeIn:row.time_in?String(row.time_in):null,timeOut:row.time_out?String(row.time_out):null,review,finalizeMissingPunch:options.finalizeMissingPunch===true,otApprovedSatang,otherAdjustmentSatang:Number(row.other_adjustment_satang||0)}),version=Number(row.version||0)+1,now=new Date().toISOString();
  await env.DB.prepare(`UPDATE attendance_daily SET work_minutes=?,late_minutes=?,early_out_minutes=?,daily_wage_satang=?,confirmed_wage_satang=?,pending_wage_satang=?,pay_status=?,version=?,updated_at=?,wage_source_id=?,daily_wage_snapshot_satang=?,late_deduction_applied_satang=?,missing_punch_type=?,missing_punch_deduction_satang=?,ot_approved_satang=?,other_adjustment_satang=?,net_pay_satang=?,payroll_policy_code=?,finalized_at=? WHERE employee_id=? AND work_date=?`).bind(payroll.workMinutes,payroll.lateMinutes,payroll.earlyOutMinutes,resolved.dailyWageSatang,payroll.confirmedWageSatang,payroll.pendingWageSatang,payroll.payStatus,version,now,resolved.wageSourceId,resolved.dailyWageSatang,payroll.appliedLateDeductionSatang,payroll.missingPunchType,payroll.appliedMissingPunchDeductionSatang,payroll.otApprovedSatang,payroll.otherAdjustmentSatang,payroll.netPaySatang,payroll.policyCode,options.finalizeMissingPunch===true?now:null,employeeId,workDate).run();
  const weeklyVersion=await refreshWeeklyPayroll(env,employeeId,workDate,version,now),traceId=options.traceId||`payroll_${crypto.randomUUID()}`,weekStart=weekStartMonday(workDate);
  await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"DAILY_PAYROLL",entityKey:`${employeeId}|${workDate}`,entityVersion:version,traceId});
  await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"WEEKLY_PAYROLL",entityKey:`${employeeId}|${weekStart}`,entityVersion:weeklyVersion,traceId});
  return{version,weeklyVersion};
}
