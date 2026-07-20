import { minutesOf } from "../shared/time";
import type { Employee } from "../types";
export interface PayrollInput{employee:Employee;timeIn:string|null;timeOut:string|null;review:boolean}
export interface PayrollResult{workMinutes:number;lateMinutes:number;earlyOutMinutes:number;estimatedWageSatang:number;confirmedWageSatang:number;pendingWageSatang:number;payStatus:"READY"|"REVIEW"|"NO_AMOUNT"}
export function calculatePayroll(input:PayrollInput):PayrollResult{
  const{employee,timeIn,timeOut,review}=input;
  if(!timeIn||!timeOut)return{workMinutes:0,lateMinutes:timeIn?Math.max(0,minutesOf(timeIn)-minutesOf(employee.scheduledIn)-employee.graceMin):0,earlyOutMinutes:0,estimatedWageSatang:0,confirmedWageSatang:0,pendingWageSatang:0,payStatus:"REVIEW"};
  const inMin=minutesOf(timeIn),outMin=minutesOf(timeOut),workMinutes=Math.max(0,outMin-inMin);
  const lateMinutes=Math.max(0,inMin-minutesOf(employee.scheduledIn)-employee.graceMin),earlyOutMinutes=Math.max(0,minutesOf(employee.scheduledOut)-outMin);
  const deduction=(lateMinutes>0?employee.lateDeductionSatang:0)+(earlyOutMinutes>0?employee.earlyDeductionSatang:0);
  const payable=Math.max(0,employee.dailyWageSatang-deduction);
  if(review)return{workMinutes,lateMinutes,earlyOutMinutes,estimatedWageSatang:payable,confirmedWageSatang:0,pendingWageSatang:payable,payStatus:"REVIEW"};
  if(payable<=0)return{workMinutes,lateMinutes,earlyOutMinutes,estimatedWageSatang:0,confirmedWageSatang:0,pendingWageSatang:0,payStatus:"NO_AMOUNT"};
  return{workMinutes,lateMinutes,earlyOutMinutes,estimatedWageSatang:payable,confirmedWageSatang:payable,pendingWageSatang:0,payStatus:"READY"};
}
