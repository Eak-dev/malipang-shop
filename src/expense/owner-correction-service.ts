import {authorize} from "../access/authorization";
import {getStaffActorByLineId} from "../access/repository";
import {respondFlexToLineEvent,respondTextToLineEvent} from "../line/event-response";
import {isoDateInBangkok} from "../shared/time";
import type {Env,LineEvent} from "../types";
import type {OwnerReviewIdentity} from "./online-order-review-repository";
import {buildOwnerCorrectionDraft,parseOwnerCorrectionDate,type OwnerCorrectionField,type OwnerCorrectionSnapshot} from "./owner-correction";
import {cancelOwnerCorrectionDraft,clearOwnerCorrectionInput,createOwnerCorrectionDraft,loadOwnerCorrectionDraft,loadOwnerCorrectionInput,loadOwnerExpense,ownerCorrectionStatus,searchOwnerExpenses,startOwnerCorrectionInput,storeOwnerCorrectionQuery} from "./owner-correction-repository";
import {buildOwnerCorrectionChoices,buildOwnerCorrectionFields,buildOwnerCorrectionPreview,buildOwnerCorrectionResults} from "./owner-correction-flex";

const reply=(env:Env,event:LineEvent,body:string,traceId:string)=>respondTextToLineEvent(env,event,body,{traceId,purpose:"OWNER_RESPONSE"});
const flex=(env:Env,event:LineEvent,body:unknown,traceId:string)=>respondFlexToLineEvent(env,event,body,{traceId,purpose:"OWNER_RESPONSE"});
async function identity(env:Env,event:LineEvent):Promise<OwnerReviewIdentity|null>{
  if(event.source.type!=="user"||!event.source.userId)return null;
  const actor=await getStaffActorByLineId(env,event.source.userId);
  return actor?.role==="OWNER"&&actor.scope==="ORGANIZATION"&&actor.employee.canSubmitExpense&&authorize(actor,"expense.branch.review")?{employeeId:actor.employeeId,lineUserId:event.source.userId}:null;
}
async function preview(env:Env,event:LineEvent,id:string,owner:OwnerReviewIdentity,traceId:string):Promise<void>{
  const row=await loadOwnerCorrectionDraft(env,owner,id);if(!row){await reply(env,event,"ไม่พบร่างหรือร่างหมดอายุ กรุณาเริ่มใหม่",traceId);return;}
  try{const before=JSON.parse(String(row.before_json)) as OwnerCorrectionSnapshot,after=JSON.parse(String(row.after_json)) as OwnerCorrectionSnapshot;
    await flex(env,event,buildOwnerCorrectionPreview({before,after,field:String(row.field) as OwnerCorrectionField},id),traceId);
  }catch{await reply(env,event,"ไม่สามารถตรวจร่างได้ กรุณาเริ่มใหม่",traceId);}
}
async function results(env:Env,event:LineEvent,owner:OwnerReviewIdentity,query:string,traceId:string,cursor=""):Promise<void>{
  const parts=cursor?cursor.split("|"):[];if(cursor&&(parts.length!==2||!parts[0]||!parts[1])){await reply(env,event,"หน้าค้นหาหมดอายุ กรุณาเริ่มใหม่",traceId);return;}
  const rows=await searchOwnerExpenses(env,owner,query,parts[0]||"",parts[1]||""),shown=rows.slice(0,8),last=shown.at(-1);
  const next=rows.length>8&&last?`${String(last.created_at)}|${String(last.expense_id)}`:null;
  await flex(env,event,buildOwnerCorrectionResults(shown,query,next),traceId);
}
export async function handleOwnerCorrectionText(env:Env,event:LineEvent,traceId:string):Promise<boolean>{
  if(env.OWNER_EXPENSE_CORRECTION_ENABLED!=="true"||event.message?.type!=="text")return false;
  const text=(event.message.text||"").trim(),owner=await identity(env,event);
  if(text==="แก้ไขค่าใช้จ่าย"){
    if(!owner){await reply(env,event,"เมนูนี้สำหรับเจ้าของที่ยืนยันตัวตนแล้ว",traceId);return true;}
    if(!await startOwnerCorrectionInput(env,owner,{mode:"SEARCH"})){await reply(env,event,"ยังเปิดการค้นหาไม่ได้ กรุณาลองใหม่",traceId);return true;}
    await reply(env,event,"พิมพ์ชื่อร้าน วันที่ชำระ เช่น 28/10/2569 หรือยอดเงินที่ต้องการค้นหา",traceId);return true;
  }
  if(!owner)return false;
  const input=await loadOwnerCorrectionInput(env,owner);if(!input)return false;
  const inputId=String(input.input_id);
  if(text==="ยกเลิก"){await clearOwnerCorrectionInput(env,owner,inputId);await reply(env,event,"ยกเลิกการกรอกแล้ว รายการเดิมยังไม่เปลี่ยน",traceId);return true;}
  if(input.mode==="SEARCH"){
    if(!await storeOwnerCorrectionQuery(env,owner,inputId,text)){await reply(env,event,"กรุณาพิมพ์คำค้นอย่างน้อย 2 ตัวอักษร",traceId);return true;}
    await results(env,event,owner,text,traceId);return true;
  }
  if(input.mode!=="VALUE")return false;
  let snapshot:OwnerCorrectionSnapshot;try{snapshot=JSON.parse(String(input.snapshot_json)) as OwnerCorrectionSnapshot;}catch{await clearOwnerCorrectionInput(env,owner,inputId);await reply(env,event,"ข้อมูลร่างไม่พร้อม กรุณาเริ่มใหม่",traceId);return true;}
  const field=String(input.field) as OwnerCorrectionField;
  if(field==="transactionDate"){const date=parseOwnerCorrectionDate(text);if(!date||date>isoDateInBangkok()){await reply(env,event,"กรุณาระบุวันชำระที่ถูกต้องและไม่อยู่ในอนาคต เช่น 28/10/2569",traceId);return true;}}
  if(!buildOwnerCorrectionDraft(snapshot,field,text)){await reply(env,event,"ค่าไม่ถูกต้องหรือเหมือนค่าเดิม กรุณาตรวจแล้วพิมพ์ใหม่",traceId);return true;}
  const id=await createOwnerCorrectionDraft(env,owner,snapshot,field,text,Date.now(),inputId);
  if(!id){await reply(env,event,"ข้อมูลเปลี่ยนแล้วหรือรับข้อความนี้ไปแล้ว กรุณาเปิดรายการใหม่",traceId);return true;}
  await clearOwnerCorrectionInput(env,owner,inputId);await preview(env,event,id,owner,traceId);return true;
}
export async function handleOwnerCorrectionPostback(env:Env,event:LineEvent,traceId:string):Promise<boolean>{
  if(env.OWNER_EXPENSE_CORRECTION_ENABLED!=="true")return false;
  const q=new URLSearchParams(event.postback?.data||""),action=q.get("a")||"";if(!action.startsWith("owner_correction_"))return false;
  const owner=await identity(env,event);if(!owner){await reply(env,event,"เมนูนี้สำหรับเจ้าของที่ยืนยันตัวตนแล้ว",traceId);return true;}
  if(action==="owner_correction_next"){
    const session=await loadOwnerCorrectionInput(env,owner),query=String(session?.search_query||"");
    if(!query){await reply(env,event,"การค้นหาหมดอายุ กรุณาพิมพ์ แก้ไขค่าใช้จ่าย",traceId);return true;}
    await results(env,event,owner,query,traceId,q.get("cursor")||"");return true;
  }
  const id=q.get("id")||"";
  if(action==="owner_correction_status"){
    const status=await ownerCorrectionStatus(env,owner,id),messages={DRAFT:"ร่างนี้ยังไม่ได้ยืนยัน รายการเดิมยังไม่เปลี่ยน",EXPIRED:"ร่างหมดอายุ กรุณาเปิดรายการใหม่",CANCELLED:"ยกเลิกร่างแล้ว รายการเดิมยังไม่เปลี่ยน",STALE:"ข้อมูลเปลี่ยนแล้ว กรุณาเปิดรายการใหม่",SYNC_PENDING:"บันทึกแล้ว กำลังซิงก์และตรวจข้อมูลที่เกี่ยวข้อง",SYNC_FAILED:"บันทึกแล้ว แต่การซิงก์ยังไม่สำเร็จ ระบบต้องตรวจและลองต่อ",COMPLETED:"ซิงก์และตรวจข้อมูลที่เกี่ยวข้องเรียบร้อยแล้ว"} as const;
    await reply(env,event,status?messages[status]:"ไม่พบรายการหรือไม่มีสิทธิ์ตรวจสถานะ",traceId);return true;
  }
  if(action==="owner_correction_cancel"){
    const cancelled=await cancelOwnerCorrectionDraft(env,owner,id);await reply(env,event,cancelled?"ยกเลิกร่างแล้ว รายการเดิมยังไม่เปลี่ยน":"ร่างหมดอายุหรือได้รับการจัดการแล้ว",traceId);return true;
  }
  if(action==="owner_correction_confirm"){
    // Fail closed until the atomic financial update and verified Sheets outbox are implemented.
    await reply(env,event,"ยังบันทึกการแก้ไขไม่ได้ รายการเดิมยังไม่เปลี่ยน กรุณาติดต่อผู้ดูแล",traceId);return true;
  }
  const snapshot=await loadOwnerExpense(env,owner,id);if(!snapshot){await reply(env,event,"ไม่พบรายการ กรุณาค้นหาใหม่",traceId);return true;}
  if(action==="owner_correction_open"){await flex(env,event,buildOwnerCorrectionFields(snapshot),traceId);return true;}
  if(q.get("v")===null||Number(q.get("v"))!==snapshot.version){await reply(env,event,"ข้อมูลเปลี่ยนแล้ว กรุณาเปิดรายการใหม่",traceId);return true;}
  if(action==="owner_correction_category"||action==="owner_correction_payment"){
    await flex(env,event,buildOwnerCorrectionChoices(snapshot,action==="owner_correction_category"?"category":"payment"),traceId);return true;
  }
  if(action==="owner_correction_input"){
    const field=q.get("field");if(field!=="description"&&field!=="amountSatang"&&field!=="transactionDate"){await reply(env,event,"ช่องแก้ไขไม่ถูกต้อง",traceId);return true;}
    if(!await startOwnerCorrectionInput(env,owner,{mode:"VALUE",field,snapshot})){await reply(env,event,"ยังเริ่มแก้ไขไม่ได้ กรุณาลองใหม่",traceId);return true;}
    await reply(env,event,field==="description"?"พิมพ์รายละเอียดใหม่":field==="amountSatang"?"พิมพ์ยอดชำระสุทธิใหม่ เช่น 519.50":"พิมพ์วันที่ชำระ เช่น 28/10/2569",traceId);return true;
  }
  if(action==="owner_correction_set_category"||action==="owner_correction_set_payment"){
    const field=action==="owner_correction_set_category"?"category":"payment",value=field==="category"?String(q.get("category")||""):{paymentKey:String(q.get("payment")||""),sourceWallet:String(q.get("wallet")||"")};
    const correction=await createOwnerCorrectionDraft(env,owner,snapshot,field,value);
    if(!correction){await reply(env,event,"ค่าเดิม ข้อมูลเปลี่ยน หรือเลือกค่าไม่ถูกต้อง กรุณาตรวจรายการใหม่",traceId);return true;}
    await preview(env,event,correction,owner,traceId);return true;
  }
  await reply(env,event,"เมนูนี้ใช้ไม่ได้ กรุณาค้นหารายการใหม่",traceId);return true;
}
