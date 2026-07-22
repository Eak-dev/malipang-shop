export interface ExpenseFlexRecord {
  expenseId: string;
  description: string;
  amountSatang: number;
  paymentKey: string;
  sourceWallet: string;
  category: string;
  transactionDate: string;
  status: string;
}

type FlexMessage = { type: "flex"; altText: string; contents: Record<string, unknown> };

const brown="#6D4C41",brownButton="#795548",green="#00C853";
const paymentLabels:Record<string,string>={
  cash:"เงินสด / Cash",transfer:"โอน / Transfer",kbank:"บัตร KBank / KBank",
  firstchoice:"บัตร First Choice",aeon:"บัตร AEON",citibank:"บัตร Citibank",
  ttb:"บัตร TTB",homepro:"บัตร HomePro",t1:"บัตร The 1"
};
const walletLabels:Record<string,string>={
  CASH_DRAWER:"เงินทอนหน้าร้าน / Cash drawer",SHOP_BANK:"บัญชีร้าน / Shop bank",
  CARD_KBANK:"บัตร KBank",CARD_FIRST_CHOICE:"บัตร First Choice",CARD_AEON:"บัตร AEON",
  CARD_CITIBANK:"บัตร Citibank",CARD_TTB:"บัตร TTB",CARD_HOMEPRO:"บัตร HomePro",CARD_THE1:"บัตร The 1",
  ACCUMULATED_PROFIT:"กำไรสะสม / Profit",OTHER:"อื่น ๆ / Other"
};
const categoryLabels:Record<string,string>={
  ingredients:"วัตถุดิบ / Ingredients",fillings:"ไส้ขนม / Fillings",packaging:"บรรจุภัณฑ์ / Packaging",
  gas:"ค่าแก๊ส / Gas",utilities:"ค่าสาธารณูปโภค / Utilities",rent:"ค่าเช่า / Rent",
  staff:"ค่าแรง / Staff",transport:"ขนส่ง / Transport",marketing:"การตลาด / Marketing",
  equipment:"อุปกรณ์ / Equipment",cleaning:"ทำความสะอาด / Cleaning",bank_fee:"ค่าธรรมเนียม / Bank fee",
  general:"ทั่วไป / General"
};
const cardWalletByPayment:Record<string,string>={
  kbank:"CARD_KBANK",firstchoice:"CARD_FIRST_CHOICE",aeon:"CARD_AEON",citibank:"CARD_CITIBANK",
  ttb:"CARD_TTB",homepro:"CARD_HOMEPRO",t1:"CARD_THE1"
};

const action=(label:string,data:string,style="secondary",color?:string)=>({
  type:"button",style,height:"sm",...(color?{color}:{}),
  action:{type:"postback",label,data,displayText:label}
});
const title=(thai:string,english:string,color=brown)=>[
  {type:"text",text:thai,weight:"bold",size:"xl",color},
  {type:"text",text:english,size:"sm",color:"#777777",margin:"xs"}
];
const row=(label:string,value:string)=>({type:"box",layout:"baseline",margin:"md",contents:[
  {type:"text",text:label,size:"sm",color:"#666666",flex:4,wrap:true},
  {type:"text",text:value,size:"sm",color:"#111111",flex:6,wrap:true}
]});
const money=(satang:number)=>(satang/100).toLocaleString("th-TH",{minimumFractionDigits:2,maximumFractionDigits:2});
const displayDate=(iso:string)=>{const [y,m,d]=iso.split("-");return y&&m&&d?`${d}/${m}/${y}`:iso;};
export const paymentWallet=(paymentKey:string):string=>paymentKey==="cash"?"CASH_DRAWER":paymentKey==="transfer"?"SHOP_BANK":cardWalletByPayment[paymentKey]||"SHOP_BANK";
export const paymentForWallet=(wallet:string,current="cash"):string=>{
  if(wallet==="CASH_DRAWER")return"cash";if(wallet==="SHOP_BANK")return"transfer";
  const found=Object.entries(cardWalletByPayment).find(([,value])=>value===wallet);return found?.[0]||current;
};

