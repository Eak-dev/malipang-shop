import { enqueueSheetSync } from "../db/repositories";
import { calculatePayroll } from "../domain/payroll";
import { approvedOtSatangForDay,getEmployeeById,preservedWageSnapshot,resolveWageSnapshot,weeklyPayrollStatement } from "./repository";
import { payrollPeriodFor,weeklyPayrollEntityKey } from "../shared/time";
import type { Env } from "../types";

export async function recalculateDailyPayroll(env:Env,employeeId:string,workDate:string,options:{finalizeMissingPunch?:boolean;forceReview?:boolean;traceId?:string}={}):Promise<{version:number;weeklyVersion:number}>{
  const employee=await getEmployeeById(env,employeeId);if(!employee)throw new Error("Employee not found");
  const row=await env.DB.prepare(`SELECT * FROM attendance_daily WHERE employee_id=? AND work_date=?`).bind(employeeId,workDate).first<Record<string,unknown>>();if(!row)throw new Error("Daily payroll not found");
  const storedWage=preservedWageSnapshot(row),resolved=storedWage||await resolveWageSnapshot(env,employee,workDate),otApprovedSatang=await approvedOtSatangForDay(env,employeeId,workDate);
  // When the daily record has no saved wage snapshot, re-prove the selected
  // history entry (or absence of history) inside the write transaction.
  const wageGuard=storedWage?"":resolved.wageSourceId==="EMPLOYEE_CURRENT_FALLBACK"
    ?" AND NOT EXISTS(SELECT 1 FROM employee_wage_history w WHERE w.employee_id=? AND w.effective_from<=? AND (w.effective_to IS NULL OR w.effective_to>=?))"
    :" AND EXISTS(SELECT 1 FROM employee_wage_history w WHERE w.employee_id=? AND w.effective_from<=? AND (w.effective_to IS NULL OR w.effective_to>=?) AND w.wage_id=? AND w.daily_wage_satang=? AND w.effective_from=? AND w.effective_to IS ? AND NOT EXISTS(SELECT 1 FROM employee_wage_history later WHERE later.employee_id=w.employee_id AND later.effective_from<=? AND (later.effective_to IS NULL OR later.effective_to>=?) AND later.effective_from>w.effective_from))";
  const wageArgs:unknown[]=storedWage?[]:resolved.wageSourceId==="EMPLOYEE_CURRENT_FALLBACK"?[employeeId,workDate,workDate]:[employeeId,workDate,workDate,resolved.wageSourceId,resolved.dailyWageSatang,resolved.effectiveFrom,resolved.effectiveTo,workDate,workDate];
  // A later OT recalculation must not reopen a previously finalized punch.
  // Malformed historical markers cannot establish finalization and require review.
  const finalizedAt=row.finalized_at==null?null:String(row.finalized_at);
  if(finalizedAt!==null&&!Number.isFinite(Date.parse(finalizedAt)))throw new Error("PAYROLL_FINALIZATION_REVIEW_REQUIRED");
  const finalizeMissingPunch=options.finalizeMissingPunch===true||finalizedAt!==null;
  const review=options.forceReview===true||Number(row.review_flag||0)===1,payroll=calculatePayroll({employee:{...employee,dailyWageSatang:resolved.dailyWageSatang},timeIn:row.time_in?String(row.time_in):null,timeOut:row.time_out?String(row.time_out):null,review,finalizeMissingPunch,otApprovedSatang,otherAdjustmentSatang:Number(row.other_adjustment_satang||0)}),version=Number(row.version||0)+1,now=new Date().toISOString();
  const daily=env.DB.prepare(`UPDATE attendance_daily SET work_minutes=?,late_minutes=?,early_out_minutes=?,daily_wage_satang=?,confirmed_wage_satang=?,pending_wage_satang=?,pay_status=?,version=?,updated_at=?,wage_source_id=?,daily_wage_snapshot_satang=?,late_deduction_applied_satang=?,missing_punch_type=?,missing_punch_deduction_satang=?,ot_approved_satang=?,other_adjustment_satang=?,net_pay_satang=?,payroll_policy_code=?,finalized_at=? WHERE employee_id=? AND work_date=? AND version=? AND finalized_at IS ? AND time_in IS ? AND time_out IS ? AND review_flag IS ? AND daily_wage_snapshot_satang IS ? AND daily_wage_satang IS ? AND wage_source_id IS ? AND other_adjustment_satang IS ? AND EXISTS(SELECT 1 FROM employees e WHERE e.employee_id=? AND e.scheduled_in=? AND e.scheduled_out=? AND e.daily_wage_satang=? AND e.grace_min=? AND e.late_deduction_satang=? AND e.early_deduction_satang=? AND e.status=?) ${wageGuard} AND (SELECT COALESCE(SUM(owner_final_amount_satang),0) FROM ot_requests WHERE employee_id=? AND work_date=? AND status='APPROVED' AND owner_final_status='APPROVED')=?`).bind(payroll.workMinutes,payroll.lateMinutes,payroll.earlyOutMinutes,resolved.dailyWageSatang,payroll.confirmedWageSatang,payroll.pendingWageSatang,payroll.payStatus,version,now,resolved.wageSourceId,resolved.dailyWageSatang,payroll.appliedLateDeductionSatang,payroll.missingPunchType,payroll.appliedMissingPunchDeductionSatang,payroll.otApprovedSatang,payroll.otherAdjustmentSatang,payroll.netPaySatang,payroll.policyCode,finalizedAt||(finalizeMissingPunch?now:null),employeeId,workDate,Number(row.version||0),row.finalized_at??null,row.time_in??null,row.time_out??null,row.review_flag??null,row.daily_wage_snapshot_satang??null,row.daily_wage_satang??null,row.wage_source_id??null,row.other_adjustment_satang??null,employeeId,employee.scheduledIn,employee.scheduledOut,employee.dailyWageSatang,employee.graceMin,employee.lateDeductionSatang,employee.earlyDeductionSatang,employee.status,...wageArgs,employeeId,workDate,otApprovedSatang);
  const traceId=options.traceId||`payroll_${crypto.randomUUID()}`,weekStart=payrollPeriodFor(workDate).weekStart;
  const guard=env.DB.prepare(`SELECT CASE WHEN changes()=1 THEN 1 ELSE json('PAYROLL_SNAPSHOT_CHANGED_REVIEW_REQUIRED') END`);
  const dailyOutbox=env.DB.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) SELECT ?,'DAILY_PAYROLL',?,?,?,'PENDING',0,?,?,NULL,NULL WHERE NOT EXISTS(SELECT 1 FROM sync_jobs s WHERE s.entity_type='DAILY_PAYROLL' AND s.entity_key=? AND s.entity_version>=?) ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING`).bind(crypto.randomUUID(),`${employeeId}|${workDate}`,version,traceId,now,now,`${employeeId}|${workDate}`,version);
  const weeklyOutbox=env.DB.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token) SELECT ?,'WEEKLY_PAYROLL',employee_id||'|'||week_start,version,?,'PENDING',0,?,?,NULL,NULL FROM payroll_weekly p WHERE employee_id=? AND week_start=? AND NOT EXISTS(SELECT 1 FROM sync_jobs s WHERE s.entity_type='WEEKLY_PAYROLL' AND s.entity_key=p.employee_id||'|'||p.week_start AND s.entity_version>=p.version) ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING`).bind(crypto.randomUUID(),traceId,now,now,employeeId,weekStart);
  // No existing same-or-newer projection may be mistaken for this wakeup.
  // Roll back the source changes instead of overwriting a held or completed job.
  const outboxGuard=()=>env.DB.prepare(`SELECT CASE WHEN changes()=1 THEN 1 ELSE json('PAYROLL_OUTBOX_REVIEW_REQUIRED') END`);
  const readWeekly=env.DB.prepare(`SELECT version FROM payroll_weekly WHERE employee_id=? AND week_start=?`).bind(employeeId,weekStart);
  let results:D1Result<{version:number}>[];
  try{results=await env.DB.batch<{version:number}>([daily,guard,weeklyPayrollStatement(env,employeeId,workDate,version,now),dailyOutbox,outboxGuard(),weeklyOutbox,outboxGuard(),readWeekly]);}
  catch(error){if(String(error).includes('malformed JSON'))throw new Error("PAYROLL_RECALCULATION_REVIEW_REQUIRED");throw error;}
  const weeklyVersion=Number(results[7]?.results?.[0]?.version||0);if(!weeklyVersion)throw new Error("WEEKLY_PAYROLL_VERSION_MISSING");
  await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"DAILY_PAYROLL",entityKey:`${employeeId}|${workDate}`,entityVersion:version,traceId});
  await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"WEEKLY_PAYROLL",entityKey:weeklyPayrollEntityKey(employeeId,workDate),entityVersion:weeklyVersion,traceId});
  return{version,weeklyVersion};
}
