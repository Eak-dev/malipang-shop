import { enqueueSheetSync } from "../db/repositories";
import { calculatePayroll } from "../domain/payroll";
import { approvedOtSatangForDay,getEmployeeById,preservedWageSnapshot,refreshWeeklyPayroll,resolveWageSnapshot } from "./repository";
import { weeklyPayrollEntityKey } from "../shared/time";
import type { Env } from "../types";

export async function recalculateDailyPayroll(env:Env,employeeId:string,workDate:string,options:{finalizeMissingPunch?:boolean;forceReview?:boolean;traceId?:string}={}):Promise<{version:number;weeklyVersion:number}>{
  const employee=await getEmployeeById(env,employeeId);if(!employee)throw new Error("Employee not found");
  const row=await env.DB.prepare(`SELECT * FROM attendance_daily WHERE employee_id=? AND work_date=?`).bind(employeeId,workDate).first<Record<string,unknown>>();if(!row)throw new Error("Daily payroll not found");
  const resolved=preservedWageSnapshot(row)||await resolveWageSnapshot(env,employee,workDate),otApprovedSatang=await approvedOtSatangForDay(env,employeeId,workDate);
  // A later OT recalculation must not reopen a previously finalized punch.
  // Malformed historical markers cannot establish finalization and require review.
  const finalizedAt=row.finalized_at==null?null:String(row.finalized_at);
  if(finalizedAt!==null&&!Number.isFinite(Date.parse(finalizedAt)))throw new Error("PAYROLL_FINALIZATION_REVIEW_REQUIRED");
  const finalizeMissingPunch=options.finalizeMissingPunch===true||finalizedAt!==null;
  const review=options.forceReview===true||Number(row.review_flag||0)===1,payroll=calculatePayroll({employee:{...employee,dailyWageSatang:resolved.dailyWageSatang},timeIn:row.time_in?String(row.time_in):null,timeOut:row.time_out?String(row.time_out):null,review,finalizeMissingPunch,otApprovedSatang,otherAdjustmentSatang:Number(row.other_adjustment_satang||0)}),version=Number(row.version||0)+1,now=new Date().toISOString();
  const updated=await env.DB.prepare(`UPDATE attendance_daily SET work_minutes=?,late_minutes=?,early_out_minutes=?,daily_wage_satang=?,confirmed_wage_satang=?,pending_wage_satang=?,pay_status=?,version=?,updated_at=?,wage_source_id=?,daily_wage_snapshot_satang=?,late_deduction_applied_satang=?,missing_punch_type=?,missing_punch_deduction_satang=?,ot_approved_satang=?,other_adjustment_satang=?,net_pay_satang=?,payroll_policy_code=?,finalized_at=? WHERE employee_id=? AND work_date=? AND version=? AND finalized_at IS ? AND time_in IS ? AND time_out IS ? AND review_flag IS ? AND daily_wage_snapshot_satang IS ? AND other_adjustment_satang IS ? AND (SELECT COALESCE(SUM(owner_final_amount_satang),0) FROM ot_requests WHERE employee_id=? AND work_date=? AND status='APPROVED' AND owner_final_status='APPROVED')=?`).bind(payroll.workMinutes,payroll.lateMinutes,payroll.earlyOutMinutes,resolved.dailyWageSatang,payroll.confirmedWageSatang,payroll.pendingWageSatang,payroll.payStatus,version,now,resolved.wageSourceId,resolved.dailyWageSatang,payroll.appliedLateDeductionSatang,payroll.missingPunchType,payroll.appliedMissingPunchDeductionSatang,payroll.otApprovedSatang,payroll.otherAdjustmentSatang,payroll.netPaySatang,payroll.policyCode,finalizedAt||(finalizeMissingPunch?now:null),employeeId,workDate,Number(row.version||0),row.finalized_at??null,row.time_in??null,row.time_out??null,row.review_flag??null,row.daily_wage_snapshot_satang??null,row.other_adjustment_satang??null,employeeId,workDate,otApprovedSatang).run();
  if(Number(updated.meta.changes||0)!==1)throw new Error("PAYROLL_SNAPSHOT_CHANGED_REVIEW_REQUIRED");
  const weeklyVersion=await refreshWeeklyPayroll(env,employeeId,workDate,version,now),traceId=options.traceId||`payroll_${crypto.randomUUID()}`;
  await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"DAILY_PAYROLL",entityKey:`${employeeId}|${workDate}`,entityVersion:version,traceId});
  await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"WEEKLY_PAYROLL",entityKey:weeklyPayrollEntityKey(employeeId,workDate),entityVersion:weeklyVersion,traceId});
  return{version,weeklyVersion};
}
