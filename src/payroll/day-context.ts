import { calculatePayroll,FLAT_LATE_POLICY_CODE,LEGACY_LATE_POLICY_CODE,PAYROLL_POLICY_CODE } from "../domain/payroll";
import type { PayrollPolicyCode } from "../domain/payroll";
import { isIsoDate,isoDateInBangkok,minutesOf } from "../shared/time";
import type { Employee,Env } from "../types";

type DailyRow=Record<string,unknown>;
type ActivationEnv=Pick<Env,"PAYROLL_LATE_V2_EFFECTIVE_FROM"|"PAYROLL_LATE_V2_EMPLOYEE_IDS">;
export interface LatePolicyActivation{effectiveFrom:string|null;employeeIds:string[];active:boolean;}

/** Configuration is deliberately inert unless both an approved date and exact staff scope exist. */
export function latePolicyActivation(env:ActivationEnv):LatePolicyActivation{
  const effectiveFrom=(env.PAYROLL_LATE_V2_EFFECTIVE_FROM||"").trim();
  if(effectiveFrom&&!isIsoDate(effectiveFrom))throw new Error("PAYROLL_LATE_V2_INVALID_EFFECTIVE_FROM");
  const raw=(env.PAYROLL_LATE_V2_EMPLOYEE_IDS||"").trim(),employeeIds=raw?raw.split(",").map(id=>id.trim()):[];
  if(employeeIds.length>200||new Set(employeeIds).size!==employeeIds.length||employeeIds.some(id=>!/^[A-Za-z0-9_-]{1,40}$/.test(id)))throw new Error("PAYROLL_LATE_V2_INVALID_EMPLOYEE_SCOPE");
  return{effectiveFrom:effectiveFrom||null,employeeIds,active:Boolean(effectiveFrom&&employeeIds.length)};
}

export interface PayrollDayContextInput{
  employee:Employee;
  workDate:string;
  daily?:DailyRow|null;
  timeIn:string|null;
  timeOut:string|null;
  /** Only the expected-shift finalizer may create an unpunched historical review row. */
  expectedAbsence?:boolean;
  today?:string;
}
export interface PayrollDayContext{employee:Employee;policyCode:PayrollPolicyCode;}

export class PayrollContextReviewError extends Error{
  constructor(readonly reason:string){super(reason);this.name="PayrollContextReviewError";}
}
function reviewRequired(reason:string):never{throw new PayrollContextReviewError(`PAYROLL_CONTEXT_REVIEW_REQUIRED:${reason}`);}
function snapshotNumber(row:DailyRow,key:string):number{
  const value=row[key];
  if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0)return reviewRequired(`INVALID_${key}`);
  return value;
}
function snapshotTime(row:DailyRow,key:string):string{
  const value=row[key];
  if(typeof value!=="string")return reviewRequired(`MISSING_${key}`);
  try{minutesOf(value);}catch{return reviewRequired(`INVALID_${key}`);}
  return value;
}
function employeeSnapshot(employee:Employee,row:DailyRow):Employee{
  const wageKey=row.daily_wage_snapshot_satang==null?"daily_wage_satang":"daily_wage_snapshot_satang";
  return{...employee,scheduledIn:snapshotTime(row,"scheduled_in"),scheduledOut:snapshotTime(row,"scheduled_out"),
    graceMin:snapshotNumber(row,"grace_min"),lateDeductionSatang:snapshotNumber(row,"late_deduction_satang"),
    earlyDeductionSatang:snapshotNumber(row,"early_deduction_satang"),dailyWageSatang:snapshotNumber(row,wageKey)};
}

/** V1 writers previously used current config while retaining older columns. Do not reprice that ambiguity. */
function verifyV1Context(snapshot:Employee,row:DailyRow):void{
  // Use stored wage/OT/adjustment, not today's wage or newly approved OT, when checking prior evidence.
  const prior=calculatePayroll({employee:snapshot,timeIn:row.time_in?String(row.time_in):null,timeOut:row.time_out?String(row.time_out):null,
    review:Number(row.review_flag||0)===1,finalizeMissingPunch:Boolean(row.finalized_at),
    otApprovedSatang:Number(row.ot_approved_satang||0),otherAdjustmentSatang:Number(row.other_adjustment_satang||0)});
  const checks=[
    ["late_minutes",prior.lateMinutes],["early_out_minutes",prior.earlyOutMinutes],
    ["late_deduction_applied_satang",prior.appliedLateDeductionSatang],
    ["missing_punch_deduction_satang",prior.appliedMissingPunchDeductionSatang],["net_pay_satang",prior.netPaySatang]
  ] as const;
  if(checks.some(([key,value])=>row[key]!==value))reviewRequired("V1_STORED_RESULT_DRIFT");
}

