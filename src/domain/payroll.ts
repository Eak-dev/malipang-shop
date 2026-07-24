import { minutesOf } from "../shared/time";
import type { Employee,MissingPunchType } from "../types";

export const PAYROLL_POLICY_CODE="LATE_V1_FIXED_OT_V1";
export const LATE_GRACE_MIN=5;
export interface PayrollInput{
  employee:Employee;
  timeIn:string|null;
  timeOut:string|null;
  review:boolean;
  finalizeMissingPunch?:boolean;
  otApprovedSatang?:number;
  otherAdjustmentSatang?:number;
}
export interface PayrollResult{
  workMinutes:number;
  lateMinutes:number;
  earlyOutMinutes:number;
  baseWageSatang:number;
  lateDeductionSatang:number;
  missingPunchType:MissingPunchType;
  missingPunchDeductionSatang:number;
  earlyDeductionSatang:number;
  totalDeductionSatang:number;
  otApprovedSatang:number;
  otherAdjustmentSatang:number;
  estimatedWageSatang:number;
  confirmedWageSatang:number;
  pendingWageSatang:number;
  netPaySatang:number;
  payStatus:"READY"|"REVIEW"|"NO_AMOUNT";
  policyCode:string;
}

export function lateDeductionFor(dailyWageSatang:number,actualLateMinutes:number):number{
  if(actualLateMinutes<=LATE_GRACE_MIN)return 0;
  if(actualLateMinutes<=29)return 5_000;
  if(actualLateMinutes<=89)return 10_000;
  return Math.round(Math.max(0,dailyWageSatang)/2);
}

export function missingPunchType(timeIn:string|null,timeOut:string|null):MissingPunchType{
  if(timeIn&&timeOut)return"NONE";
  if(timeIn)return"MISSING_OUT";
  if(timeOut)return"MISSING_IN";
  return"BOTH";
}

export function calculatePayroll(input:PayrollInput):PayrollResult{
  const{employee,timeIn,timeOut,review}=input;
  const inMin=timeIn?minutesOf(timeIn):null,outMin=timeOut?minutesOf(timeOut):null;
  const workMinutes=inMin==null||outMin==null?0:Math.max(0,outMin-inMin);
  const lateMinutes=inMin==null?0:Math.max(0,inMin-minutesOf(employee.scheduledIn));
  const earlyOutMinutes=outMin==null?0:Math.max(0,minutesOf(employee.scheduledOut)-outMin);
  const baseWageSatang=Math.max(0,Math.round(employee.dailyWageSatang));
  const lateDeductionSatang=lateDeductionFor(baseWageSatang,lateMinutes);
  const missing=missingPunchType(timeIn,timeOut);
  const missingPunchDeductionSatang=missing==="NONE"?0:missing==="BOTH"?baseWageSatang:Math.round(baseWageSatang/2);
  const primaryDeduction=Math.max(lateDeductionSatang,missingPunchDeductionSatang);
  const earlyDeductionSatang=missing==="NONE"&&earlyOutMinutes>0?Math.max(0,Math.round(employee.earlyDeductionSatang)):0;
  const totalDeductionSatang=Math.min(baseWageSatang,primaryDeduction+earlyDeductionSatang);
  const otApprovedSatang=Math.max(0,Math.round(input.otApprovedSatang||0));
  const otherAdjustmentSatang=Math.round(input.otherAdjustmentSatang||0);
  const netPaySatang=Math.max(0,baseWageSatang-totalDeductionSatang+otApprovedSatang+otherAdjustmentSatang);
  const base={workMinutes,lateMinutes,earlyOutMinutes,baseWageSatang,lateDeductionSatang,missingPunchType:missing,missingPunchDeductionSatang,earlyDeductionSatang,totalDeductionSatang,otApprovedSatang,otherAdjustmentSatang,estimatedWageSatang:netPaySatang,netPaySatang,policyCode:PAYROLL_POLICY_CODE};
  if(missing==="BOTH")return{...base,confirmedWageSatang:0,pendingWageSatang:0,payStatus:"REVIEW"};
  if((missing==="MISSING_IN"||missing==="MISSING_OUT")&&!input.finalizeMissingPunch)return{...base,confirmedWageSatang:0,pendingWageSatang:netPaySatang,payStatus:"REVIEW"};
  if(review)return{...base,confirmedWageSatang:0,pendingWageSatang:netPaySatang,payStatus:"REVIEW"};
  if(netPaySatang<=0)return{...base,confirmedWageSatang:0,pendingWageSatang:0,payStatus:"NO_AMOUNT"};
  return{...base,confirmedWageSatang:netPaySatang,pendingWageSatang:0,payStatus:"READY"};
}
