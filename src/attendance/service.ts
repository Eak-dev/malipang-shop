import { enqueueSheetSync } from "../db/repositories";
import { validateAttendancePhoto } from "../domain/attendance";
import { saveEvidence } from "../evidence/r2";
import { enqueueAttendanceNotification } from "../line/attendance-notification";
import { numberEnv } from "../shared/env";
import { sha256Hex } from "../shared/ids";
import { payrollPeriodFor } from "../shared/time";
import type { AttendanceCommitRequest,AttendanceCommitResult,Employee,Env,LineEvent,VisionResult } from "../types";
import { describeClockValidationFailure } from "../vision/failure-reason";
import { buildAttendanceReply } from "./messages";

export function weeklyPayrollSyncEntityKey(employeeId:string,workDate:string):string{
  return `${employeeId}|${payrollPeriodFor(workDate).weekStart}`;
}

export async function handleAttendance(env:Env,event:LineEvent,employee:Employee,reading:VisionResult,original:ArrayBuffer,traceId:string):Promise<boolean>{
  const to=event.source.userId||"",messageId=event.message?.id||"",webhookEventId=event.webhookEventId||`message:${messageId}`,receivedAtIso=new Date(event.timestamp).toISOString();
  const validated=validateAttendancePhoto(reading,receivedAtIso,{storeLat:numberEnv(env.ATTENDANCE_STORE_LAT,NaN),storeLng:numberEnv(env.ATTENDANCE_STORE_LNG,NaN),allowedRadiusM:numberEnv(env.ATTENDANCE_ALLOWED_RADIUS_M,120),maxPhotoAgeMin:numberEnv(env.ATTENDANCE_MAX_PHOTO_AGE_MIN,3),overlayMinConfidence:numberEnv(env.ATTENDANCE_OVERLAY_MIN_CONFIDENCE,0.9),clockMinConfidence:numberEnv(env.ATTENDANCE_CLOCK_MIN_CONFIDENCE,0.7)});
  if(!validated.ok){
    await enqueueAttendanceNotification(env,{to,text:describeClockValidationFailure(validated.validationCode).message,identity:`attendance:${webhookEventId}:rejection:${validated.validationCode}`,purpose:"ATTENDANCE_REJECTION",traceId});
    return false;
  }
  const hash=await sha256Hex(original),imageKey=`attendance/${validated.workDate}/${employee.employeeId}/${messageId}-${hash.slice(0,12)}.jpg`;
  await saveEvidence(env,imageKey,original,{employeeId:employee.employeeId,messageId,traceId});
  const objectId=env.ATTENDANCE_COORDINATOR.idFromName(`${employee.employeeId}|${validated.workDate}`),stub=env.ATTENDANCE_COORDINATOR.get(objectId);
  const input:AttendanceCommitRequest={traceId,webhookEventId,messageId,receivedAtIso,employee,reading,workDate:validated.workDate,officialTime:validated.officialTime,lineTime:validated.lineTime,lineDiffMinutes:validated.lineDiffMinutes,photoDateTime:validated.photoDateTime,gpsLat:validated.gpsLat,gpsLng:validated.gpsLng,distanceM:validated.distanceM,attendanceSource:"PHOTO_TIMESTAMP_GPS",clockEvidence:true,clockConfidence:reading.clockConfidence,overlayRawText:reading.overlayRawText,imageSha256:hash,imageKey,validationCode:validated.validationCode,validationNote:validated.note,validationReview:validated.review};
  const response=await stub.fetch("https://attendance.local/commit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});if(!response.ok)throw new Error(`Attendance DO HTTP ${response.status}`);
  const result=await response.json() as AttendanceCommitResult;
  const notification={to,text:buildAttendanceReply(employee,result),identity:`attendance:${webhookEventId}:result:${result.eventId}:${result.punchType}`,purpose:"ATTENDANCE_RESULT" as const,traceId};
  if(result.punchType==="COMPLETE"){await enqueueAttendanceNotification(env,notification);return true;}
  const jobs=[
    {kind:"SHEETS_SYNC" as const,entityType:"ATTENDANCE_EVENT" as const,entityKey:result.eventId,entityVersion:result.version,traceId},
    {kind:"SHEETS_SYNC" as const,entityType:"DAILY_PAYROLL" as const,entityKey:`${employee.employeeId}|${result.workDate}`,entityVersion:result.version,traceId},
    {kind:"SHEETS_SYNC" as const,entityType:"WEEKLY_PAYROLL" as const,entityKey:weeklyPayrollSyncEntityKey(employee.employeeId,result.workDate),entityVersion:result.version,traceId}
  ];
  for(const job of jobs)await enqueueSheetSync(env,job);
  await enqueueAttendanceNotification(env,notification);
  return true;
}
