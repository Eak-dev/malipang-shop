import { displayOwnerDate,reviewReasonLabels,type OrderReviewView,type ReviewReason } from "./online-order-review";
import { isoDateInBangkok } from "../shared/time";

const brown="#795548";
const text=(value:string,bold=false)=>({type:"text",text:value,wrap:true,size:"sm",...(bold?{weight:"bold"}:{})});
const button=(label:string,data:string,primary=false)=>({type:"button",height:"sm",style:primary?"primary":"secondary",...(primary?{color:brown}:{}),action:{type:"postback",label,data,displayText:label}});
const money=(value:number|null)=>value==null?"ยังไม่ยืนยัน":`${(value/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})} บาท`;
const source=(value:string)=>value==="OWNER"?"เจ้าของยืนยัน":value==="IMAGE"?"อ่านจากภาพ":"ยังไม่มีข้อมูลยืนยัน";
const flex=(altText:string,body:unknown[],footer:unknown[])=>({type:"flex",altText,contents:{type:"bubble",body:{type:"box",layout:"vertical",spacing:"md",contents:body},...(footer.length?{footer:{type:"box",layout:"vertical",spacing:"sm",contents:footer}}:{})}});

export function buildOnlineOrderReviewFlex(view:OrderReviewView){
  const id=encodeURIComponent(view.documentId),q=`id=${id}&v=${view.version}`;
  const body:unknown[]=[text("ตรวจหลักฐานคำสั่งซื้อ 🧾",true),text(view.description||view.vendor||"คำสั่งซื้อออนไลน์"),
    text(`ยอด: ${money(view.amountSatang)} (${source(view.sources.amount)})`),
    text(`วันที่ชำระ: ${displayOwnerDate(view.paymentDate)} (${source(view.sources.date)})`),
    text(`สถานะ: ${view.paymentStatus==="PAID"?"ชำระแล้ว":view.paymentStatus==="UNPAID"?"ยังไม่ชำระ":"ยังไม่ยืนยันการชำระ"} (${source(view.sources.paymentStatus)})`),
    text("หลักฐานจากภาพเดิมยังถูกเก็บไว้ คำยืนยันของเจ้าของแยกต่างหาก")];
  const footer:unknown[]=[];
  if(view.phase==="DRAFTED")body.push(text("ตรวจหลักฐานแล้ว รายการอยู่ในขั้นยืนยันค่าใช้จ่าย"));
  else if(view.blocked.length)for(const reason of view.blocked)body.push(text(reviewReasonLabels[reason]));
  else{
    if(view.missing.length)body.push(text("กรุณาเติมเฉพาะข้อมูลที่ยังขาด"));
    if(view.missing.includes("paymentStatus")){
      footer.push(button("ชำระเงินจริงแล้ว",`a=order_review_paid&${q}&paid=yes`,true));
      if(view.paymentStatus!=="UNPAID")footer.push(button("ยังไม่ได้ชำระ",`a=order_review_paid&${q}&paid=no`));
    }
    if(view.missing.includes("date"))footer.push({type:"button",height:"sm",style:"secondary",action:{type:"datetimepicker",label:"เลือกวันชำระจริง",data:`a=order_review_date&${q}`,mode:"date",max:isoDateInBangkok()}});
    if(view.missing.includes("amount"))footer.push(button("ระบุยอดชำระจริง",`a=order_review_input&${q}&field=amount`));
    if(!view.missing.length){
      body.push(text("ตรวจยอด วันชำระ และสถานะด้านบนก่อนดำเนินการต่อ จากนั้นยังต้องยืนยันรายการ หมวดหมู่ และแหล่งเงิน"));
      footer.push(button("ตรวจแล้ว ทำต่อ",`a=order_review_continue&${q}`,true));
    }
    footer.push(button("แก้ข้อมูล / พิมพ์วัน",`a=order_review_edit&${q}`));
  }
  footer.push(button("กลับรายการค้าง","a=order_review_list"));
  return flex("ตรวจข้อมูลคำสั่งซื้อที่ยังไม่ครบ",body,footer);
}
export function buildOnlineOrderEditFlex(view:OrderReviewView){
  const q=`id=${encodeURIComponent(view.documentId)}&v=${view.version}`;
  return flex("เลือกข้อมูลคำสั่งซื้อที่ต้องแก้",[text("เลือกข้อมูลที่ต้องแก้",true),text("คำยืนยันเดิมและหลักฐานภาพยังอยู่ในประวัติ")],[
    button("แก้ยอดชำระ",`a=order_review_input&${q}&field=amount`),
    button("พิมพ์วันที่ชำระ",`a=order_review_input&${q}&field=date`),
    button(view.paymentStatus==="PAID"?"เปลี่ยนเป็นยังไม่ชำระ":"ยืนยันว่าชำระแล้ว",`a=order_review_paid&${q}&paid=${view.paymentStatus==="PAID"?"no":"yes"}`),
    button("กลับหน้าตรวจ",`a=order_review_open&id=${encodeURIComponent(view.documentId)}`)
  ]);
}
export interface ReviewQueueSummary{total:number;actionable:number;blocked:number;oldestAgeHours:number;reasons:Partial<Record<ReviewReason,number>>;}
export function buildOnlineOrderQueueFlex(views:OrderReviewView[],summary:ReviewQueueSummary,nextCursor:string|null){
  const body:unknown[]=[text(`คำสั่งซื้อรอตรวจ ${summary.total} รายการ`,true),text(`เติมข้อมูลได้ ${summary.actionable} • ต้องตรวจแยก ${summary.blocked}`),text(`ค้างนานสุด ${summary.oldestAgeHours} ชั่วโมง`)];
  for(const [reason,count] of Object.entries(summary.reasons))body.push(text(`${reviewReasonLabels[reason as ReviewReason]}: ${count}`));
  for(const view of views){
    body.push({type:"separator"},text(`${view.description||view.vendor||"คำสั่งซื้อออนไลน์"} • ${money(view.amountSatang)}`),
      button(view.blocked.length?"ดูเหตุผลที่ค้าง":"ตรวจและเติมข้อมูล",`a=order_review_open&id=${encodeURIComponent(view.documentId)}`));
  }
  if(!summary.total)body.push(text("ไม่มีคำสั่งซื้อค้างตรวจ"));
  return flex("รายการคำสั่งซื้อที่รอตรวจ",body,nextCursor?[button("รายการถัดไป",`a=order_review_list&after=${encodeURIComponent(nextCursor)}`)]:[]);
}