function measuredMinutes(time:string|null,scheduled:string,early=false):number{
  if(!time)return 0;
  return Math.max(0,early?minutesOf(scheduled)-minutesOf(time):minutesOf(time)-minutesOf(scheduled));
}
function verifyChangedV1Schedule(current:Employee,snapshot:Employee,row:DailyRow,timeIn:string|null,timeOut:string|null):void{
  const originalIn=row.time_in?String(row.time_in):null,originalOut=row.time_out?String(row.time_out):null;
  for(const [original,next,storedSchedule,currentSchedule,early] of [
    [originalIn,timeIn,snapshot.scheduledIn,current.scheduledIn,false],
    [originalOut,timeOut,snapshot.scheduledOut,current.scheduledOut,true]
  ] as const){
    if(storedSchedule===currentSchedule)continue;
    const indistinguishableBefore=measuredMinutes(original,storedSchedule,early)===measuredMinutes(original,currentSchedule,early);
    // Missing and zero-clamped punches cannot prove which schedule was used. Do not manufacture that
    // proof with a new derived measurement, even if missing-punch max() temporarily masks its pay effect.
    if(indistinguishableBefore&&measuredMinutes(next,storedSchedule,early)!==measuredMinutes(next,currentSchedule,early))reviewRequired("V1_CHANGED_PUNCH_SCHEDULE_AMBIGUOUS");
  }
}

/** One selector for attendance, corrections, recalculation, finalization and preview. No writes. */
export function resolvePayrollDayContext(env:ActivationEnv,input:PayrollDayContextInput):PayrollDayContext{
  const{employee,workDate,daily,timeIn,timeOut}=input,today=input.today??isoDateInBangkok();
  if(!isIsoDate(workDate)||!isIsoDate(today))throw new Error("PAYROLL_INVALID_WORK_DATE");
  if(daily){
    const code=String(daily.payroll_policy_code||"");
    // Migration 0007 assigned this code to pre-existing rows without rebuilding all payroll inputs.
    if(code===LEGACY_LATE_POLICY_CODE)throw new PayrollContextReviewError("PAYROLL_LEGACY_CONTEXT_REVIEW_REQUIRED");
    if(code!==PAYROLL_POLICY_CODE&&code!==FLAT_LATE_POLICY_CODE)throw new PayrollContextReviewError("PAYROLL_POLICY_UNKNOWN");
    const snapshot=employeeSnapshot(employee,daily),hadPunch=Boolean(daily.time_in||daily.time_out);
    if(!hadPunch&&(timeIn||timeOut)&&workDate<today)reviewRequired("HISTORICAL_ABSENCE_INPUTS_UNPROVEN");
    if(code===FLAT_LATE_POLICY_CODE){
      if(snapshot.graceMin!==5||![0,5_000].includes(snapshot.lateDeductionSatang))reviewRequired("INVALID_V2_SNAPSHOT");
    }else if(hadPunch){
      verifyV1Context(snapshot,daily);
      const changedPunch=timeIn!==(daily.time_in||null)||timeOut!==(daily.time_out||null);
      // Missing-punch max() and an on-time original IN can mask historical deduction-setting drift.
      // Schedule-only differences may be an evidenced day-specific shift; wages are already snapshotted.
      if(changedPunch&&(employee.graceMin!==snapshot.graceMin||(employee.lateDeductionSatang>0)!==(snapshot.lateDeductionSatang>0)||employee.earlyDeductionSatang!==snapshot.earlyDeductionSatang))reviewRequired("V1_CHANGED_PUNCH_CONFIG_AMBIGUOUS");
      if(changedPunch)verifyChangedV1Schedule(employee,snapshot,daily,timeIn,timeOut);
    }
    else if(timeIn||timeOut){
      // A same-day correction may use only a context that still agrees with current employee settings.
      const fields=["scheduledIn","scheduledOut","graceMin","lateDeductionSatang","earlyDeductionSatang"] as const;
      if(fields.some(field=>employee[field]!==snapshot[field]))reviewRequired("V1_CONFIG_DRIFT");
    }
    return{employee:snapshot,policyCode:code};
  }
  if(workDate<today&&(!input.expectedAbsence||timeIn||timeOut))reviewRequired("HISTORICAL_INPUTS_MISSING");
  const activation=latePolicyActivation(env),selected=activation.active&&workDate>=activation.effectiveFrom!&&activation.employeeIds.includes(employee.employeeId);
  if(!selected)return{employee,policyCode:PAYROLL_POLICY_CODE};
  // Scope selects the formula, not permission to turn an employee's deduction opt-out on.
  return{employee:{...employee,graceMin:5,lateDeductionSatang:employee.lateDeductionSatang>0?5_000:0},policyCode:FLAT_LATE_POLICY_CODE};
}
