import { authorize } from "./authorization";
import { approveIdentityLinkRequest,createEmployeeChangeRequest,listIdentityLinkRequests,rejectIdentityLinkRequest,startHrRegistration,submitHrStaffId } from "./repository";
import { importEmployeesFromConfiguredSheet } from "../admin/staff-import";
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

type HrDependencies={importConfiguredStaff?:typeof importEmployeesFromConfiguredSheet};

export async function handleHrText(env:Env,event:LineEvent,actor:StaffActor|null,traceId:string,deps:HrDependencies={}):Promise<boolean>{
  const text=(event.message?.text||"").trim(),lineUserId=event.source.userId||"";
  if(!lineUserId)return false;
  const ownerCommand=/^HR\s+(PENDING|APPROVE|REJECT|SYNC)\b\s*(.*)$/i.exec(text);
  if(ownerCommand){
    if(!actor||actor.role!=="OWNER"||!authorize(actor,"identity.approve")){await reply(env,event,"HR identity administration is available only to a verified Owner LINE account.",traceId);return true;}
    const action=ownerCommand[1]!.toUpperCase(),args=ownerCommand[2]!.trim();
    if(action==="SYNC"){
      if(args){await reply(env,event,"Usage: HR SYNC",traceId);return true;}
      try{
        const result=await(deps.importConfiguredStaff||importEmployeesFromConfiguredSheet)(env);
        await reply(env,event,tri(
          `ซิงก์ข้อมูลพนักงานสำเร็จ\nประมวลผล ${result.count} รายการ\nพนักงานใหม่สามารถส่ง HR แล้วพิมพ์รหัสพนักงานได้`,
          `HR staff sync completed.\nProcessed ${result.count} staff rows.\nNew staff can now send HR and enter their Staff ID.`,
          `HR ဝန်ထမ်းစာရင်း sync ပြီးပါပြီ။\nဝန်ထမ်း ${result.count} ဦးကို စစ်ဆေးပြီးပါပြီ။\nဝန်ထမ်းအသစ်သည် HR ပို့ပြီး Staff ID ရိုက်ထည့်နိုင်ပါပြီ။`
        ),traceId);
      }catch{
        await reply(env,event,tri(
          "ซิงก์ข้อมูลพนักงานไม่สำเร็จ\nยังไม่มีการเชื่อม LINE ใหม่ กรุณาตรวจ HR_STAFF_CONFIG หรือติดต่อผู้ดูแลระบบ",
          "HR staff sync failed.\nNo new LINE identity was linked. Please verify HR_STAFF_CONFIG or contact the system administrator.",
          "HR ဝန်ထမ်းစာရင်း sync မအောင်မြင်ပါ။ LINE အကောင့်အသစ် မချိတ်ထားပါ။ HR_STAFF_CONFIG ကို စစ်ဆေးပါ။"
        ),traceId);
      }
      return true;
    }
    if(action==="PENDING"){
      const requests=await listIdentityLinkRequests(env);
      const rows=requests.map(request=>`${request.requestId} | ${request.requestedStaffId||"-"} | ${request.staffName||"-"} | ${request.role||"-"} | ${request.branchName||"All branches"}`).join("\n");
      await reply(env,event,rows?`HR registration requests\n${rows}`:"HR registration requests\nNo pending requests.",traceId);return true;
    }
    const [requestId,...reasonParts]=args.split(/\s+/).filter(Boolean);
    if(!requestId){await reply(env,event,`Usage: HR ${action} <requestId>${action==="REJECT"?" <reason>":""}`,traceId);return true;}
    if(action==="APPROVE"){
      const result=await approveIdentityLinkRequest(env,requestId,actor);
      await reply(env,event,`HR identity approved.\nStaff ID: ${result.employeeId}\nStatus: VERIFIED${result.idempotent?" (already approved)":""}`,traceId);return true;
    }
    const reason=reasonParts.join(" ").trim();
    if(reason.length<3){await reply(env,event,"Usage: HR REJECT <requestId> <reason>",traceId);return true;}
    await rejectIdentityLinkRequest(env,requestId,actor,reason);
    await reply(env,event,`HR identity request rejected.\nRequest ID: ${requestId}`,traceId);return true;
  }
  if(/^HR$/i.test(text)){
    if(actor){await reply(env,event,profile(actor),traceId);return true;}
    await startHrRegistration(env,lineUserId);
    await reply(env,event,tri("ลงทะเบียน HR\nตรวจพบบัญชี LINE แล้ว\nสถานะ: ยังไม่เชื่อมต่อ\nกรุณาพิมพ์รหัสพนักงาน", "HR Registration\nLINE account detected.\nStatus: NOT LINKED\nPlease enter your Staff ID.", "HR မှတ်ပုံတင်ခြင်း\nLINE အကောင့်ကို တွေ့ရှိပြီးပါပြီ\nဝန်ထမ်း ID ကို ရိုက်ထည့်ပါ။"),traceId);return true;
  }
  if(!actor&&/^[A-Za-z0-9_-]{1,40}$/.test(text)){
    const result=await submitHrStaffId(env,lineUserId,text);
    if(result.ok)await reply(env,event,tri(`ได้รับคำขอลงทะเบียนแล้ว\nพนักงาน: ${result.staffName}\nรอ Owner อนุมัติ`, `Registration request received.\nStaff: ${result.staffName}\nWaiting for Owner approval.`, `မှတ်ပုံတင်တောင်းဆိုချက်ကို လက်ခံရရှိပါပြီ။\nOwner အတည်ပြုချက်ကို စောင့်ပါ။`),traceId);
    else if(result.code==="STAFF_ID_NOT_FOUND")await reply(env,event,tri(
      "ยังไม่พบรหัสพนักงานนี้ในระบบ\nกรุณาให้ Owner ส่ง HR SYNC แล้วลองพิมพ์รหัสพนักงานอีกครั้ง",
      "Staff ID is not provisioned yet.\nPlease ask the Owner to send HR SYNC, then enter your Staff ID again.",
      "ဤ Staff ID ကို စနစ်ထဲတွင် မတွေ့သေးပါ။ Owner အား HR SYNC ပို့ခိုင်းပြီး Staff ID ကို ထပ်မံရိုက်ထည့်ပါ။"
    ),traceId);
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
