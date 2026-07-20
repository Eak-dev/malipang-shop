import { enqueueSheetSync } from "../db/repositories";
import { pushConfirmation,pushText } from "../line/api";
import { randomId } from "../shared/ids";
import type { Employee,Env,LineEvent,VisionResult } from "../types";
import { parseExpenseText } from "./text-parser";
const baht=(satang:number)=>(satang/100).toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2});
export async function handleExpenseText(env:Env,event:LineEvent,traceId:string):Promise<void>{
  const to=event.source.userId||"",parsed=parseExpenseText(event.message?.text||"");if(!parsed){await pushText(env,to,"รูปแบบไม่ถูกต้องค่ะ\nตัวอย่าง: ไข่ ทอน 375 หรือ ค่าไฟ โอน 1200");return;}
  const id=randomId("exp"),status=parsed.quickSave?"CONFIRMED":"WAITING_CONFIRM",now=new Date().toISOString();
  await env.DB.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,trace_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id,event.message?.id||"",to,parsed.description,parsed.amountSatang,parsed.paymentKey,parsed.sourceWallet,parsed.category,parsed.transactionDate,status,traceId,now).run();
  if(parsed.quickSave){await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE",entityKey:id,entityVersion:1,traceId});await pushText(env,to,`บันทึกแล้ว ✅\nรายการ: ${parsed.description}\nยอด: ${baht(parsed.amountSatang)} บาท\nกระเป๋า: ${parsed.sourceWallet}`);}else await pushConfirmation(env,to,"ยืนยันค่าใช้จ่าย",`${parsed.description}\n${baht(parsed.amountSatang)} บาท\n${parsed.sourceWallet}`,`a=expense_confirm&id=${encodeURIComponent(id)}`,`a=expense_cancel&id=${encodeURIComponent(id)}`);
}
export async function handleExpenseImage(env:Env,event:LineEvent,reading:VisionResult,imageKey:string,traceId:string):Promise<void>{
  const to=event.source.userId||"",id=randomId("doc");await env.DB.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,image_key,status,ai_json,trace_id,created_at) VALUES(?,?,?,?,?,'WAITING_REVIEW',?,?,?)`).bind(id,event.message?.id||"",to,reading.kind,imageKey,JSON.stringify(reading.raw),traceId,new Date().toISOString()).run();
  await pushText(env,to,`รับรูป ${reading.kind} แล้วค่ะ ✅\nเก็บในคิวตรวจเลขที่ ${id}\nรุ่นนี้จะไม่ลงยอดจากรูปอัตโนมัติเพื่อป้องกันยอดผิด`);
}
export async function handleExpensePostback(env:Env,event:LineEvent,actor:Employee):Promise<void>{
  const q=new URLSearchParams(event.postback?.data||""),action=q.get("a"),id=q.get("id")||"",to=event.source.userId||"";if(!actor.canSubmitExpense){await pushText(env,to,"ไม่มีสิทธิ์จัดการค่าใช้จ่ายค่ะ");return;}
  if(action==="expense_confirm"){
    const changed=await env.DB.prepare(`UPDATE expense_events SET status='CONFIRMED',updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(new Date().toISOString(),id,to).run();if(Number(changed.meta.changes||0)!==1){await pushText(env,to,"รายการนี้ถูกจัดการแล้วหรือไม่ใช่รายการของคุณค่ะ");return;}
    await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"EXPENSE",entityKey:id,entityVersion:1,traceId:`postback_${id}`});await pushText(env,to,"ยืนยันบันทึกค่าใช้จ่ายแล้ว ✅");
  }else if(action==="expense_cancel"){
    const changed=await env.DB.prepare(`UPDATE expense_events SET status='CANCELLED',updated_at=? WHERE expense_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(new Date().toISOString(),id,to).run();await pushText(env,to,Number(changed.meta.changes||0)===1?"ยกเลิกรายการแล้วค่ะ":"รายการนี้ถูกจัดการแล้วหรือไม่ใช่รายการของคุณค่ะ");
  }
}
