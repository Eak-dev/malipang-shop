import { authorize } from "./authorization";
import { createEmployeeChangeRequest,startHrRegistration,submitHrStaffId } from "./repository";
import { respondTextToLineEvent } from "../line/event-response";
import type { Env,LineEvent } from "../types";
import type { StaffActor } from "./repository";

function reply(env:Env,event:LineEvent,text:string,traceId:string):Promise<unknown>{return respondTextToLineEvent(env,event,text,{traceId,purpose:"EMPLOYEE_RESPONSE",identitySuffix:"hr"});}
function tri(th:string,en:string,mm:string):string{return`${th}\n\n${en}\n\n${mm}`;}
function profile(actor:StaffActor):string{return tri(
  `โปรไฟล์ HR\nรหัสพนักงาน: ${actor.employeeId}\nชื่อ: ${actor.employee.staffName}\nบทบาท: ${actor.role}\nสาขา: ${actor.branchName||"ทุกสาขา"}\nLINE: เชื่อมต่อแล้ว\nสถานะ: ${actor.employeeStatus}`,
  `HR Profile\nStaff ID: ${actor.employeeId}\nName: ${actor.employee.staffName}\nRole: ${actor.role}\nBranch: ${actor.branchName||"All branches"}\nLINE: Connected\nStatus: ${actor.employeeStatus}`,
  `HR ပရိုဖိုင်\nဝန်ထမ်း ID: ${actor.employeeId}\nအမည်: ${actor.employee.staffName}\nအခန်းကဏ္ဍ: ${actor.role}\nLINE: ချိတ်ဆက်ပြီး\nအခြေအနေ: ${actor.employeeStatus}`
);}
export async function handleHrText(env:Env,event:LineEvent,actor:StaffActor|null,traceId:string):Promise<boolean>{
  const text=(event.message?.text||"").trim(),lineUserId=event.source.userId||"";
  if(!lineUserId)return false;
  if(/^HR$/i.test(text)){
    if(actor){await reply(env,event,profile(actor),traceId);return true;}
    await startHrRegistration(env,lineUserId);
    await reply(env,event,tri("ลงทะเบียน HR\nตรวจพบบัญชี LINE แล้ว\nสถานะ: ยังไม่เชื่อมต่อ\nกรุณาพิมพ์รหัสพนักงาน", "HR Registration\nLINE account detected.\nStatus: NOT LINKED\nPlease enter your Staff ID.", "HR မှတ်ပုံတင်ခြင်း\nLINE အကောင့်ကို တွေ့ရှိပြီးပါပြီ\nဝန်ထမ်း ID ကို ရိုက်ထည့်ပါ။"),traceId);return true;
  }
  if(!actor&&/^[A-Za-z0-9_-]{1,40}$/.test(text)){
    const result=await submitHrStaffId(env,lineUserId,text);
    if(result.ok)await reply(env,event,tri(`ได้รับคำขอลงทะเบียนแล้ว\nพนักงาน: ${result.staffName}\nรอ Owner อนุมัติ`, `Registration request received.\nStaff: ${result.staffName}\nWaiting for Owner approval.`, `မှတ်ပုံတင်တောင်းဆိုချက်ကို လက်ခံရရှိပါပြီ။\nOwner အတည်ပြုချက်ကို စောင့်ပါ။`),traceId);
    else if(result.code!=="HR_REGISTRATION_NOT_STARTED")await reply(env,event,tri("ลงทะเบียนไม่สำเร็จ\nกรุณาตรวจรหัสพนักงานหรือสอบถาม Owner",`Registration was not accepted.\nCode: ${result.code}`,"မှတ်ပုံတင်ခြင်း မအောင်မြင်ပါ။ Owner ကို ဆက်သွယ်ပါ။"),traceId);
    else return false;
    return true;
  }
  return false;
}

export async function requestOwnAttendanceCorrection(env:Env,event:LineEvent,actor:StaffActor,raw:string,traceId:string):Promise<boolean>{
  if(!/^CORRECT\s+/i.test(raw.trim()))return false;
  if(!authorize(actor,"staff.self.low_risk_update",{employeeId:actor.employeeId})){await reply(env,event,"Not authorized.",traceId);return true;}
  const reason=raw.replace(/^CORRECT\s+/i,"").trim();
  if(reason.length<3){await reply(env,event,"Correction request needs a short reason. Example: CORRECT missing OUT 2026-07-29",traceId);return true;}
  const date=/\b\d{4}-\d{2}-\d{2}\b/.exec(reason)?.[0];
  const request=await createEmployeeChangeRequest(env,actor,{requestType:"ATTENDANCE_CORRECTION",...(date?{workDate:date}:{}),reason});
  await reply(env,event,`Correction request received.\nRequest ID: ${request.requestId}\nStatus: PENDING REVIEW`,traceId);return true;
}