export function buildExpenseSummaryFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId),body=[...title("ตรวจสอบค่าใช้จ่าย 🧾","Review expense"),
    {type:"separator",margin:"md"},row("รายการ / Item",expense.description),row("จำนวน / Amount",`${money(expense.amountSatang)} บาท`),
    row("หมวด / Category",categoryLabels[expense.category]||expense.category),row("วิธีจ่าย / Payment",paymentLabels[expense.paymentKey]||expense.paymentKey),
    row("เงินออกจาก / Paid from",walletLabels[expense.sourceWallet]||expense.sourceWallet),row("วันที่ / Date",displayDate(expense.transactionDate))];
  return{type:"flex",altText:`ตรวจสอบค่าใช้จ่าย ${expense.description} ${money(expense.amountSatang)} บาท`,contents:{
    type:"bubble",size:"mega",header:{type:"box",layout:"vertical",backgroundColor:"#FFF3E0",contents:title("มะลิปัง • ค่าใช้จ่าย","MaliPang Expense")},
    body:{type:"box",layout:"vertical",contents:body},footer:{type:"box",layout:"vertical",spacing:"sm",contents:[
      action("✅ บันทึก • Save",`a=expense_confirm&id=${id}`,"primary",green),
      action("💳 วิธีจ่าย • Pay",`a=expense_payment_menu&id=${id}`),
      action("🧺 เงินออก • Source",`a=expense_source_menu&id=${id}`),
      action("🏷️ หมวด • Category",`a=expense_category_menu&id=${id}`),
      action("📅 วันที่ • Date",`a=expense_date_menu&id=${id}`),
      action("❌ ยกเลิก • Cancel",`a=expense_cancel&id=${id}`)
    ]}}
  };
}

