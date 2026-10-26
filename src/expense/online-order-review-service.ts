import { authorize } from "../access/authorization";
import { getStaffActorByLineId,type StaffActor } from "../access/repository";
import { safeRecordMetric } from "../db/repositories";
import { respondFlexToLineEvent,respondTextToLineEvent } from "../line/event-response";
import { isoDateInBangkok } from "../shared/time";
import type { Env,LineEvent } from "../types";
import { buildExpenseSavedFlex,buildExpenseSummaryFlex,type ExpenseFlexRecord } from "./flex";
import { parseOwnerAmount,parseOwnerDate,parseOwnerFacts,reviewReasonLabels,type OrderReviewView } from "./online-order-review";
import { buildOnlineOrderEditFlex,buildOnlineOrderQueueFlex,buildOnlineOrderReviewFlex } from "./online-order-review-flex";
import { activeOwnerSql,clearOwnerReviewInput,findOwnerReviewInput,listOwnerReviews,loadOwnerReview,onlineOrderReviewSummary,promoteOwnerReviewedOrder,saveOwnerOrderFacts,seedOwnerReview,startOwnerReviewInput,viewFromReviewRow,type OwnerReviewIdentity,type ReviewRow } from "./online-order-review-repository";
import { stateFromStoredDocument,unresolvedReviewFields } from "./review-state";

const listCommands=new Set(["รายการค้าง","ตรวจรายการค้าง","ค่าใช้จ่ายค้าง","/expense-review"]);
const allowedActions=new Set(["order_review_list","order_review_open","order_review_edit","order_review_input","order_review_paid","order_review_date","order_review_continue"]);
const reply=(env:Env,event:LineEvent,message:string,traceId:string)=>respondTextToLineEvent(env,event,message,{traceId,purpose:"EXPENSE_RESPONSE"});
const flex=(env:Env,event:LineEvent,message:unknown,traceId:string)=>respondFlexToLineEvent(env,event,message,{traceId,purpose:"EXPENSE_RESPONSE"});
async function verifiedOwner(env:Env,event:LineEvent):Promise<OwnerReviewIdentity|null>{
  if(event.source.type!=="user"||!event.source.userId||env.EXPENSE_ENABLED!=="true")return null;
  const actor=await getStaffActorByLineId(env,event.source.userId);
  return actor?.role==="OWNER"&&actor.scope==="ORGANIZATION"&&actor.employee.canSubmitExpense&&authorize(actor,"expense.branch.review")
    ?{employeeId:actor.employeeId,lineUserId:event.source.userId}:null;
}
async function deny(env:Env,event:LineEvent,traceId:string):Promise<void>{await reply(env,event,"เมนูนี้สำหรับเจ้าของที่ยืนยันตัวตนและยังมีสิทธิ์ตรวจค่าใช้จ่ายเท่านั้น",traceId);}
function withNotice(message:ReturnType<typeof buildOnlineOrderReviewFlex>,notice?:string){
  if(notice)message.contents.body.contents.unshift({type:"text",text:notice,wrap:true,size:"sm",color:"#795548"});
  return message;
}
async function showDraft(env:Env,event:LineEvent,view:OrderReviewView,owner:OwnerReviewIdentity,traceId:string):Promise<void>{
  if(!view.expenseId||!view.reviewerOwnsDraft){await reply(env,event,"คำสั่งซื้อนี้มีค่าใช้จ่ายเดิมแล้ว กรุณาตรวจรายการเดิมก่อน ไม่สร้างรายการเพิ่ม",traceId);return;}
  const row=await env.DB.prepare(`SELECT e.*,d.normalized_json AS review_normalized_json FROM expense_events e
    JOIN expense_documents d ON d.document_id=? AND d.expense_id=e.expense_id
    WHERE e.expense_id=? AND e.line_user_id=? AND ${activeOwnerSql}`).bind(view.documentId,view.expenseId,owner.lineUserId,owner.employeeId,owner.lineUserId).first<ReviewRow>();
  if(!row){await reply(env,event,"ไม่พบรายการที่รอยืนยัน กรุณาเปิดรายการค้างใหม่",traceId);return;}
  let stored:unknown={};try{stored=JSON.parse(String(row.review_normalized_json||"{}"));}catch{/* Display remains fail-closed. */}
  const state=stateFromStoredDocument(stored)||{requiredFields:["payment","description","category"] as const,confirmedFields:[]};
  const expense:ExpenseFlexRecord={expenseId:String(row.expense_id),description:String(row.description),amountSatang:Number(row.amount_satang),paymentKey:String(row.payment_key),sourceWallet:String(row.source_wallet),category:String(row.category),transactionDate:String(row.transaction_date),status:String(row.status),documentType:"ONLINE_ORDER",reviewRequiredFields:[...state.requiredFields],reviewConfirmedFields:[...state.confirmedFields],unresolvedRequiredFields:unresolvedReviewFields({...state,requiredFields:[...state.requiredFields]})};
  if(expense.status==="CANCELLED"){await reply(env,event,"รายการนี้ถูกยกเลิกแล้ว หลักฐานและประวัติยังอยู่",traceId);return;}
  await flex(env,event,expense.status==="CONFIRMED"?buildExpenseSavedFlex(expense):buildExpenseSummaryFlex(expense),traceId);
}
async function renderCase(env:Env,event:LineEvent,id:string,owner:OwnerReviewIdentity,traceId:string,notice?:string):Promise<void>{
  const row=await loadOwnerReview(env,id,owner);if(!row){await deny(env,event,traceId);return;}
  const view=viewFromReviewRow(row,owner.lineUserId);
  if(view.phase==="DRAFTED"){await showDraft(env,event,view,owner,traceId);return;}
  await flex(env,event,withNotice(buildOnlineOrderReviewFlex(view),notice),traceId);
}
async function renderList(env:Env,event:LineEvent,owner:OwnerReviewIdentity,traceId:string,after=""):Promise<void>{
  const [page,summary]=await Promise.all([listOwnerReviews(env,owner,after),onlineOrderReviewSummary(env,owner)]);
  await flex(env,event,buildOnlineOrderQueueFlex(page.views,summary,page.nextCursor),traceId);
}

