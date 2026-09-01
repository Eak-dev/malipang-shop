import { authorize } from "../access/authorization";
import type { StaffActor } from "../access/repository";
import { enqueueSheetSync } from "../db/repositories";
import { respondFlexToLineEvent,respondTextToLineEvent } from "../line/event-response";
import { randomId } from "../shared/ids";
import type { Env,LineEvent } from "../types";
import { buildPersonalUseConfirmFlex,buildPersonalUseSavedFlex,type PersonalUseFlexRecord } from "./flex";
import { parsePersonalUseText } from "./text-parser";

export type PersonalUseOutcome="NOT_HANDLED"|"CONFIRMED"|"WAITING_CONFIRM"|"REJECTED";
type Row=Record<string,unknown>;
function isOwner(actor:StaffActor|null|undefined):actor is StaffActor{return Boolean(actor?.role==="OWNER"&&authorize(actor,"expense.submit",{employeeId:actor.employeeId}));}
function record(row:Row):PersonalUseFlexRecord{return{personalUseId:String(row.personal_use_id),transactionType:String(row.transaction_type) as PersonalUseFlexRecord["transactionType"],description:String(row.description),amountSatang:Number(row.amount_satang),sourceWallet:String(row.source_wallet),transactionDate:String(row.transaction_date),status:String(row.status)};}
function actorValues(actor:StaffActor):{employeeId:string;branchId:string|null}{return{employeeId:actor.employeeId,branchId:actor.branchId||null};}
async function find(env:Env,id:string,lineUserId:string):Promise<PersonalUseFlexRecord|null>{const row=await env.DB.prepare(`SELECT * FROM owner_personal_transactions WHERE personal_use_id=? AND line_user_id=? LIMIT 1`).bind(id,lineUserId).first<Row>();return row?record(row):null;}
async function findMessage(env:Env,messageId:string,lineUserId:string):Promise<PersonalUseFlexRecord|null>{const row=await env.DB.prepare(`SELECT * FROM owner_personal_transactions WHERE message_id=? AND line_user_id=? LIMIT 1`).bind(messageId,lineUserId).first<Row>();return row?record(row):null;}
function audit(env:Env,actor:StaffActor,action:string,id:string,before:unknown,after:unknown){return env.DB.prepare(`INSERT INTO owner_personal_transaction_audit(audit_id,personal_use_id,actor_employee_id,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?,?)`).bind(randomId("personal_audit"),id,actor.employeeId,action,JSON.stringify(before),JSON.stringify(after),new Date().toISOString());}
async function show(env:Env,event:LineEvent,item:PersonalUseFlexRecord,traceId:string):Promise<void>{if(item.status==="WAITING_CONFIRM")await respondFlexToLineEvent(env,event,buildPersonalUseConfirmFlex(item),{traceId,purpose:"OWNER_RESPONSE"});else if(item.status==="CONFIRMED")await respondFlexToLineEvent(env,event,buildPersonalUseSavedFlex(item),{traceId,purpose:"OWNER_RESPONSE"});else await respondTextToLineEvent(env,event,"รายการถอนใช้ส่วนตัวนี้ถูกยกเลิกแล้ว",{traceId,purpose:"OWNER_RESPONSE"});}

