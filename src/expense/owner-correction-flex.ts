import type {OwnerCorrectionDraft,OwnerCorrectionSnapshot} from "./owner-correction";
import {expensePaymentOptions} from "./document";
import type {CorrectionPeriodView} from "./owner-correction-periods";

const labels:Record<string,string>={ingredients:"วัตถุดิบ",fillings:"ไส้ขนม",packaging:"บรรจุภัณฑ์",gas:"แก๊ส",utilities:"ค่าน้ำ/ค่าไฟ",rent:"ค่าเช่า",staff:"ค่าแรง",transport:"ขนส่ง/รถ",marketing:"การตลาด",equipment:"อุปกรณ์",cleaning:"ทำความสะอาด",bank_fee:"ค่าธรรมเนียมธนาคาร",general:"ทั่วไป"};
const text=(value:string,bold=false)=>({type:"text",text:value,wrap:true,size:"sm",...(bold?{weight:"bold"}:{})});
const button=(label:string,data:string,primary=false)=>({type:"button",height:"sm",style:primary?"primary":"secondary",...(primary?{color:"#795548"}:{}),action:{type:"postback",label,data,displayText:label}});
const flex=(altText:string,body:unknown[],footer:unknown[]=[])=>({type:"flex",altText,contents:{type:"bubble",body:{type:"box",layout:"vertical",spacing:"md",contents:body},...(footer.length?{footer:{type:"box",layout:"vertical",spacing:"sm",contents:footer}}:{})}});
const money=(satang:number)=>`${(satang/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})} บาท`;
const encode=(value:string)=>encodeURIComponent(value);
const payment=(s:OwnerCorrectionSnapshot)=>{const option=expensePaymentOptions.find(item=>item.paymentKey===s.paymentKey&&item.sourceWallet===s.sourceWallet);return option?`${option.label} • ${option.sourceLabel}`:`${s.paymentKey} • ${s.sourceWallet}`;};
const valueFor=(s:OwnerCorrectionSnapshot,field:OwnerCorrectionDraft["field"])=>field==="description"?s.description:field==="category"?(labels[s.category]||s.category):field==="amountSatang"?money(s.amountSatang):field==="transactionDate"?s.transactionDate:payment(s);
const title:Record<OwnerCorrectionDraft["field"],string>={description:"รายละเอียด",category:"หมวด",amountSatang:"ยอดชำระ",transactionDate:"วันที่ชำระ",payment:"ช่องทาง/แหล่งเงิน"};

/** Render a version-bound confirmation; no action here changes data. */
export function buildOwnerCorrectionPreview(draft:OwnerCorrectionDraft,correctionId:string){
  const query=`id=${encode(correctionId)}&v=${draft.before.version}`;
  return flex("ตรวจการแก้ไขค่าใช้จ่าย",[text("ตรวจการแก้ไขก่อนยืนยัน",true),text(draft.before.description),text(`ยอดเดิม ${money(draft.before.amountSatang)} • วันที่ ${draft.before.transactionDate}`),text(`ช่องที่แก้: ${title[draft.field]}`),text(`เดิม: ${valueFor(draft.before,draft.field)}`),text(`ใหม่: ${valueFor(draft.after,draft.field)}`,true),text("หลักฐานเดิมยังคงอยู่ และระบบจะตรวจข้อมูลอีกครั้งก่อนบันทึก")],[button("ยืนยันการแก้ไข",`a=owner_correction_confirm&${query}`,true),button("ยกเลิก",`a=owner_correction_cancel&${query}`)]);
}

export function buildOwnerCorrectionFinalPreview(draft:OwnerCorrectionDraft,correctionId:string){
  const query=`id=${encode(correctionId)}&v=${draft.before.version}`;
  return flex("ยืนยันบันทึกการแก้ไข",[text("ตรวจอีกครั้งก่อนบันทึก",true),text(draft.before.description),text(`ช่องที่แก้: ${title[draft.field]}`),text(`เดิม: ${valueFor(draft.before,draft.field)}`),text(`ใหม่: ${valueFor(draft.after,draft.field)}`,true),text("ระบบจะตรวจสิทธิ์ เดือนบัญชี และข้อมูลอีกครั้งก่อนเริ่มซิงก์")],[button("ยืนยันบันทึก",`a=owner_correction_execute&${query}`,true),button("ยกเลิกร่าง",`a=owner_correction_cancel&${query}`)]);
}

export function buildOwnerCorrectionSyncPending(correctionId:string){
  return flex("บันทึกแล้ว กำลังตรวจการซิงก์",[text("บันทึกการแก้ไขแล้ว",true),text("ระบบกำลังซิงก์ชีตและตรวจรายงาน กรุณาตรวจสถานะก่อนถือว่าเสร็จ")],[button("ตรวจสถานะ",`a=owner_correction_status&id=${encode(correctionId)}`,true)]);
}

