import { addDays,weekStartMonday } from "../shared/time";
import type { Employee,Env,WageSnapshot } from "../types";

export function employeeFromRow(row:Record<string,unknown>):Employee{return{
  employeeId:String(row.employee_id),staffName:String(row.staff_name),lineUserId:String(row.line_user_id),
  scheduledIn:String(row.scheduled_in),scheduledOut:String(row.scheduled_out),dailyWageSatang:Number(row.daily_wage_satang),
  graceMin:Number(row.grace_min),lateDeductionSatang:Number(row.late_deduction_satang),earlyDeductionSatang:Number(row.early_deduction_satang),
  canSubmitExpense:Number(row.can_submit_expense)===1,status:String(row.status)==="ACTIVE"?"ACTIVE":"INACTIVE"
};}

export async function getEmployeeById(env:Env,employeeId:string):Promise<Employee|null>{
  const row=await env.DB.prepare(`SELECT employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,daily_wage_satang,grace_min,late_deduction_satang,early_deduction_satang,can_submit_expense,status FROM employees WHERE employee_id=? LIMIT 1`).bind(employeeId).first<Record<string,unknown>>();
  return row?employeeFromRow(row):null;
}

export async function resolveWageSnapshot(env:Env,employee:Employee,workDate:string):Promise<WageSnapshot>{
  const row=await env.DB.prepare(`SELECT wage_id,daily_wage_satang,effective_from,effective_to FROM employee_wage_history WHERE employee_id=? AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY effective_from DESC LIMIT 1`).bind(employee.employeeId,workDate,workDate).first<Record<string,unknown>>();
  if(row)return{wageSourceId:String(row.wage_id),dailyWageSatang:Number(row.daily_wage_satang),effectiveFrom:String(row.effective_from),effectiveTo:row.effective_to==null?null:String(row.effective_to)};
  return{wageSourceId:"EMPLOYEE_CURRENT_FALLBACK",dailyWageSatang:employee.dailyWageSatang,effectiveFrom:workDate,effectiveTo:null};
}

export async function approvedOtSatangForDay(env:Env,employeeId:string,workDate:string):Promise<number>{
  const row=await env.DB.prepare(`SELECT COALESCE(SUM(owner_final_amount_satang),0) amount FROM ot_requests WHERE employee_id=? AND work_date=? AND status='APPROVED' AND owner_final_status='APPROVED'`).bind(employeeId,workDate).first<{amount:number}>();
  return Number(row?.amount||0);
}

export function weeklyPayrollStatement(env:Env,employeeId:string,workDate:string,version:number,now:string):D1PreparedStatement{
  const weekStart=weekStartMonday(workDate),paySunday=addDays(weekStart,6);
  return env.DB.prepare(`INSERT INTO payroll_weekly(
    employee_id,week_start,pay_sunday,work_days,confirmed_amount_satang,pending_amount_satang,status,version,updated_at,
    base_wage_satang,late_deduction_total_satang,missing_punch_deduction_total_satang,ot_total_satang,other_adjustment_total_satang,net_pay_satang,pending_review_count
  ) SELECT ?,?,?,
    COALESCE(SUM(CASE WHEN time_in IS NOT NULL OR time_out IS NOT NULL THEN 1 ELSE 0 END),0),
    COALESCE(SUM(confirmed_wage_satang),0),COALESCE(SUM(pending_wage_satang),0),
    CASE WHEN COALESCE(SUM(CASE WHEN pay_status='REVIEW' THEN 1 ELSE 0 END),0)>0 THEN 'REVIEW' WHEN COALESCE(SUM(confirmed_wage_satang),0)>0 THEN 'READY' ELSE 'NO_AMOUNT' END,
    ?,?,COALESCE(SUM(daily_wage_snapshot_satang),0),COALESCE(SUM(late_deduction_applied_satang),0),
    COALESCE(SUM(missing_punch_deduction_satang),0),COALESCE(SUM(ot_approved_satang),0),COALESCE(SUM(other_adjustment_satang),0),
    COALESCE(SUM(confirmed_wage_satang),0),COALESCE(SUM(CASE WHEN pay_status='REVIEW' THEN 1 ELSE 0 END),0)
  FROM attendance_daily WHERE employee_id=? AND work_date BETWEEN ? AND ?
  ON CONFLICT(employee_id,week_start) DO UPDATE SET
    work_days=excluded.work_days,confirmed_amount_satang=excluded.confirmed_amount_satang,pending_amount_satang=excluded.pending_amount_satang,
    status=excluded.status,version=payroll_weekly.version+1,updated_at=excluded.updated_at,base_wage_satang=excluded.base_wage_satang,
    late_deduction_total_satang=excluded.late_deduction_total_satang,missing_punch_deduction_total_satang=excluded.missing_punch_deduction_total_satang,
    ot_total_satang=excluded.ot_total_satang,other_adjustment_total_satang=excluded.other_adjustment_total_satang,net_pay_satang=excluded.net_pay_satang,
    pending_review_count=excluded.pending_review_count`).bind(employeeId,weekStart,paySunday,version,now,employeeId,weekStart,paySunday);
}

export async function refreshWeeklyPayroll(env:Env,employeeId:string,workDate:string,version:number,now=new Date().toISOString()):Promise<number>{
  await weeklyPayrollStatement(env,employeeId,workDate,version,now).run();
  const weekStart=weekStartMonday(workDate),row=await env.DB.prepare(`SELECT version FROM payroll_weekly WHERE employee_id=? AND week_start=?`).bind(employeeId,weekStart).first<{version:number}>();
  return Number(row?.version||version);
}
