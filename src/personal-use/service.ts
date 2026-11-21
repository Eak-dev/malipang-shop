import { authorize } from "../access/authorization";
import type { StaffActor } from "../access/repository";
import { enqueueSheetSync } from "../db/repositories";
import { respondFlexToLineEvent,respondTextToLineEvent } from "../line/event-response";
import { randomId } from "../shared/ids";
import type { Env,LineEvent } from "../types";
import { buildPersonalUseConfirmFlex,buildPersonalUseSavedFlex,type PersonalUseFlexRecord } from "./flex";
import { hasPersonalUseCommandPrefix,parsePersonalUseText } from "./text-parser";

export type PersonalUseOutcome="NOT_HANDLED"|"CONFIRMED"|"WAITING_CONFIRM"|"REJECTED";
type Row=Record<string,unknown>;
type PersonalUseStatus="WAITING_CONFIRM"|"CONFIRMED"|"CANCELLED";
type PersonalUseAction="CONFIRM"|"CANCEL"|"UNDO";
type PersonalUseRecord=PersonalUseFlexRecord&{version:number};
function isOwner(actor:StaffActor|null|undefined):actor is StaffActor{return Boolean(actor?.role==="OWNER"&&authorize(actor,"expense.submit",{employeeId:actor.employeeId}));}
function record(row:Row):PersonalUseRecord{return{personalUseId:String(row.personal_use_id),transactionType:String(row.transaction_type) as PersonalUseFlexRecord["transactionType"],description:String(row.description),amountSatang:Number(row.amount_satang),sourceWallet:String(row.source_wallet),transactionDate:String(row.transaction_date),status:String(row.status),version:Number(row.version)};}
function actorValues(actor:StaffActor):{employeeId:string;branchId:string|null}{return{employeeId:actor.employeeId,branchId:actor.branchId||null};}
async function find(env:Env,id:string,lineUserId:string):Promise<PersonalUseRecord|null>{const row=await env.DB.prepare(`SELECT * FROM owner_personal_transactions WHERE personal_use_id=? AND line_user_id=? LIMIT 1`).bind(id,lineUserId).first<Row>();return row?record(row):null;}
async function findMessage(env:Env,messageId:string,lineUserId:string):Promise<PersonalUseRecord|null>{const row=await env.DB.prepare(`SELECT * FROM owner_personal_transactions WHERE message_id=? AND line_user_id=? LIMIT 1`).bind(messageId,lineUserId).first<Row>();return row?record(row):null;}
function createAudit(env:Env,actor:StaffActor,id:string,transactionType:string){return env.DB.prepare(`INSERT INTO owner_personal_transaction_audit(audit_id,personal_use_id,actor_employee_id,action,before_json,after_json,created_at) SELECT ?,personal_use_id,?,'CREATE_DRAFT','{}',?,? FROM owner_personal_transactions WHERE personal_use_id=?`).bind(randomId("personal_audit"),actor.employeeId,JSON.stringify({transactionType,status:"WAITING_CONFIRM"}),new Date().toISOString(),id);}
function claimTransitionAudit(env:Env,input:{actor:StaffActor;action:PersonalUseAction;auditId:string;id:string;lineUserId:string;from:PersonalUseStatus;to:PersonalUseStatus;expectedVersion:number;nextVersion:number;now:string}){
  return env.DB.prepare(`INSERT INTO owner_personal_transaction_audit(audit_id,personal_use_id,actor_employee_id,action,before_json,after_json,created_at)
    SELECT ?,personal_use_id,?,?,?,?,? FROM owner_personal_transactions
    WHERE personal_use_id=? AND line_user_id=? AND status=? AND version=?`).bind(input.auditId,input.actor.employeeId,input.action,JSON.stringify({status:input.from,version:input.expectedVersion}),JSON.stringify({status:input.to,version:input.nextVersion}),input.now,input.id,input.lineUserId,input.from,input.expectedVersion);
}
function transitionUpdate(env:Env,input:{actor:StaffActor;action:PersonalUseAction;auditId:string;id:string;lineUserId:string;from:PersonalUseStatus;to:PersonalUseStatus;expectedVersion:number;nextVersion:number;now:string}){
  const guard=`personal_use_id=? AND line_user_id=? AND status=? AND version=? AND EXISTS(SELECT 1 FROM owner_personal_transaction_audit WHERE audit_id=? AND personal_use_id=owner_personal_transactions.personal_use_id AND action=?)`;
  if(input.action==="CONFIRM")return env.DB.prepare(`UPDATE owner_personal_transactions SET status=?,reviewed_by_employee_id=?,approved_at=?,updated_at=?,version=? WHERE ${guard}`).bind(input.to,input.actor.employeeId,input.now,input.now,input.nextVersion,input.id,input.lineUserId,input.from,input.expectedVersion,input.auditId,input.action);
  return env.DB.prepare(`UPDATE owner_personal_transactions SET status=?,updated_at=?,version=? WHERE ${guard}`).bind(input.to,input.now,input.nextVersion,input.id,input.lineUserId,input.from,input.expectedVersion,input.auditId,input.action);
}
function transitionSyncOutbox(env:Env,input:{action:PersonalUseAction;auditId:string;id:string;lineUserId:string;to:PersonalUseStatus;nextVersion:number;traceId:string;now:string}){
  return env.DB.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,next_attempt_at,lease_until,lease_token)
    SELECT ?,'PERSONAL_USE',personal_use_id,version,?,'PENDING',0,?,?,NULL,NULL FROM owner_personal_transactions
    WHERE personal_use_id=? AND line_user_id=? AND status=? AND version=?
      AND EXISTS(SELECT 1 FROM owner_personal_transaction_audit WHERE audit_id=? AND personal_use_id=owner_personal_transactions.personal_use_id AND action=?)
    ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING`).bind(randomId("sync"),input.traceId,input.now,input.now,input.id,input.lineUserId,input.to,input.nextVersion,input.auditId,input.action);
}
async function transition(env:Env,input:{actor:StaffActor;action:PersonalUseAction;id:string;lineUserId:string;from:PersonalUseStatus;to:PersonalUseStatus;expectedVersion:number;traceId:string;sync:boolean}):Promise<{won:boolean;version:number}>{
  const nextVersion=input.expectedVersion+1,auditId=randomId("personal_audit"),now=new Date().toISOString(),transitionInput={...input,auditId,nextVersion,now};
  // D1 executes batch statements in one transaction. The conditional audit ID
  // is the transition token: the CAS update and outbox must see that exact token.
  const statements=[claimTransitionAudit(env,transitionInput),transitionUpdate(env,transitionInput)];
  if(input.sync&&env.SHEETS_SYNC_ENABLED==="true")statements.push(transitionSyncOutbox(env,transitionInput));
  const [,updated]=await env.DB.batch(statements);
  return{won:Number(updated?.meta.changes||0)===1,version:nextVersion};
}
async function show(env:Env,event:LineEvent,item:PersonalUseFlexRecord,traceId:string):Promise<void>{if(item.status==="WAITING_CONFIRM")await respondFlexToLineEvent(env,event,buildPersonalUseConfirmFlex(item),{traceId,purpose:"OWNER_RESPONSE"});else if(item.status==="CONFIRMED")await respondFlexToLineEvent(env,event,buildPersonalUseSavedFlex(item),{traceId,purpose:"OWNER_RESPONSE"});else await respondTextToLineEvent(env,event,"รายการถอนใช้ส่วนตัวนี้ถูกยกเลิกแล้ว",{traceId,purpose:"OWNER_RESPONSE"});}

export async function handlePersonalUseText(env:Env,event:LineEvent,traceId:string,actor:StaffActor|null):Promise<PersonalUseOutcome>{
  const text=event.message?.text||"",parsed=parsePersonalUseText(text);
  if(!parsed){
    if(!hasPersonalUseCommandPrefix(text))return"NOT_HANDLED";
    await respondTextToLineEvent(env,event,["รูปแบบรายการส่วนตัวไม่ถูกต้อง","กรุณาใช้: ส่วนตัว | จำนวน | บัญชีร้าน/เงินสดหน้าร้าน | รายละเอียด","หรือ: คืนเงินส่วนตัว | จำนวน | บัญชีร้าน/เงินสดหน้าร้าน | รายละเอียด","เพิ่มวันที่ท้ายข้อความได้เป็น YYYY-MM-DD"].join("\n"),{traceId,purpose:"OWNER_RESPONSE"});
    return"REJECTED";
  }
  if(!isOwner(actor)){await respondTextToLineEvent(env,event,"คำสั่งถอนใช้ส่วนตัวใช้ได้เฉพาะบัญชี Owner ที่ยืนยันแล้ว",{traceId,purpose:"OWNER_RESPONSE"});return"REJECTED";}
  const lineUserId=event.source.userId||"",messageId=event.message?.id||"",id=randomId("personal"),now=new Date().toISOString(),ownership=actorValues(actor);
  const [inserted]=await env.DB.batch([env.DB.prepare(`INSERT INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,trace_id,submitted_by_employee_id,branch_id,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?, 'WAITING_CONFIRM',?,?,?,?,?,1) ON CONFLICT(message_id) DO NOTHING`).bind(id,messageId,lineUserId,parsed.transactionType,parsed.description,parsed.amountSatang,parsed.sourceWallet,parsed.transactionDate,traceId,ownership.employeeId,ownership.branchId,now,now),createAudit(env,actor,id,parsed.transactionType)]);
  let item:PersonalUseRecord={personalUseId:id,...parsed,status:"WAITING_CONFIRM",version:1};
  if(Number(inserted?.meta.changes||0)!==1){const existing=await findMessage(env,messageId,lineUserId);if(!existing)throw new Error("Personal-use message conflict without existing row");item=existing;}
  await show(env,event,item,traceId);return item.status==="CONFIRMED"?"CONFIRMED":"WAITING_CONFIRM";
}

export async function handlePersonalUsePostback(env:Env,event:LineEvent,actor:StaffActor|null):Promise<boolean>{
  const q=new URLSearchParams(event.postback?.data||"");if(!q.get("a")?.startsWith("personal_use_"))return false;
  const traceId=`postback_${q.get("id")||"personal"}`;
  if(!isOwner(actor)){await respondTextToLineEvent(env,event,"คำสั่งถอนใช้ส่วนตัวใช้ได้เฉพาะบัญชี Owner ที่ยืนยันแล้ว",{traceId,purpose:"OWNER_RESPONSE"});return true;}
  const id=q.get("id")||"",lineUserId=event.source.userId||"";let item=await find(env,id,lineUserId);if(!item){await respondTextToLineEvent(env,event,"ไม่พบรายการ หรือเมนูนี้หมดอายุแล้ว",{traceId,purpose:"OWNER_RESPONSE"});return true;}
  const action=q.get("a");
  if(action==="personal_use_confirm"&&item.status==="WAITING_CONFIRM"){
    const result=await transition(env,{actor,action:"CONFIRM",id,lineUserId,from:"WAITING_CONFIRM",to:"CONFIRMED",expectedVersion:item.version,traceId,sync:true});
    if(result.won)await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"PERSONAL_USE",entityKey:id,entityVersion:result.version,traceId});
  }
  else if(action==="personal_use_cancel"&&item.status==="WAITING_CONFIRM"){
    await transition(env,{actor,action:"CANCEL",id,lineUserId,from:"WAITING_CONFIRM",to:"CANCELLED",expectedVersion:item.version,traceId,sync:false});
  }
  else if(action==="personal_use_undo"&&item.status==="CONFIRMED"){
    const result=await transition(env,{actor,action:"UNDO",id,lineUserId,from:"CONFIRMED",to:"CANCELLED",expectedVersion:item.version,traceId,sync:true});
    if(result.won)await enqueueSheetSync(env,{kind:"SHEETS_SYNC",entityType:"PERSONAL_USE",entityKey:id,entityVersion:result.version,traceId});
  }
  item=await find(env,id,lineUserId);if(!item)throw new Error("Personal-use transaction disappeared after transition");
  await show(env,event,item,traceId);return true;
}