/** The owner attests to periods only for the current, unexpired correction. */
export function buildOwnerCorrectionPeriods(view:CorrectionPeriodView,correctionId:string){
  const body:unknown[]=[text("ตรวจเดือนบัญชีก่อนแก้ไข",true),text("กรุณาตรวจแต่ละเดือน หากปิดบัญชีแล้วหรือไม่แน่ใจ ให้พักรายการไว้")];
  for(const item of view.periods){
    body.push(text(`${item.period} • ${item.decision==="OPEN"?"เจ้าของยืนยันยังไม่ปิด":item.decision==="HOLD"?"รอตรวจเพิ่มเติม":"ยังไม่ยืนยัน"}`));
    if(item.decision!=="HOLD")body.push(button(`${item.decision==="OPEN"?"ทบทวน":"ตรวจ"} ${item.period}`,`a=owner_correction_period_ask&id=${encode(correctionId)}&v=${view.version}&p=${encode(item.period)}&h=${view.headerDigest}`));
  }
  return flex("ตรวจเดือนบัญชี",body,[button("ตรวจต่อ",`a=owner_correction_confirm&id=${encode(correctionId)}&v=${view.version}`,true),button("ยกเลิกร่าง",`a=owner_correction_cancel&id=${encode(correctionId)}&v=${view.version}`)]);
}

export function buildOwnerCorrectionPeriodQuestion(view:CorrectionPeriodView,correctionId:string,period:string){
  const common=`id=${encode(correctionId)}&v=${view.version}&p=${encode(period)}&h=${view.headerDigest}`;
  return flex("ยืนยันสถานะเดือนบัญชี",[text(`เดือน ${period} ยังไม่ปิดบัญชีใช่หรือไม่`,true),text("ยืนยันเฉพาะเมื่อได้ตรวจแล้ว หากปิดแล้วหรือไม่แน่ใจ ให้เลือกพักรายการ")],[
    button("ยังไม่ปิด",`a=owner_correction_period_set&${common}&s=OPEN`,true),button("พักรายการไว้",`a=owner_correction_period_set&${common}&s=HOLD`)
  ]);
}

export function buildOwnerCorrectionResults(rows:Record<string,unknown>[],query:string,nextCursor:string|null=null){
  const body:unknown[]=[text("ผลค้นหารายการค่าใช้จ่าย",true),text(`คำค้น: ${query.slice(0,100)}`)];
  for(const row of rows.slice(0,8)){
    const id=String(row.expense_id||""),amount=Number(row.amount_satang||0);if(!id||!Number.isSafeInteger(amount)||amount<=0)continue;
    body.push({type:"separator"},text(`${String(row.description||"")} • ${money(amount)}`),text(`${String(row.transaction_date||"")} • ${labels[String(row.category)]||String(row.category||"")}`),button("ตรวจรายการ",`a=owner_correction_open&id=${encode(id)}`));
  }
  if(rows.length===0)body.push(text("ไม่พบรายการ กรุณาลองค้นด้วยวันที่ ยอด หรือชื่อร้าน"));
  const footer=nextCursor?[button("รายการถัดไป",`a=owner_correction_next&cursor=${encode(nextCursor)}`)]:[];
  return flex("ผลค้นหารายการค่าใช้จ่าย",body,footer);
}

export function buildOwnerCorrectionFields(snapshot:OwnerCorrectionSnapshot){
  const q=`id=${encode(snapshot.expenseId)}&v=${snapshot.version}`;
  return flex("เลือกข้อมูลที่ต้องการแก้",[text("ตรวจรายการก่อนแก้ไข",true),text(snapshot.description),text(`ยอด ${money(snapshot.amountSatang)} • วันที่ ${snapshot.transactionDate}`),text(`หมวด ${labels[snapshot.category]||snapshot.category}`),text(`ช่องทาง ${payment(snapshot)}`),text(snapshot.status==="CONFIRMED"?"บันทึกแล้ว":"รอยืนยัน")],[
    button("แก้หมวด",`a=owner_correction_category&${q}`),button("แก้รายละเอียด",`a=owner_correction_input&${q}&field=description`),button("แก้ยอด",`a=owner_correction_input&${q}&field=amountSatang`),button("แก้วันที่ชำระ",`a=owner_correction_input&${q}&field=transactionDate`),button("แก้ช่องทางชำระ",`a=owner_correction_payment&${q}`)
  ]);
}

/** Split long menus into separate bubbles to respect LINE layout limits. */
export function buildOwnerCorrectionChoices(snapshot:OwnerCorrectionSnapshot,kind:"category"|"payment"){
  const q=`id=${encode(snapshot.expenseId)}&v=${snapshot.version}`;
  const choices=kind==="category"?Object.entries(labels).map(([key,label])=>({label,data:`a=owner_correction_set_category&${q}&category=${encode(key)}`})):
    expensePaymentOptions.map(item=>({label:item.label.replace(/^\S+\s*/,""),data:`a=owner_correction_set_payment&${q}&payment=${encode(item.paymentKey)}&wallet=${encode(item.sourceWallet)}`}));
  const bubbles=[];for(let i=0;i<choices.length;i+=6){const slice=choices.slice(i,i+6);bubbles.push({type:"bubble",body:{type:"box",layout:"vertical",spacing:"sm",contents:[text(kind==="category"?"เลือกหมวดใหม่":"เลือกช่องทางชำระใหม่",true),...slice.map(choice=>button(choice.label,choice.data))]}});}
  return {type:"flex",altText:kind==="category"?"เลือกหมวดใหม่":"เลือกช่องทางชำระใหม่",contents:{type:"carousel",contents:bubbles}};
}