export function buildExpensePaymentFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId),keys=["cash","transfer","kbank","firstchoice","aeon","citibank","ttb","homepro","t1"];
  return menu("เลือกวิธีชำระ","Choose payment",keys.map(key=>action(`${key===expense.paymentKey?"✅ ":""}${shortPayment(key)}`,`a=expense_set_payment&id=${id}&payment=${key}`,key===expense.paymentKey?"primary":"secondary",key===expense.paymentKey?brownButton:undefined)),id);
}
export function buildExpenseSourceFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId),sources:Array<[string,string]>=[
    ["CASH_DRAWER","💵 เงินทอน • Cash"],["SHOP_BANK","🏦 บัญชีร้าน"],["CARD_KBANK","💳 KBank"],
    ["CARD_FIRST_CHOICE","💳 First Choice"],["CARD_AEON","💳 AEON"],["CARD_CITIBANK","💳 Citibank"],
    ["CARD_TTB","💳 TTB"],["CARD_HOMEPRO","💳 HomePro"],["CARD_THE1","💳 The 1"]
  ];
  return menu("เงินออกจากไหนคะ?","Which payment source was used?",sources.map(([key,label])=>action(`${key===expense.sourceWallet?"✅ ":""}${label}`,`a=expense_set_source&id=${id}&source=${key}`,key===expense.sourceWallet?"primary":"secondary",key===expense.sourceWallet?brownButton:undefined)),id);
}
export function buildExpenseCategoryFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId),keys=["ingredients","fillings","packaging","gas","utilities","rent","staff","transport","marketing","equipment","cleaning","bank_fee","general"];
  return menu("เลือกหมวดค่าใช้จ่าย","Choose category",keys.map(key=>action(`${key===expense.category?"✅ ":""}${shortCategory(key)}`,`a=expense_set_category&id=${id}&category=${key}`,key===expense.category?"primary":"secondary",key===expense.category?brownButton:undefined)),id);
}
export function buildExpenseDateFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId);return{type:"flex",altText:"เลือกวันที่ชำระ / Select payment date",contents:{type:"bubble",body:{type:"box",layout:"vertical",spacing:"md",contents:[...title("เลือกวันที่ชำระ","Select payment date"),row("วันที่ปัจจุบัน / Current",displayDate(expense.transactionDate))]},footer:{type:"box",layout:"vertical",spacing:"sm",contents:[
    action("วันนี้ • Today",`a=expense_set_date_rel&id=${id}&days=0`),action("เมื่อวาน • Yesterday",`a=expense_set_date_rel&id=${id}&days=1`),
    {type:"button",style:"primary",color:brownButton,height:"sm",action:{type:"datetimepicker",label:"📅 เลือกวันที่",data:`a=expense_set_date&id=${id}`,mode:"date",initial:expense.transactionDate}},
    action("↩️ กลับ • Back",`a=expense_back&id=${id}`)
  ]}}};
}
export function buildExpenseSavedFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId);return{type:"flex",altText:`บันทึกค่าใช้จ่ายแล้ว ${expense.description} ${money(expense.amountSatang)} บาท`,contents:{type:"bubble",header:{type:"box",layout:"vertical",backgroundColor:"#E8F5E9",contents:title("บันทึกเรียบร้อย ✅","Saved successfully","#2E7D32")},body:{type:"box",layout:"vertical",contents:[
    row("รายการ / Item",expense.description),row("จำนวน / Amount",`${money(expense.amountSatang)} บาท`),row("วิธีจ่าย / Payment",paymentLabels[expense.paymentKey]||expense.paymentKey),row("เงินออกจาก / Paid from",walletLabels[expense.sourceWallet]||expense.sourceWallet),row("หมวด / Category",categoryLabels[expense.category]||expense.category),row("วันที่ / Date",displayDate(expense.transactionDate))
  ]},footer:{type:"box",layout:"vertical",contents:[action("↩️ ยกเลิกย้อนหลัง",`a=expense_undo&id=${id}`)]}}};
}

function menu(thai:string,english:string,buttons:Record<string,unknown>[],id:string):FlexMessage{return{type:"flex",altText:`${thai} / ${english}`,contents:{type:"bubble",size:"mega",body:{type:"box",layout:"vertical",spacing:"md",contents:title(thai,english)},footer:{type:"box",layout:"vertical",spacing:"sm",contents:[...buttons,action("↩️ กลับ • Back",`a=expense_back&id=${id}`)]}}};}
function shortPayment(key:string):string{return({cash:"💵 เงินสด",transfer:"🏦 โอน / QR",kbank:"💳 KBank",firstchoice:"💳 First Choice",aeon:"💳 AEON",citibank:"💳 Citibank",ttb:"💳 TTB",homepro:"💳 HomePro",t1:"💳 The 1"} as Record<string,string>)[key]||key;}
function shortCategory(key:string):string{return({ingredients:"วัตถุดิบ",fillings:"ไส้ขนม",packaging:"บรรจุภัณฑ์",gas:"ค่าแก๊ส",utilities:"สาธารณูปโภค",rent:"ค่าเช่า",staff:"ค่าแรง",transport:"ขนส่ง",marketing:"การตลาด",equipment:"อุปกรณ์",cleaning:"ทำความสะอาด",bank_fee:"ค่าธรรมเนียม",general:"ทั่วไป"} as Record<string,string>)[key]||key;}

export function collectFlexActionLabels(value:unknown):string[]{
  const labels:string[]=[];const walk=(node:unknown)=>{if(!node||typeof node!=="object")return;const obj=node as Record<string,unknown>,actionNode=obj.action as Record<string,unknown>|undefined;if(actionNode?.label!==undefined)labels.push(String(actionNode.label));for(const child of Object.values(obj))Array.isArray(child)?child.forEach(walk):walk(child);};walk(value);return labels;
}
