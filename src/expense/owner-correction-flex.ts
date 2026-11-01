import type {OwnerCorrectionDraft,OwnerCorrectionSnapshot} from "./owner-correction";
import {expensePaymentOptions} from "./document";

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
