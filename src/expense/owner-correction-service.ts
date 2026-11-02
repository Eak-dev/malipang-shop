import {authorize} from "../access/authorization";
import {getStaffActorByLineId} from "../access/repository";
import {respondFlexToLineEvent,respondTextToLineEvent} from "../line/event-response";
import {isoDateInBangkok} from "../shared/time";
import type {Env,LineEvent} from "../types";
import type {OwnerReviewIdentity} from "./online-order-review-repository";
import {buildOwnerCorrectionDraft,parseOwnerCorrectionDate,type OwnerCorrectionField,type OwnerCorrectionSnapshot} from "./owner-correction";
import {inspectOwnerCorrectionPeriods,recordOwnerCorrectionPeriodDecision} from "./owner-correction-periods";
import {confirmOwnerCorrection} from "./owner-correction-confirmed";
import {cancelOwnerCorrectionDraft,clearOwnerCorrectionInput,commitPendingOwnerCorrection,createOwnerCorrectionDraft,loadOwnerCorrectionDraft,loadOwnerCorrectionInput,loadOwnerExpense,ownerCorrectionStatus,searchOwnerExpenses,startOwnerCorrectionInput,storeOwnerCorrectionQuery} from "./owner-correction-repository";
import {buildOwnerCorrectionChoices,buildOwnerCorrectionFields,buildOwnerCorrectionFinalPreview,buildOwnerCorrectionManualReview,buildOwnerCorrectionManualReviewList,buildOwnerCorrectionPeriodQuestion,buildOwnerCorrectionPeriods,buildOwnerCorrectionPreview,buildOwnerCorrectionResults,buildOwnerCorrectionSyncPending} from "./owner-correction-flex";
import {getOwnerCorrectionManualReview,holdOwnerCorrectionForReview,listOwnerCorrectionManualReviews,retryOwnerCorrectionManualReview,type ManualCorrectionReason} from "./owner-correction-manual-review";

