import { calculatePayroll } from "../domain/payroll";
import { isIsoDate,payrollPeriodFor } from "../shared/time";
import type { Employee,Env } from "../types";
import { approvedOtSatangForDay,employeeFromRow } from "./repository";
import { recalculateDailyPayroll } from "./recalculate";

export interface PayrollRangeInput{
  fromDate?:string;
  toDate?:string;
  runId?:string;
  requestedBy?:string;
}

interface PreviewRow{
  workDate:string;
  employeeId:string;
  staffName:string;
  wageSourceId:string;
  dailyWageBaht:number;
  timeIn:string|null;
  timeOut:string|null;
  lateMinutes:number;
  lateDeductionBaht:number;
  missingPunchType:string;
  missingPunchDeductionBaht:number;
  otApprovedBaht:number;
  netPayBaht:number;
  payStatus:string;
}

interface EmployeeSummary{
  employeeId:string;
  staffName:string;
  workDays:number;
  baseWageBaht:number;
  lateDeductionBaht:number;
  missingPunchDeductionBaht:number;
  otApprovedBaht:number;
  netPayBaht:number;
  pendingReviewCount:number;
}

function satangToBaht(value:number):number{return Math.round(value)/100;}
function validatePeriod(input:PayrollRangeInput):{fromDate:string;toDate:string;payDate:string}{
  const fromDate=String(input.fromDate||""),toDate=String(input.toDate||"");
  if(!isIsoDate(fromDate)||!isIsoDate(toDate))throw new Error("fromDate and toDate must be YYYY-MM-DD");
  const period=payrollPeriodFor(fromDate);
  if(fromDate!==period.weekStart||toDate!==period.weekEnd)throw new Error(`Payroll period must be Monday-Sunday: ${period.weekStart} to ${period.weekEnd}`);
  return{fromDate,toDate,payDate:period.payDate};
}

export async function previewPayrollRange(env:Env,input:PayrollRangeInput):Promise<{periodStart:string;periodEnd:string;payDate:string;rowCount:number;totalNetPayBaht:number;pendingReviewCount:number;employees:EmployeeSummary[];rows:PreviewRow[]}>{
  const{fromDate,toDate,payDate}=validatePeriod(input),result=await env.DB.prepare(`SELECT d.*,e.staff_name,e.line_user_id,e.can_submit_expense,e.status FROM attendance_daily d JOIN employees e ON e.employee_id=d.employee_id WHERE d.work_date BETWEEN ? AND ? ORDER BY d.employee_id,d.work_date`).bind(fromDate,toDate).all<Record<string,unknown>>(),rows:PreviewRow[]=[],summaries=new Map<string,EmployeeSummary>();
  for(const row of result.results||[]){
    const employee:Employee=employeeFromRow(row),workDate=String(row.work_date),wageSatang=Number(row.daily_wage_snapshot_satang||row.daily_wage_satang||employee.dailyWageSatang),otApprovedSatang=await approvedOtSatangForDay(env,employee.employeeId,workDate),payroll=calculatePayroll({employee:{...employee,dailyWageSatang:wageSatang},timeIn:row.time_in?String(row.time_in):null,timeOut:row.time_out?String(row.time_out):null,review:Number(row.review_flag||0)===1,finalizeMissingPunch:true,otApprovedSatang,otherAdjustmentSatang:Number(row.other_adjustment_satang||0)}),staffName=String(row.staff_name),previewRow:PreviewRow={workDate,employeeId:employee.employeeId,staffName,wageSourceId:String(row.wage_source_id||"LEGACY_SNAPSHOT"),dailyWageBaht:satangToBaht(wageSatang),timeIn:row.time_in?String(row.time_in):null,timeOut:row.time_out?String(row.time_out):null,lateMinutes:payroll.lateMinutes,lateDeductionBaht:satangToBaht(payroll.appliedLateDeductionSatang),missingPunchType:payroll.missingPunchType,missingPunchDeductionBaht:satangToBaht(payroll.appliedMissingPunchDeductionSatang),otApprovedBaht:satangToBaht(payroll.otApprovedSatang),netPayBaht:satangToBaht(payroll.netPaySatang),payStatus:payroll.payStatus};
    rows.push(previewRow);
    const summary=summaries.get(employee.employeeId)||{employeeId:employee.employeeId,staffName,workDays:0,baseWageBaht:0,lateDeductionBaht:0,missingPunchDeductionBaht:0,otApprovedBaht:0,netPayBaht:0,pendingReviewCount:0};
    summary.workDays+=1;summary.baseWageBaht+=previewRow.dailyWageBaht;summary.lateDeductionBaht+=previewRow.lateDeductionBaht;summary.missingPunchDeductionBaht+=previewRow.missingPunchDeductionBaht;summary.otApprovedBaht+=previewRow.otApprovedBaht;summary.netPayBaht+=previewRow.netPayBaht;if(previewRow.payStatus==="REVIEW")summary.pendingReviewCount+=1;summaries.set(employee.employeeId,summary);
  }
  const employees=Array.from(summaries.values()).map(item=>({...item,baseWageBaht:Number(item.baseWageBaht.toFixed(2)),lateDeductionBaht:Number(item.lateDeductionBaht.toFixed(2)),missingPunchDeductionBaht:Number(item.missingPunchDeductionBaht.toFixed(2)),otApprovedBaht:Number(item.otApprovedBaht.toFixed(2)),netPayBaht:Number(item.netPayBaht.toFixed(2))})),totalNetPayBaht=Number(employees.reduce((sum,item)=>sum+item.netPayBaht,0).toFixed(2)),pendingReviewCount=employees.reduce((sum,item)=>sum+item.pendingReviewCount,0);
  return{periodStart:fromDate,periodEnd:toDate,payDate,rowCount:rows.length,totalNetPayBaht,pendingReviewCount,employees,rows};
}