export async function handlePersonalUseText(env:Env,event:LineEvent,traceId:string,actor:StaffActor|null):Promise<PersonalUseOutcome>{
  const parsed=parsePersonalUseText(event.message?.text||"");if(!parsed)return"NOT_HANDLED";
  if(!isOwner(actor)){await respondTextToLineEvent(env,event,"คำสั่งถอนใช้ส่วนตัวใช้ได้เฉพาะบัญชี Owner ที่ยืนยันแล้ว",{traceId,purpose:"OWNER_RESPONSE"});return"REJECTED";}
  const lineUserId=event.source.userId||"",messageId=event.message?.id||"",id=randomId("personal"),now=new Date().toISOString(),ownership=actorValues(actor);
  const inserted=await env.DB.prepare(`INSERT INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,trace_id,submitted_by_employee_id,branch_id,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?, 'WAITING_CONFIRM',?,?,?,?,?,1) ON CONFLICT(message_id) DO NOTHING`).bind(id,messageId,lineUserId,parsed.transactionType,parsed.description,parsed.amountSatang,parsed.sourceWallet,parsed.transactionDate,traceId,ownership.employeeId,ownership.branchId,now,now).run();
  let item:PersonalUseFlexRecord={personalUseId:id,...parsed,status:"WAITING_CONFIRM"};
  if(Number(inserted.meta.changes||0)===1)await audit(env,actor,"CREATE_DRAFT",id,{}, {transactionType:parsed.transactionType,status:"WAITING_CONFIRM"}).run();
  else {const existing=await findMessage(env,messageId,lineUserId);if(!existing)throw new Error("Personal-use message conflict without existing row");item=existing;}
  await show(env,event,item,traceId);return item.status==="CONFIRMED"?"CONFIRMED":"WAITING_CONFIRM";
}

export async function handlePersonalUsePostback(env:Env,event:LineEvent,actor:StaffActor|null):Promise<boolean>{
  const q=new URLSearchParams(event.postback?.data||"");if(!q.get("a")?.startsWith("personal_use_"))return false;
  const traceId=`postback_${q.get("id")||"personal"}`;
  if(!isOwner(actor)){await respondTextToLineEvent(env,event,"คำสั่งถอนใช้ส่วนตัวใช้ได้เฉพาะบัญชี Owner ที่ยืนยันแล้ว",{traceId,purpose:"OWNER_RESPONSE"});return true;}
  const id=q.get("id")||"",item=await find(env,id,event.source.userId||"");if(!item){await respondTextToLineEvent(env,event,"ไม่พบรายการ หรือเมนูนี้หมดอายุแล้ว",{traceId,purpose:"OWNER_RESPONSE"});return true;}
  const now=new Date().toISOString(),action=q.get("a");
  if(action==="personal_use_confirm"&&item.status==="WAITING_CONFIRM"){
    const changed=await env.DB.prepare(`UPDATE owner_personal_transactions SET status='CONFIRMED',reviewed_by_employee_id=?,approved_at=?,updated_at=? WHERE personal_use_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(actor.employeeId,now,now,id,event.source.userId||"").run();
    if(Number(changed.meta.changes||0)===1){item.status="CONFIRMED";await env.DB.batch([audit(env,actor,"CONFIRM",id,{status:"WAITING_CONFIRM"},{status:"CONFIRMED"})]);await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"PERSONAL_USE",entityKey:id,entityVersion:1,traceId});}
    await show(env,event,item,traceId);return true;
  }
  if(action==="personal_use_cancel"&&item.status==="WAITING_CONFIRM"){
    const changed=await env.DB.prepare(`UPDATE owner_personal_transactions SET status='CANCELLED',updated_at=? WHERE personal_use_id=? AND line_user_id=? AND status='WAITING_CONFIRM'`).bind(now,id,event.source.userId||"").run();
    if(Number(changed.meta.changes||0)===1){item.status="CANCELLED";await audit(env,actor,"CANCEL",id,{status:"WAITING_CONFIRM"},{status:"CANCELLED"}).run();}
    await show(env,event,item,traceId);return true;
  }
  if(action==="personal_use_undo"&&item.status==="CONFIRMED"){
    const changed=await env.DB.prepare(`UPDATE owner_personal_transactions SET status='CANCELLED',version=version+1,updated_at=? WHERE personal_use_id=? AND line_user_id=? AND status='CONFIRMED'`).bind(now,id,event.source.userId||"").run();
    if(Number(changed.meta.changes||0)===1){item.status="CANCELLED";await env.DB.batch([audit(env,actor,"UNDO",id,{status:"CONFIRMED"},{status:"CANCELLED"})]);await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"PERSONAL_USE",entityKey:id,entityVersion:2,traceId});}
    await show(env,event,item,traceId);return true;
  }
  await show(env,event,item,traceId);return true;
}