interface OwnerCorrectionPostbackPorts{periods:typeof inspectOwnerCorrectionPeriods;decision:typeof recordOwnerCorrectionPeriodDecision;confirmed?:typeof confirmOwnerCorrection}
const postbackDefaults:OwnerCorrectionPostbackPorts={periods:inspectOwnerCorrectionPeriods,decision:recordOwnerCorrectionPeriodDecision,confirmed:confirmOwnerCorrection};

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
async function hold(env:Env,event:LineEvent,owner:OwnerReviewIdentity,id:string,reason:ManualCorrectionReason,traceId:string):Promise<void>{
  if(await holdOwnerCorrectionForReview(env,owner,id,reason)==="HELD"){const existing=await getOwnerCorrectionManualReview(env,owner,id);await flex(env,event,buildOwnerCorrectionManualReview(id,existing?.reason_code||reason),traceId);}
  else await reply(env,event,"ข้อมูลเปลี่ยนหรือร่างหมดอายุ กรุณาค้นหารายการใหม่",traceId);
}
async function manualReviews(env:Env,event:LineEvent,owner:OwnerReviewIdentity,traceId:string,cursor=""):Promise<void>{
  const parts=cursor?cursor.split("|"):[];if(cursor&&(parts.length!==2||!parts[0]||!parts[1])){await reply(env,event,"หน้ารายการหมดอายุ กรุณาพิมพ์ ‘รายการแก้ไขรอตรวจ’",traceId);return;}
  const rows=await listOwnerCorrectionManualReviews(env,owner,parts[0]||"",parts[1]||""),shown=rows.slice(0,8),last=shown.at(-1),next=rows.length>8&&last?`${String(last.created_at)}|${String(last.correction_id)}`:null;
  await flex(env,event,buildOwnerCorrectionManualReviewList(shown,next),traceId);
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
  if(text==="รายการแก้ไขรอตรวจ"){
    if(!owner){await reply(env,event,"เมนูนี้สำหรับเจ้าของที่ยืนยันตัวตนแล้ว",traceId);return true;}
    const active=await loadOwnerCorrectionInput(env,owner);if(active)await clearOwnerCorrectionInput(env,owner,String(active.input_id));
    await manualReviews(env,event,owner,traceId);return true;
  }
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
export async function handleOwnerCorrectionPostback(env:Env,event:LineEvent,traceId:string,ports:OwnerCorrectionPostbackPorts=postbackDefaults):Promise<boolean>{
  if(env.OWNER_EXPENSE_CORRECTION_ENABLED!=="true")return false;
  const q=new URLSearchParams(event.postback?.data||""),action=q.get("a")||"";if(!action.startsWith("owner_correction_"))return false;
  const owner=await identity(env,event);if(!owner){await reply(env,event,"เมนูนี้สำหรับเจ้าของที่ยืนยันตัวตนแล้ว",traceId);return true;}
  if(action==="owner_correction_next"){
    const session=await loadOwnerCorrectionInput(env,owner),query=String(session?.search_query||"");
    if(!query){await reply(env,event,"การค้นหาหมดอายุ กรุณาพิมพ์ แก้ไขค่าใช้จ่าย",traceId);return true;}
    await results(env,event,owner,query,traceId,q.get("cursor")||"");return true;
  }
  if(action==="owner_correction_manual_next"){await manualReviews(env,event,owner,traceId,q.get("cursor")||"");return true;}
  const id=q.get("id")||"";
  if(action==="owner_correction_review_retry"){
    const draft=await retryOwnerCorrectionManualReview(env,owner,id);
    if(!draft){await reply(env,event,"ข้อมูลเปลี่ยนแล้วหรือยังตรวจต่อไม่ได้ กรุณาค้นหาและตรวจรายการล่าสุด",traceId);return true;}
    await preview(env,event,draft,owner,traceId);return true;
  }
  if(action==="owner_correction_status"){
    const status=await ownerCorrectionStatus(env,owner,id),messages={DRAFT:"ร่างนี้ยังไม่ได้ยืนยัน รายการเดิมยังไม่เปลี่ยน",EXPIRED:"ร่างหมดอายุ กรุณาเปิดรายการใหม่",CANCELLED:"ยกเลิกร่างแล้ว รายการเดิมยังไม่เปลี่ยน",STALE:"ข้อมูลเปลี่ยนแล้ว กรุณาเปิดรายการใหม่",MANUAL_REVIEW:"รายการแก้ไขรอตรวจเพิ่มเติม ข้อมูลเดิมยังไม่เปลี่ยน",DRAFT_EDITED:"บันทึกการแก้ไขในร่างแล้ว โปรดตรวจสถานะและยืนยันรายการต้นฉบับ",SYNC_PENDING:"บันทึกแล้ว กำลังซิงก์และตรวจข้อมูลที่เกี่ยวข้อง",SYNC_FAILED:"บันทึกแล้ว แต่การซิงก์ยังไม่สำเร็จ ระบบต้องตรวจและลองต่อ",SYNC_REVIEW:"บันทึกแล้ว แต่ข้อมูลชีตต้องตรวจเพิ่มเติมก่อนซิงก์ กรุณาติดต่อผู้ดูแล",COMPLETED:"ซิงก์และตรวจข้อมูลที่เกี่ยวข้องเรียบร้อยแล้ว"} as const;
    if(status==="MANUAL_REVIEW"||status==="STALE"){const review=await getOwnerCorrectionManualReview(env,owner,id);if(review){await flex(env,event,buildOwnerCorrectionManualReview(id,review.reason_code,status==="STALE"),traceId);return true;}}
    await reply(env,event,status?messages[status]:"ไม่พบรายการหรือไม่มีสิทธิ์ตรวจสถานะ",traceId);return true;
  }
  if(action==="owner_correction_cancel"){
    const cancelled=await cancelOwnerCorrectionDraft(env,owner,id);await reply(env,event,cancelled?"ยกเลิกร่างแล้ว รายการเดิมยังไม่เปลี่ยน":"ร่างหมดอายุหรือได้รับการจัดการแล้ว",traceId);return true;
  }
  if(action==="owner_correction_period_ask"||action==="owner_correction_period_set"){
    try{
      const existing=await getOwnerCorrectionManualReview(env,owner,id);if(existing){const status=await ownerCorrectionStatus(env,owner,id);await flex(env,event,buildOwnerCorrectionManualReview(id,existing.reason_code,status==="STALE"),traceId);return true;}
      const v=Number(q.get("v")),p=q.get("p")||"",h=q.get("h")||"",view=await ports.periods(env,owner,id);
      if(!view||view.version!==v||view.headerDigest!==h||!view.periods.some(item=>item.period===p)){await reply(env,event,"ข้อมูลเปลี่ยนหรือร่างหมดอายุ กรุณาเปิดรายการใหม่",traceId);return true;}
      if(action==="owner_correction_period_ask"){
        if(view.periods.find(item=>item.period===p)?.decision==="HOLD"){await flex(env,event,buildOwnerCorrectionPeriods(view,id),traceId);return true;}
        await flex(env,event,buildOwnerCorrectionPeriodQuestion(view,id,p),traceId);return true;
      }
      const decision=q.get("s");if(decision!=="OPEN"&&decision!=="HOLD"){await reply(env,event,"สถานะไม่ถูกต้อง กรุณาเปิดรายการใหม่",traceId);return true;}
      const result=await ports.decision(env,owner,id,{period:p,headerDigest:h,version:v,decision});
      if(result==="STALE"||result==="CONFLICT"){await reply(env,event,"ข้อมูลเปลี่ยนหรือเคยตอบแล้ว กรุณาตรวจรายการล่าสุด",traceId);return true;}
      if(decision==="HOLD"){await hold(env,event,owner,id,"PERIOD_UNCONFIRMED",traceId);return true;}
      const updated=await ports.periods(env,owner,id);if(!updated){await reply(env,event,"ข้อมูลเปลี่ยนแล้ว กรุณาเปิดรายการใหม่",traceId);return true;}
      await flex(env,event,buildOwnerCorrectionPeriods(updated,id),traceId);return true;
    }catch{await reply(env,event,"ตรวจสถานะเดือนบัญชีไม่ได้ รายการเดิมยังไม่เปลี่ยน กรุณาลองใหม่",traceId);return true;}
  }
  if(action==="owner_correction_execute"){
    if(!ports.confirmed){await reply(env,event,"ยังบันทึกการแก้ไขไม่ได้ รายการเดิมยังไม่เปลี่ยน",traceId);return true;}
    try{
      const result=await ports.confirmed(env,owner,id,Number(q.get("v")),traceId);
      if(result==="APPLIED"){
        const current=await ownerCorrectionStatus(env,owner,id);
        if(current==="COMPLETED")await reply(env,event,"ซิงก์และตรวจข้อมูลที่เกี่ยวข้องเรียบร้อยแล้ว",traceId);
        else if(current==="SYNC_REVIEW"||current==="SYNC_FAILED")await reply(env,event,"บันทึกแล้ว แต่การซิงก์ต้องตรวจเพิ่มเติม กรุณาติดต่อผู้ดูแล",traceId);
        else await flex(env,event,buildOwnerCorrectionSyncPending(id),traceId);
        return true;
      }
      if(result==="DUPLICATE"||result==="ALLOCATION"||result==="SHEET_REVIEW"||result==="MOVE_REVIEW"||result==="UNSUPPORTED"){
        const draft=await loadOwnerCorrectionDraft(env,owner,id);let reason:ManualCorrectionReason=result==="DUPLICATE"?"REPORT_DUPLICATE":result==="ALLOCATION"?"RECEIPT_ALLOCATION":result==="MOVE_REVIEW"?"CROSS_MONTH":"SHEET_CHECK";
        if(result==="UNSUPPORTED"&&draft){try{const before=JSON.parse(String(draft.before_json)) as OwnerCorrectionSnapshot,after=JSON.parse(String(draft.after_json)) as OwnerCorrectionSnapshot;if(before.transactionDate.slice(0,7)!==after.transactionDate.slice(0,7))reason="CROSS_MONTH";else{await reply(env,event,"ระบบซิงก์ยังไม่พร้อม รายการเดิมยังไม่เปลี่ยน กรุณาติดต่อผู้ดูแล",traceId);return true;}}catch{await reply(env,event,"ข้อมูลร่างไม่พร้อม กรุณาเริ่มใหม่",traceId);return true;}}
        await hold(env,event,owner,id,reason,traceId);return true;
      }
      const messages={STALE:"ข้อมูลเปลี่ยนหรือร่างหมดอายุ กรุณาค้นหาและตรวจรายการใหม่",PERIOD_REVIEW:"เดือนบัญชียังยืนยันไม่ครบหรือเลือกรอตรวจ รายการเดิมยังไม่เปลี่ยน",PROTECTION:"สิทธิ์แก้ไขชีตยังไม่พร้อม รายการเดิมยังไม่เปลี่ยน กรุณาติดต่อผู้ดูแล",DUPLICATE:"พบความเสี่ยงรายการซ้ำหรือข้อมูลรายงานไม่พร้อม กรุณาตรวจเพิ่ม รายการเดิมยังไม่เปลี่ยน",ALLOCATION:"ใบเสร็จมีหลายรายการ ต้องตรวจการแบ่งยอดก่อน รายการเดิมยังไม่เปลี่ยน",SHEET_REVIEW:"ยังตรวจแถวหรือรายงานเดือนได้ไม่ครบ กรุณาตรวจรายงานและติดต่อผู้ดูแล",METADATA_PENDING:"กำลังตรวจตำแหน่งแถวในชีต รายการเดิมยังไม่เปลี่ยน กรุณากดยืนยันอีกครั้งในครู่ค่ะ",GUARD_PENDING:"กำลังตรวจการป้องกันเซลล์ในชีต รายการเดิมยังไม่เปลี่ยน กรุณากดยืนยันอีกครั้งในครู่ค่ะ",REPORT_PENDING:"กำลังเตรียมตรวจรายงานของเดือนนี้ รายการเดิมยังไม่เปลี่ยน กรุณากดยืนยันอีกครั้งในครู่ค่ะ",MOVE_REVIEW:"รายการนี้ต้องตรวจแถวต้นทางและปลายทางก่อนย้ายเดือน",UNSUPPORTED:"รายการนี้ต้องตรวจข้อมูลเพิ่มเติมก่อนแก้ไข รายการเดิมยังไม่เปลี่ยน"} as const;
      await reply(env,event,messages[result],traceId);return true;
    }catch{await reply(env,event,"ยังตรวจหรือบันทึกการแก้ไขไม่ได้ กรุณาตรวจสถานะก่อนลองใหม่",traceId);return true;}
  }
  if(action==="owner_correction_confirm"){
    const draft=await loadOwnerCorrectionDraft(env,owner,id);let status="";
    if(!draft){
      const prior=await ownerCorrectionStatus(env,owner,id);
      if(prior==="MANUAL_REVIEW"||prior==="STALE"){const review=await getOwnerCorrectionManualReview(env,owner,id);if(review){await flex(env,event,buildOwnerCorrectionManualReview(id,review.reason_code,prior==="STALE"),traceId);return true;}}
      await reply(env,event,prior==="DRAFT_EDITED"?"บันทึกการแก้ไขในร่างนี้แล้ว โปรดตรวจสถานะและยืนยันรายการต้นฉบับ":"ร่างหมดอายุ ได้รับการจัดการแล้ว หรือไม่พบรายการ กรุณาค้นหาใหม่",traceId);return true;
    }
    try{status=String(JSON.parse(String(draft?.before_json||"{}")).status||"");}catch{/* malformed snapshots cannot be applied */}
    if(status==="WAITING_CONFIRM"){
      const result=await commitPendingOwnerCorrection(env,owner,id,Number(q.get("v")));
      await reply(env,event,result==="APPLIED"?"บันทึกการแก้ไขในร่างแล้ว รายการยังไม่ลงบัญชี กรุณาตรวจและยืนยันรายละเอียด หมวดหมู่ และช่องทางชำระในรายการต้นฉบับ":result==="REVIEW"?"ยอดหรือวันที่ของคำสั่งซื้อนี้ต้องตรวจหลักฐานและยืนยันใหม่ก่อนแก้ไข รายการเดิมยังไม่เปลี่ยน":"ร่างหมดอายุหรือข้อมูลเปลี่ยนแล้ว กรุณาค้นหาและเปิดรายการใหม่",traceId);return true;
    }
    if(status==="CONFIRMED"){
      try{
        const view=await ports.periods(env,owner,id);
        if(!view||view.version!==Number(q.get("v"))){await reply(env,event,"ข้อมูลเปลี่ยนหรือร่างหมดอายุ กรุณาเปิดรายการใหม่",traceId);return true;}
        if(view.periods.some(item=>item.decision!=="OPEN")){await flex(env,event,buildOwnerCorrectionPeriods(view,id),traceId);return true;}
        const before=JSON.parse(String(draft.before_json)) as OwnerCorrectionSnapshot,after=JSON.parse(String(draft.after_json)) as OwnerCorrectionSnapshot;
        await flex(env,event,buildOwnerCorrectionFinalPreview({before,after,field:String(draft.field) as OwnerCorrectionField},id),traceId);return true;
      }catch{await reply(env,event,"ตรวจสถานะเดือนบัญชีไม่ได้ รายการเดิมยังไม่เปลี่ยน กรุณาลองใหม่",traceId);return true;}
    }
    // Keep confirmed changes disabled until the verified Sheets outbox is connected.
    await reply(env,event,"ยังบันทึกการแก้ไขไม่ได้ รายการเดิมยังไม่เปลี่ยน กรุณาติดต่อผู้ดูแล",traceId);return true;
  }
  const snapshot=await loadOwnerExpense(env,owner,id);if(!snapshot){await reply(env,event,"ไม่พบรายการ กรุณาค้นหาใหม่",traceId);return true;}
  if(action==="owner_correction_open"){
    const session=await loadOwnerCorrectionInput(env,owner);if(session?.mode==="SEARCH")await clearOwnerCorrectionInput(env,owner,String(session.input_id));
    await flex(env,event,buildOwnerCorrectionFields(snapshot),traceId);return true;
  }
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
