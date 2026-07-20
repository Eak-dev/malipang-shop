import { isIsoDate,isoDateInBangkok,minutesOf } from "../shared/time";

export interface Correction {employeeId:string;workDate:string;timeIn:string;timeOut:string;reason:string}
export function validateCorrection(input:unknown):Correction{
  if(!input||typeof input!=="object")throw new Error("Invalid correction payload");
  const raw=input as Record<string,unknown>,employeeId=String(raw.employeeId||""),workDate=String(raw.workDate||""),timeIn=String(raw.timeIn||""),timeOut=String(raw.timeOut||""),reason=String(raw.reason||"").trim();
  if(!/^[A-Za-z0-9_-]{1,40}$/.test(employeeId)||!isIsoDate(workDate)||workDate>isoDateInBangkok()||reason.length<3)throw new Error("Invalid correction payload");
  let inMinutes:number,outMinutes:number;try{inMinutes=minutesOf(timeIn);outMinutes=minutesOf(timeOut);}catch{throw new Error("timeIn/timeOut must be valid HH:mm");}
  if(outMinutes<=inMinutes)throw new Error("timeOut must be later than timeIn in V5.2");
  return{employeeId,workDate,timeIn,timeOut,reason};
}
