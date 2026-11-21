import { acceptedOrderTotalLabel,acceptedPaymentDateLabel,toSatang } from "./document";
import { isIsoDate } from "../shared/time";
import type { PurchaseDocument,PurchaseVisionAttempt } from "../types";

export type OwnerReviewField="amount"|"date"|"paymentStatus";
export type ReviewReason=
  |"AMOUNT_MISSING"|"AMOUNT_CONFLICT"|"PAYMENT_UNVERIFIED"|"PAYMENT_PENDING"|"PAYMENT_UNPAID"|"PAYMENT_DATE_MISSING"
  |"ORDER_ID_MISSING"|"EVIDENCE_INCOMPLETE"|"MULTIPLE_SELLERS"|"ORDER_ALREADY_OWNED"|"ORDER_IDENTITY_CONFLICT"|"POSSIBLE_DUPLICATE";
export interface OwnerFact<T>{value:T;source:"OWNER";actorEmployeeId:string;confirmedAt:string;}
export interface OwnerOrderFacts{
  amount?:OwnerFact<number>;
  date?:OwnerFact<string>;
  paymentStatus?:OwnerFact<"PAID"|"UNPAID">;
}
export interface ResolvedOrderFacts{
  amountSatang:number|null;paymentDate:string;paymentStatus:string;
  sources:{amount:"IMAGE"|"OWNER"|"MISSING";date:"IMAGE"|"OWNER"|"MISSING";paymentStatus:"IMAGE"|"OWNER"|"MISSING"};
  missing:OwnerReviewField[];reasons:ReviewReason[];
}
export interface OrderReviewView extends ResolvedOrderFacts{
  documentId:string;version:number;vendor:string;description:string;createdAt:string;
  blocked:ReviewReason[];phase:"HELD"|"DRAFTED";expenseId:string|null;reviewerOwnsDraft:boolean;
}
export const reviewReasonLabels:Record<ReviewReason,string>={
  AMOUNT_MISSING:"ยังอ่านยอดชำระไม่ได้",AMOUNT_CONFLICT:"ยอดจากภาพขัดกัน ต้องตรวจยอดจริง",
  PAYMENT_UNVERIFIED:"ยังไม่ยืนยันว่าชำระแล้ว",PAYMENT_PENDING:"การชำระเงินยังดำเนินการอยู่",PAYMENT_UNPAID:"ยังไม่ได้ชำระเงิน",
  PAYMENT_DATE_MISSING:"ยังไม่ยืนยันวันที่ชำระเงินจริง",ORDER_ID_MISSING:"ไม่พบเลขคำสั่งซื้อ ต้องตรวจหลักฐานเพิ่มเติม",
  EVIDENCE_INCOMPLETE:"รายละเอียดหลักฐานไม่ครบ ต้องตรวจภาพเพิ่มเติม",MULTIPLE_SELLERS:"หลายร้านค้า ต้องตรวจการแบ่งยอดแยกก่อน",
  ORDER_ALREADY_OWNED:"คำสั่งซื้อนี้มีค่าใช้จ่ายเดิมแล้ว",ORDER_IDENTITY_CONFLICT:"ข้อมูลคำสั่งซื้อเดิมไม่สอดคล้อง ต้องตรวจแยก",
  POSSIBLE_DUPLICATE:"พบรายการยอดและวันเดียวกัน ต้องตรวจรายการเดิมก่อน"
};

export function parseOwnerFacts(value:unknown):OwnerOrderFacts{
  let obj:Record<string,unknown>={};
  try{const v=typeof value==="string"?JSON.parse(value):value;if(v&&typeof v==="object"&&!Array.isArray(v))obj=v;}catch{return{};}
  const facts:OwnerOrderFacts={};
  for(const key of ["amount","date","paymentStatus"] as const){
    const fact=obj[key] as OwnerFact<unknown>|undefined;
    if(!fact||fact.source!=="OWNER"||typeof fact.actorEmployeeId!=="string"||!fact.actorEmployeeId||typeof fact.confirmedAt!=="string")continue;
    if(key==="amount"&&typeof fact.value==="number"&&Number.isSafeInteger(fact.value)&&fact.value>0)facts.amount=fact as OwnerFact<number>;
    if(key==="date"&&typeof fact.value==="string"&&isIsoDate(fact.value))facts.date=fact as OwnerFact<string>;
    if(key==="paymentStatus"&&(fact.value==="PAID"||fact.value==="UNPAID"))facts.paymentStatus=fact as OwnerFact<"PAID"|"UNPAID">;
  }
  return facts;
}
export function retainedOrder(value:unknown):PurchaseDocument|null{
  try{
    const d=typeof value==="string"?JSON.parse(value):value;
    if(!d||d.documentType!=="ONLINE_ORDER"||!Array.isArray(d.items)||typeof d.orderId!=="string")return null;
    if(!["vendor","currency","suggestedDescription","suggestedCategory","paymentDate","paymentTime"].every(k=>typeof d[k]==="string"))return null;
    if(!Array.isArray(d.reviewReasons)||!d.reviewReasons.every((r:unknown)=>typeof r==="string"))return null;
    if(!d.items.every((i:unknown)=>i&&typeof i==="object"&&typeof (i as Record<string,unknown>).description==="string"&&typeof (i as Record<string,unknown>).sellerKey==="string"))return null;
    return d as PurchaseDocument;
  }catch{return null;}
}

