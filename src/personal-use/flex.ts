export interface PersonalUseFlexRecord{
  personalUseId:string;transactionType:"PERSONAL_USE"|"PERSONAL_RETURN";description:string;amountSatang:number;sourceWallet:string;transactionDate:string;status:string;
}
type FlexMessage={type:"flex";altText:string;contents:Record<string,unknown>};
const money=(satang:number)=>new Intl.NumberFormat("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2}).format(satang/100);
const label=(type:string)=>type==="PERSONAL_RETURN"?"คืนเงินส่วนตัวเข้าร้าน":"ถอนใช้ส่วนตัว";
const wallet=(source:string)=>source==="SHOP_BANK"?"บัญชีร้าน":"เงินสดหน้าร้าน";
const row=(name:string,value:string)=>({type:"box",layout:"baseline",margin:"md",contents:[{type:"text",text:name,size:"sm",color:"#777777",flex:3},{type:"text",text:value,size:"sm",wrap:true,flex:5}]});
const action=(name:string,data:string,style="secondary",color?:string)=>({type:"button",style,height:"sm",...(color?{color}:{}),action:{type:"postback",label:name,data,displayText:name}});

export function buildPersonalUseConfirmFlex(record:PersonalUseFlexRecord):FlexMessage{
  const id=encodeURIComponent(record.personalUseId);
  return{type:"flex",altText:`ยืนยัน${label(record.transactionType)} ${money(record.amountSatang)} บาท`,contents:{type:"bubble",header:{type:"box",layout:"vertical",backgroundColor:"#FFF3E0",contents:[{type:"text",text:`ยืนยัน${label(record.transactionType)}`,weight:"bold",size:"xl",color:"#6D4C41",wrap:true}]},body:{type:"box",layout:"vertical",contents:[row("จำนวน",`${money(record.amountSatang)} บาท`),row("จาก/เข้า",wallet(record.sourceWallet)),row("รายละเอียด",record.description),row("วันที่",record.transactionDate),{type:"text",text:"รายการนี้จะเปลี่ยนเงินคงเหลือร้าน แต่ไม่ถูกนับเป็นค่าใช้จ่ายหรือกำไรขาดทุน",size:"xs",color:"#8D6E63",wrap:true,margin:"lg"}]},footer:{type:"box",layout:"vertical",spacing:"sm",contents:[action("✅ ยืนยัน",`a=personal_use_confirm&id=${id}`,"primary","#795548"),action("❌ ยกเลิก",`a=personal_use_cancel&id=${id}`)]}}};
}
export function buildPersonalUseSavedFlex(record:PersonalUseFlexRecord):FlexMessage{
  const id=encodeURIComponent(record.personalUseId);
  return{type:"flex",altText:`บันทึก${label(record.transactionType)}แล้ว`,contents:{type:"bubble",header:{type:"box",layout:"vertical",backgroundColor:"#E8F5E9",contents:[{type:"text",text:"บันทึกแล้ว ✅",weight:"bold",size:"xl",color:"#2E7D32"}]},body:{type:"box",layout:"vertical",contents:[row("ประเภท",label(record.transactionType)),row("จำนวน",`${money(record.amountSatang)} บาท`),row("บัญชี",wallet(record.sourceWallet)),row("รายละเอียด",record.description),row("วันที่",record.transactionDate)]},footer:{type:"box",layout:"vertical",contents:[action("↩️ ยกเลิกรายการ",`a=personal_use_undo&id=${id}`)]}}};
}