/** Called only for retained REVIEW_ONLY evidence; no automated promotion. */
export async function maybeRespondOwnerOrderReview(env:Env,event:LineEvent,target:{documentId?:string;orderId?:string},traceId:string):Promise<boolean>{
  const owner=await verifiedOwner(env,event);if(!owner)return false;
  let id=target.documentId||"";
  if(!id&&target.orderId){const claim=await env.DB.prepare(`SELECT document_id FROM expense_online_order_claims WHERE order_id=? AND state='REVIEW_ONLY'`).bind(target.orderId).first<{document_id:string}>();id=claim?.document_id||"";}
  if(!id)return false;
  await seedOwnerReview(env,id,owner);await clearOwnerReviewInput(env,owner);await renderCase(env,event,id,owner,traceId);return true;
}

export async function handleOnlineOrderReviewPostback(env:Env,event:LineEvent,traceId:string):Promise<boolean>{
  const q=new URLSearchParams(event.postback?.data||""),action=q.get("a")||"";
  if(!action.startsWith("order_review_"))return false;
  const owner=await verifiedOwner(env,event);if(!owner){await deny(env,event,traceId);return true;}
  if(!allowedActions.has(action)){await reply(env,event,"เมนูนี้ใช้ไม่ได้ กรุณาพิมพ์ รายการค้าง เพื่อเปิดใหม่",traceId);return true;}
  if(action==="order_review_list"){await clearOwnerReviewInput(env,owner);await renderList(env,event,owner,traceId,q.get("after")||"");return true;}
  const id=q.get("id")||"";
  if(!/^[A-Za-z0-9_-]{8,128}$/.test(id)){await reply(env,event,"ไม่พบรายการ กรุณาเปิดรายการค้างใหม่",traceId);return true;}
  await seedOwnerReview(env,id,owner);
  const row=await loadOwnerReview(env,id,owner);if(!row){await deny(env,event,traceId);return true;}
  const priorInput=await findOwnerReviewInput(env,owner);
  if(action==="order_review_open"||priorInput&&priorInput.document_id!==id)await clearOwnerReviewInput(env,owner);
  const view=viewFromReviewRow(row,owner.lineUserId);
  if(action==="order_review_open"||view.phase==="DRAFTED"){await renderCase(env,event,id,owner,traceId);return true;}
  if(view.blocked.length){await renderCase(env,event,id,owner,traceId);return true;}
  const version=Number(q.get("v"));
  if(q.get("v")===null||!Number.isSafeInteger(version)||version!==view.version){await renderCase(env,event,id,owner,traceId,"ข้อมูลเปลี่ยนแล้ว แสดงข้อมูลล่าสุดให้ตรวจอีกครั้ง");return true;}
  if(action==="order_review_edit"){await flex(env,event,buildOnlineOrderEditFlex(view),traceId);return true;}
  if(action==="order_review_input"){
    const field=q.get("field");if(field!=="amount"&&field!=="date"){await renderCase(env,event,id,owner,traceId);return true;}
    if(!await startOwnerReviewInput(env,row,owner,field)){await renderCase(env,event,id,owner,traceId,"ข้อมูลเปลี่ยนแล้ว กรุณาเลือกช่องใหม่");return true;}
    await reply(env,event,field==="amount"?"พิมพ์ยอดชำระจริงของรายการนี้ เช่น 519 หรือ 519.50 บาท\nพิมพ์ ยกเลิก เพื่อออกจากการกรอก":"พิมพ์วันที่ชำระเงินจริง เช่น 25/10/2569 หรือ 25/10/2026\nใช้วันที่จากการชำระเงินจริง ไม่ใช้เวลาสั่งซื้อ\nพิมพ์ ยกเลิก เพื่อออกจากการกรอก",traceId);return true;
  }
  const facts=parseOwnerFacts(row.owner_facts_json),now=new Date().toISOString();
  if(action==="order_review_paid"){
    const paid=q.get("paid");if(paid!=="yes"&&paid!=="no"){await renderCase(env,event,id,owner,traceId);return true;}
    facts.paymentStatus={value:paid==="yes"?"PAID":"UNPAID",source:"OWNER",actorEmployeeId:owner.employeeId,confirmedAt:now};
    const saved=await saveOwnerOrderFacts(env,row,owner,facts);await renderCase(env,event,id,owner,traceId,saved?undefined:"ข้อมูลเปลี่ยนแล้ว แสดงข้อมูลล่าสุด");return true;
  }
  if(action==="order_review_date"){
    const date=parseOwnerDate(event.postback?.params?.date||"");
    if(!date||date>isoDateInBangkok()){await renderCase(env,event,id,owner,traceId,"กรุณาเลือกวันที่ชำระเงินจริงที่ไม่อยู่ในอนาคต");return true;}
    facts.date={value:date,source:"OWNER",actorEmployeeId:owner.employeeId,confirmedAt:now};
    const saved=await saveOwnerOrderFacts(env,row,owner,facts);await renderCase(env,event,id,owner,traceId,saved?undefined:"ข้อมูลเปลี่ยนแล้ว แสดงข้อมูลล่าสุด");return true;
  }
  if(view.missing.length){await renderCase(env,event,id,owner,traceId,"ยังมีข้อมูลที่ต้องยืนยันก่อนดำเนินการต่อ");return true;}
  const started=Date.now(),result=await promoteOwnerReviewedOrder(env,row,owner);
  await safeRecordMetric(env,traceId,"expense_owner_order_review_ms",Date.now()-started,{outcome:result.expenseId?"DRAFTED":result.reason||"STALE"});
  if(result.reason){await renderCase(env,event,id,owner,traceId,reviewReasonLabels[result.reason]);return true;}
  await renderCase(env,event,id,owner,traceId,result.expenseId?undefined:"ข้อมูลเปลี่ยนแล้ว กรุณาตรวจรายการล่าสุด");return true;
}

