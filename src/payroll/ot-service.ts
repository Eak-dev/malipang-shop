import { enqueueSheetSync } from "../db/repositories";
import { pushOwnerAlert,pushText } from "../line/api";
import type { Employee,Env,LineEvent } from "../types";

export function isOtPostback(event:LineEvent):boolean{const action=new URLSearchParams(event.postback?.data||"").get("a")||"";return action==="ot_accept"||action==="ot_decline";}
export async function handleOtPostback(env:Env,event:LineEvent,actor:Employee):Promise<void>{
  const q=new URLSearchParams(event.postback?.data||""),action=q.get("a")||"",otId=q.get("id")||"",to=event.source.userId||"",traceId=`ot_postback_${otId||"unknown"}`;if(!otId||!isOtPostback(event)){await pushText(env,to,"รายการ OT ไม่ถูกต้องหรือหมดอายุแล้ว",traceId);return;}
  const row=await env.DB.prepare(`SELECT o.*,e.staff_name FROM ot_requests o JOIN employees e ON e.employee_id=o.employee_id WHERE o.ot_id=? AND o.employee_id=? LIMIT 1`).bind(otId,actor.employeeId).first<Record<string,unknown>>();if(!row){await pushText(env,to,"ไม่พบรายการ OT หรือรายการนี้ไม่ใช่ของคุณ",traceId);return;}
  if(String(row.employee_confirm_status)!=="PENDING"){await pushText(env,to,`รายการ OT นี้ตอบแล้ว: ${String(row.employee_confirm_status)}`,traceId);return;}
  const accepted=action==="ot_accept",now=new Date().toISOString(),status=accepted?"EMPLOYEE_ACCEPTED":"EMPLOYEE_DECLINED",employeeStatus=accepted?"ACCEPTED":"DECLINED",version=Number(row.version||0)+1;
  await env.DB.batch([
    env.DB.prepare(`UPDATE ot_requests SET employee_confirm_status=?,employee_confirmed_at=?,status=?,version=version+1,updated_at=? WHERE ot_id=? AND employee_id=? AND employee_confirm_status='PENDING'`).bind(employeeStatus,now,status,now,otId,actor.employeeId),
    env.DB.prepare(`INSERT INTO admin_audit(id,action,entity_key,reason,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),"OT_EMPLOYEE_RESPONSE",otId,employeeStatus,JSON.stringify({employeeConfirmStatus:row.employee_confirm_status,status:row.status}),JSON.stringify({employeeConfirmStatus:employeeStatus,status}),now)
  ]);
  await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"OT_REQUEST",entityKey:otId,entityVersion:version,traceId});
  await pushText(env,to,accepted?`ยืนยันทำ OT วันที่ ${String(row.work_date)} เรียบร้อยแล้ว ✅\nยอด OT แบบเหมา ${Number(row.fixed_amount_satang||0)/100} บาท\nรอ Owner ยืนยันยอดสุดท้ายหลังทำงาน`:`แจ้งไม่สะดวกทำ OT วันที่ ${String(row.work_date)} เรียบร้อยแล้ว`,traceId);
  await pushOwnerAlert(env,`OT ${accepted?"ACCEPTED":"DECLINED"}\nพนักงาน: ${String(row.staff_name)}\nวันที่: ${String(row.work_date)}\nยอดเหมา: ${Number(row.fixed_amount_satang||0)/100} บาท\nOT ID: ${otId}`,traceId);
}
