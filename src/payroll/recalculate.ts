import { enqueueSheetSync } from "../db/repositories";
import { calculatePayroll } from "../domain/payroll";
import { approvedOtSatangForDay,getEmployeeById,preservedWageSnapshot,resolveWageSnapshot,weeklyPayrollStatement } from "./repository";
import { payrollPeriodFor,weeklyPayrollEntityKey } from "../shared/time";
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
  const daily=env.DB.prepare(`UPDATE attendance_daily SET work_minutes=?,late_minutes=?,early_out_minutes=?,daily_wage_satang=?,confirmed_wage_satang=?,pending_wage_satang=?,pay_status=?,version=?,updated_at=?,wage_source_id=?,daily_wage_snapshot_satang=?,late_deduction_applied_satang=?,missing_punch_type=?,missing_punch_deduction_satang=?,ot_approved_satang=?,other_adjustment_satang=?,net_pay_satang=?,payroll_policy_code=?,finalized_at=? WHERE employee_id=? AND work_date=? AND version=? AND finalized_at IS ? AND time_in IS ? AND time_out IS ? AND review_flag IS ? AND daily_wage_snapshot_satang IS ? AND other_adjustment_satang IS ? AND (SELECT COALESCE(SUM(owner_final_amount_satang),0) FROM ot_requests WHERE employee_id=? AND work_date=? AND status='APPROVED' AND owner_final_status='APPROVED')=?`).bind(payroll.workMinutes,payroll.lateMinutes,payroll.earlyOutMinutes,resolved.dailyWageSatang,payroll.confirmedWageSatang,payroll.pendingWageSatang,payroll.payStatus,version,now,resolved.wageSourceId,resolved.dailyWageSatang,payroll.appliedLateDeductionSatang,payroll.missingPunchType,payroll.appliedMissingPunchDeductionSatang,payroll.otApprovedSatang,payroll.otherAdjustmentSatang,payroll.netPaySatang,payroll.policyCode,finalizedAt||(finalizeMissingPunch?now:null),employeeId,workDate,Number(row.version||0),row.finalized_at??null,row.time_in??null,row.time_out??null,row.review_flag??null,row.daily_wage_snapshot_satang??null,row.other_adjustment_satang??null,employeeId,workDate,otApprovedSatang);
  const traceId=options.traceId||`payroll_${crypto.randomUUID()}`,weekStart=payrollPeriodFor(workDate).weekStart;
  const guard=env.DB.prepare(`SELECT CASE WHEN changes()=1 THEN 1 ELSE json('PAYROLL_SNAPSHOT_CHANGED_REVIEW_REQUIRED') END`);
  const dailyOutbox=env.DB.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) VALUES(?,'DAILY_PAYROLL',?,?,?,'PENDING',0,?,?,NULL,NULL) ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING`).bind(crypto.randomUUID(),`${employeeId}|${workDate}`,version,traceId,now,now);
  const weeklyOutbox=env.DB.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) SELECT ?,'WEEKLY_PAYROLL',employee_id||'|'||week_start,version,?,'PENDING',0,?,?,NULL,NULL FROM payroll_weekly WHERE employee_id=? AND week_start=? ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING`).bind(crypto.randomUUID(),traceId,now,now,employeeId,weekStart);
  const readWeekly=env.DB.prepare(`SELECT version FROM payroll_weekly WHERE employee_id=? AND week_start=?`).bind(employeeId,weekStart);
  let results:D1Result<{version:number}>[];
  try{results=await env.DB.batch<{version:number}>([daily,guard,weeklyPayrollStatement(env,employeeId,workDate,version,now),dailyOutbox,weeklyOutbox,readWeekly]);}
  catch(error){if(String(error).includes('malformed JSON'))throw new Error("PAYROLL_SNAPSHOT_CHANGED_REVIEW_REQUIRED");throw error;}
  const weeklyVersion=Number(results[5]?.results?.[0]?.version||0);if(!weeklyVersion)throw new Error("WEEKLY_PAYROLL_VERSION_MISSING");
  await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"DAILY_PAYROLL",entityKey:`${employeeId}|${workDate}`,entityVersion:version,traceId});
  await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"WEEKLY_PAYROLL",entityKey:weeklyPayrollEntityKey(employeeId,workDate),entityVersion:weeklyVersion,traceId});
  return{version,weeklyVersion};
}