export async function handleOnlineOrderReviewText(env:Env,event:LineEvent,traceId:string,actor?:StaffActor|null):Promise<boolean>{
  const value=(event.message?.text||"").trim(),isList=listCommands.has(value.toLowerCase());
  if(!isList&&actor?.role!=="OWNER")return false;
  const owner=await verifiedOwner(env,event);if(!owner){if(isList){await deny(env,event,traceId);return true;}return false;}
  if(isList){await clearOwnerReviewInput(env,owner);await renderList(env,event,owner,traceId);return true;}
  // Explicit commands retain their existing routers and never become a field
  // value merely because an owner has a pending input.
  if(/^[\/]|[|｜]/.test(value))return false;
  const input=await findOwnerReviewInput(env,owner);if(!input)return false;
  const id=String(input.document_id),row=await loadOwnerReview(env,id,owner);
  if(value==="ยกเลิก"){await clearOwnerReviewInput(env,owner,String(input.created_at));await renderCase(env,event,id,owner,traceId,"ยกเลิกการกรอกแล้ว ข้อมูลเดิมยังอยู่");return true;}
  if(!row||String(input.expires_at)<new Date().toISOString()||Number(input.review_version)!==Number(row.review_version)||row.status!=="WAITING_REVIEW"){
    await clearOwnerReviewInput(env,owner,String(input.created_at));
    if(row)await renderCase(env,event,id,owner,traceId,"การกรอกหมดอายุหรือข้อมูลเปลี่ยนแล้ว กรุณาเลือกช่องใหม่");else await deny(env,event,traceId);return true;
  }
  const view=viewFromReviewRow(row,owner.lineUserId);if(view.blocked.length){await clearOwnerReviewInput(env,owner,String(input.created_at));await renderCase(env,event,id,owner,traceId);return true;}
  const facts=parseOwnerFacts(row.owner_facts_json),now=new Date().toISOString();
  if(input.field==="amount"){
    const amount=parseOwnerAmount(value);if(amount==null){await reply(env,event,"ช่องนี้รับยอดชำระ เช่น 519 หรือ 519.50 บาท กรุณาพิมพ์เฉพาะยอด หรือพิมพ์ ยกเลิก",traceId);return true;}
    facts.amount={value:amount,source:"OWNER",actorEmployeeId:owner.employeeId,confirmedAt:now};
  }else{
    const date=parseOwnerDate(value);if(!date||date>isoDateInBangkok()){
      await reply(env,event,`ช่องนี้รับวันที่ชำระจริง เช่น 25/10/2569${view.amountSatang!=null?`\nยอด ${(view.amountSatang/100).toFixed(2)} บาทมีอยู่แล้ว ไม่ต้องยืนยันยอดซ้ำ`:""}\nพิมพ์ ยกเลิก เพื่อออกจากการกรอก`,traceId);return true;
    }
    facts.date={value:date,source:"OWNER",actorEmployeeId:owner.employeeId,confirmedAt:now};
  }
  const saved=await saveOwnerOrderFacts(env,row,owner,facts,input);
  await renderCase(env,event,id,owner,traceId,saved?undefined:"ข้อมูลเปลี่ยนแล้ว กรุณาตรวจรายการล่าสุด");return true;
}
