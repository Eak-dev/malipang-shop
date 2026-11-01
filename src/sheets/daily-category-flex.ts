const labels:Record<string,string>={ingredients:"วัตถุดิบ",fillings:"ไส้ขนม",packaging:"บรรจุภัณฑ์",gas:"แก๊ส",utilities:"ค่าน้ำ/ค่าไฟ",rent:"ค่าเช่า",staff:"ค่าแรง",transport:"ขนส่ง/รถ",marketing:"การตลาด",equipment:"อุปกรณ์",cleaning:"ทำความสะอาด",bank_fee:"ค่าธรรมเนียมธนาคาร",general:"ทั่วไป"};
export interface DailyCategoryReviewView{requestId:string;description:string;amountSatang:number;transactionDate:string;fromCategory:string;toCategory:string;expenseVersion:number;rowNumber:number}
const label=(value:string)=>labels[value]||value;
const text=(value:string,bold=false)=>({type:"text",text:value,wrap:true,size:"sm",...(bold?{weight:"bold"}:{})});
const button=(title:string,data:string,primary=false)=>({type:"button",height:"sm",style:primary?"primary":"secondary",...(primary?{color:"#795548"}:{}),action:{type:"postback",label:title,data,displayText:title}});

/** Only owner-authorized routing may display or act on this card. */
export function buildDailyCategoryReviewFlex(view:DailyCategoryReviewView){
  const q=`id=${encodeURIComponent(view.requestId)}&v=${view.expenseVersion}`;
  const money=(view.amountSatang/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  return {type:"flex",altText:"ตรวจคำขอเปลี่ยนหมวดค่าใช้จ่าย",contents:{type:"bubble",body:{type:"box",layout:"vertical",spacing:"md",contents:[
    text("ตรวจคำขอเปลี่ยนหมวด",true),text(view.description),text(`ยอด ${money} บาท • วันที่ ${view.transactionDate}`),
    text(`หมวดเดิม: ${label(view.fromCategory)}`),text(`หมวดที่ขอ: ${label(view.toCategory)}`,true),
    text(`แถวในชีตขณะสร้างคำขอ: ${view.rowNumber}`),text("อนุมัติแล้วระบบจะอัปเดตหมวดและรายงาน โดยไม่เปลี่ยนยอดเงิน")
  ]},footer:{type:"box",layout:"vertical",spacing:"sm",contents:[button("อนุมัติ",`a=sheet_category_approve&${q}`,true),button("ไม่อนุมัติ",`a=sheet_category_reject&${q}`)]}}};
}

export function buildDailyCategoryQueueFlex(views:DailyCategoryReviewView[],total:number,refreshFailed=false){
  const body:unknown[]=[text(`คำขอเปลี่ยนหมวดรอเจ้าของตรวจ ${total} รายการ`,true)];
  if(refreshFailed)body.push(text("ยังตรวจชีตล่าสุดไม่ได้ รายการด้านล่างเป็นคำขอที่บันทึกไว้แล้ว"));
  for(const view of views){body.push({type:"separator"},text(`${view.description} • ${(view.amountSatang/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})} บาท`),text(`${label(view.fromCategory)} → ${label(view.toCategory)}`),button("ตรวจคำขอ",`a=sheet_category_open&id=${encodeURIComponent(view.requestId)}`));}
  if(!total)body.push(text("ไม่มีคำขอรอตรวจ"));
  if(total>views.length)body.push(text("แสดง 5 รายการแรก กรุณาตรวจรายการเหล่านี้ก่อน"));
  return {type:"flex",altText:"คำขอเปลี่ยนหมวดรอเจ้าของตรวจ",contents:{type:"bubble",body:{type:"box",layout:"vertical",spacing:"md",contents:body}}};
}