export async function applyPayrollRange(env:Env,input:PayrollRangeInput):Promise<{runId:string;alreadyApplied:boolean;preview:Awaited<ReturnType<typeof previewPayrollRange>>}>{
  const period=validatePeriod(input),runId=String(input.runId||"").trim(),requestedBy=String(input.requestedBy||"OWNER").trim();
  if(!/^[A-Za-z0-9_-]{8,80}$/.test(runId))throw new Error("runId must be 8-80 characters using letters, numbers, _ or -");
  const existing=await env.DB.prepare(`SELECT status,summary_json FROM payroll_runs WHERE run_id=?`).bind(runId).first<{status:string;summary_json:string}>();
  if(existing?.status==="COMPLETED")return{runId,alreadyApplied:true,preview:JSON.parse(existing.summary_json) as Awaited<ReturnType<typeof previewPayrollRange>>};
  if(existing)throw new Error(`Payroll run ${runId} is ${existing.status}; inspect before retrying with a new runId`);
  const previewBeforeApply=await previewPayrollRange(env,input);
  if(previewBeforeApply.rowCount===0)throw new Error("Payroll period has no attendance rows; nothing to apply");
  const now=new Date().toISOString(),inserted=await env.DB.prepare(`INSERT INTO payroll_runs(run_id,period_start,period_end,pay_date,status,requested_by,created_at,updated_at) VALUES(?,?,?,?,'PROCESSING',?,?,?)`).bind(runId,period.fromDate,period.toDate,period.payDate,requestedBy,now,now).run();
  if(Number(inserted.meta.changes||0)!==1)throw new Error("Unable to claim payroll run");
  try{
    const result=await env.DB.prepare(`SELECT employee_id,work_date FROM attendance_daily WHERE work_date BETWEEN ? AND ? ORDER BY employee_id,work_date`).bind(period.fromDate,period.toDate).all<{employee_id:string;work_date:string}>();
    for(const row of result.results||[])await recalculateDailyPayroll(env,String(row.employee_id),String(row.work_date),{finalizeMissingPunch:true,traceId:`payroll_run_${runId}`});
    const preview=await previewPayrollRange(env,input),completedAt=new Date().toISOString();
    await env.DB.prepare(`UPDATE payroll_runs SET status='COMPLETED',row_count=?,total_net_pay_satang=?,summary_json=?,completed_at=?,updated_at=? WHERE run_id=? AND status='PROCESSING'`).bind(preview.rowCount,Math.round(preview.totalNetPayBaht*100),JSON.stringify(preview),completedAt,completedAt,runId).run();
    return{runId,alreadyApplied:false,preview};
  }catch(error){const failedAt=new Date().toISOString();await env.DB.prepare(`UPDATE payroll_runs SET status='FAILED',error=?,updated_at=? WHERE run_id=?`).bind(String(error),failedAt,runId).run();throw error;}
}
