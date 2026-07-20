import { enqueueSheetSync } from "../db/repositories";
import { validateClock } from "../domain/attendance";
import { saveEvidence } from "../evidence/r2";
import { pushText } from "../line/api";
import { numberEnv } from "../shared/env";
import { sha256Hex } from "../shared/ids";
import { weekStartMonday } from "../shared/time";
import type { AttendanceCommitRequest,AttendanceCommitResult,Employee,Env,LineEvent,VisionResult } from "../types";

export async function handleAttendance(env:Env,event:LineEvent,employee:Employee,reading:VisionResult,original:ArrayBuffer,traceId:string):Promise<boolean>{
  const to=event.source.userId||"",messageId=event.message?.id||"",webhookEventId=event.webhookEventId||`message:${messageId}`,receivedAtIso=new Date(event.timestamp).toISOString();
  const validated=validateClock(reading,receivedAtIso,numberEnv(env.CLOCK_MAX_DATE_DIFF_DAYS,1),numberEnv(env.CLOCK_FALLBACK_MIN_CONFIDENCE,0.9),numberEnv(env.CLOCK_MAX_LINE_TIME_DIFF_MIN,30));
  if(!validated.ok){await pushText(env,to,`ยังไม่บันทึกเวลาค่ะ ❌\nสาเหตุ: ${validated.validationCode}\nกรุณาถ่ายใหม่ให้เห็นเวลา เดือน และวันที่ครบ`,traceId);return false;}
  const hash=await sha256Hex(original),imageKey=`attendance/${validated.workDate}/${employee.employeeId}/${messageId}-${hash.slice(0,12)}.jpg`;
  await saveEvidence(env,imageKey,original,{employeeId:employee.employeeId,messageId,traceId});
  const objectId=env.ATTENDANCE_COORDINATOR.idFromName(`${employee.employeeId}|${validated.workDate}`),stub=env.ATTENDANCE_COORDINATOR.get(objectId);
  const input:AttendanceCommitRequest={traceId,webhookEventId,messageId,receivedAtIso,employee,reading,workDate:validated.workDate,officialTime:validated.officialTime,lineTime:validated.lineTime,lineDiffMinutes:validated.lineDiffMinutes,imageKey,validationCode:validated.validationCode,validationNote:validated.note,validationReview:validated.review};
  const response=await stub.fetch("https://attendance.local/commit",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(input)});if(!response.ok)throw new Error(`Attendance DO HTTP ${response.status}`);
  const result=await response.json() as AttendanceCommitResult;
  if(result.punchType==="COMPLETE"){await pushText(env,to,buildReply(employee,result),traceId);return true;}
  const weekStart=weekStartMonday(result.workDate),jobs=[
    {kind:"SHEETS_SYNC" as const,entityType:"ATTENDANCE_EVENT" as const,entityKey:result.eventId,entityVersion:result.version,traceId},
    {kind:"SHEETS_SYNC" as const,entityType:"DAILY_PAYROLL" as const,entityKey:`${employee.employeeId}|${result.workDate}`,entityVersion:result.version,traceId},
    {kind:"SHEETS_SYNC" as const,entityType:"WEEKLY_PAYROLL" as const,entityKey:`${employee.employeeId}|${weekStart}`,entityVersion:result.version,traceId}
  ];
  for(const job of jobs)await enqueueSheetSync(env,job);
  await pushText(env,to,buildReply(employee,result),traceId);
  return true;
}
function buildReply(employee:Employee,result:AttendanceCommitResult):string{
  if(result.punchType==="DUPLICATE")return"ระบบได้รับรูปนี้แล้วค่ะ ไม่ต้องส่งซ้ำ";
  if(result.punchType==="COMPLETE")return`วันนี้ ${employee.staffName} บันทึกเวลาเข้าและออกครบแล้วค่ะ หากต้องแก้ไขให้แจ้งผู้ดูแล`;
  const label=result.punchType==="IN"?"เข้างาน":"ออกงาน",status=result.status==="NORMAL"?"ปกติ":"ต้องตรวจ";
  return`✅ บันทึก${label}แล้ว\nชื่อ: ${employee.staffName}\nวันที่: ${result.workDate}\nเวลา: ${result.officialTime}\nสาย: ${result.lateMinutes} นาที\nสถานะ: ${status}`;
}
