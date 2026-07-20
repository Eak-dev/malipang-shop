import { dayDiff, hhmm, hhmmInBangkok, isoDateInBangkok, minuteDiffSameDate, resolveClockDate, weekdayShort } from "../shared/time";
import type { VisionResult } from "../types";

export interface ValidatedClock {ok:boolean;workDate:string;officialTime:string;lineTime:string;lineDiffMinutes:number;validationCode:string;review:boolean;note:string}
export function validateClock(reading:VisionResult,receivedAtIso:string,maxDateDiffDays:number,minConfidence:number,maxLineTimeDiffMin=30):ValidatedClock{
  const fail=(code:string,note=code):ValidatedClock=>({ok:false,workDate:"",officialTime:"",lineTime:hhmmInBangkok(new Date(receivedAtIso)),lineDiffMinutes:0,validationCode:code,review:true,note});
  if(reading.kind!=="CLOCK")return fail("NOT_CLOCK");
  if(reading.needsNewPhoto||reading.hour==null||reading.minute==null||reading.month==null||reading.day==null)return fail("CLOCK_FIELDS_MISSING");
  if(!Number.isInteger(reading.hour)||!Number.isInteger(reading.minute)||!Number.isInteger(reading.month)||!Number.isInteger(reading.day)||reading.hour<0||reading.hour>23||reading.minute<0||reading.minute>59||reading.month<1||reading.month>12||reading.day<1||reading.day>31)return fail("CLOCK_VALUE_OUT_OF_RANGE");
  if(reading.confidence<minConfidence)return fail("CLOCK_LOW_CONFIDENCE");
  const workDate=resolveClockDate(reading.month,reading.day,receivedAtIso);
  if(!workDate)return fail("CLOCK_INVALID_CALENDAR_DATE");
  const receivedDate=isoDateInBangkok(new Date(receivedAtIso)),diff=dayDiff(workDate,receivedDate),officialTime=hhmm(reading.hour,reading.minute),lineTime=hhmmInBangkok(new Date(receivedAtIso));
  if(diff>maxDateDiffDays)return{ok:false,workDate,officialTime,lineTime,lineDiffMinutes:0,validationCode:"CLOCK_DATE_MISMATCH",review:true,note:"วันที่ในรูปต่างจากวันที่ส่งเกินกำหนด"};
  const lineDiffMinutes=workDate===receivedDate?minuteDiffSameDate(officialTime,lineTime):0;
  const notes:string[]=[];
  if(diff!==0)notes.push("วันที่อยู่ใกล้รอยต่อวัน");
  if(lineDiffMinutes>maxLineTimeDiffMin)notes.push(`เวลาในรูปต่างจากเวลา LINE ${lineDiffMinutes} นาที`);
  if(reading.weekday&&weekdayShort(workDate)!==reading.weekday.slice(0,3))notes.push(`วันบนหน้าปัดไม่ตรงกับวันที่: ${reading.weekday}`);
  if(reading.note)notes.push(reading.note);
  const review=notes.length>0;
  return{ok:true,workDate,officialTime,lineTime,lineDiffMinutes,validationCode:review?"CLOCK_REVIEW":"OK",review,note:notes.join(" / ")};
}