export function resolveOrderFacts(document:PurchaseDocument|null,owner:OwnerOrderFacts={}):ResolvedOrderFacts{
  const conflict=Boolean(document?.reviewReasons?.some(r=>r.startsWith("Amount evidence conflicts:")));
  const total=toSatang(document?.orderTotalBaht??null);
  const visibleAmount=!conflict&&Boolean(acceptedOrderTotalLabel(document?.orderTotalLabel))&&total!=null&&total>0?total:null;
  // Legacy snapshots can contain an order-placement date mislabeled PAYMENT.
  // A held case requires printed payment provenance or explicit owner input.
  const provenDate=Boolean(document?.paymentDate&&isIsoDate(document.paymentDate)&&document.paymentDatePurpose==="PAYMENT"&&acceptedPaymentDateLabel(document.paymentDateLabel||""));
  const imageStatus=document?.paymentStatus==="PAID"&&!provenDate?"UNKNOWN":document?.paymentStatus||"UNKNOWN";
  const amountSatang=owner.amount?.value??visibleAmount,paymentDate=owner.date?.value||(provenDate?document!.paymentDate:"");
  const paymentStatus=owner.paymentStatus?.value||imageStatus;
  const missing:OwnerReviewField[]=[],reasons:ReviewReason[]=[];
  if(amountSatang==null){missing.push("amount");reasons.push(conflict?"AMOUNT_CONFLICT":"AMOUNT_MISSING");}
  if(paymentStatus!=="PAID"){
    missing.push("paymentStatus");reasons.push(paymentStatus==="UNPAID"?"PAYMENT_UNPAID":paymentStatus==="PENDING"?"PAYMENT_PENDING":"PAYMENT_UNVERIFIED");
  }
  if(!paymentDate){missing.push("date");reasons.push("PAYMENT_DATE_MISSING");}
  return{amountSatang,paymentDate,paymentStatus,sources:{amount:owner.amount?"OWNER":visibleAmount==null?"MISSING":"IMAGE",date:owner.date?"OWNER":provenDate?"IMAGE":"MISSING",paymentStatus:owner.paymentStatus?"OWNER":imageStatus==="UNKNOWN"?"MISSING":"IMAGE"},missing,reasons};
}

export function parseOwnerAmount(text:string):number|null{
  const value=text.trim().replace(/(?:บาท|THB|฿)\s*$/i,"").trim();
  if(!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value))return null;
  const amount=Number(value.replaceAll(",","")),satang=Math.round(amount*100);
  return Number.isSafeInteger(satang)&&satang>0?satang:null;
}
export function parseOwnerDate(text:string):string{
  const value=text.trim();if(isIsoDate(value))return value;
  const m=/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(value);if(!m)return"";
  let y=Number(m[3]);
  // Thai conversational years such as 69 mean 2569. The resolved four-digit
  // date is displayed again before the owner can create a draft.
  if(m[3]!.length===2)y=y>=50?2500+y-543:2000+y;else if(y>=2400)y-=543;
  const iso=`${String(y).padStart(4,"0")}-${m[2]!.padStart(2,"0")}-${m[1]!.padStart(2,"0")}`;
  return y>=1900&&y<=2200&&isIsoDate(iso)?iso:"";
}
export function displayOwnerDate(iso:string):string{
  const [y,m,d]=iso.split("-");return y&&m&&d?`${d}/${m}/${Number(y)+543}`:"ยังไม่ยืนยัน";
}

export function parseAttempts(value:unknown):PurchaseVisionAttempt[]{
  try{const v=typeof value==="string"?JSON.parse(value):value;return Array.isArray(v)?v.filter(a=>a&&typeof a==="object"&&typeof a.rawPaymentStatus==="string"&&typeof a.model==="string"):[];}catch{return[];}
}
