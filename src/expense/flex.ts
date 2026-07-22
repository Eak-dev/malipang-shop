export interface ExpenseFlexRecord {
  expenseId: string;
  description: string;
  amountSatang: number;
  paymentKey: string;
  sourceWallet: string;
  category: string;
  transactionDate: string;
  status: string;
  documentType?: string;
  channel?: string;
  institution?: string;
  referenceId?: string;
  grossAmountSatang?: number | null;
  discountAmountSatang?: number | null;
}

type FlexMessage = { type: "flex"; altText: string; contents: Record<string, unknown> };

const brown="#6D4C41",brownButton="#795548",green="#00C853";
const paymentLabels:Record<string,string>={
  cash:"Cash",transfer:"Bank transfer",kbank:"KBank card",
  firstchoice:"First Choice card",aeon:"AEON card",citibank:"Citibank card",
  ttb:"TTB card",homepro:"HomePro card",t1:"The 1 card"
};
const walletLabels:Record<string,string>={
  CASH_DRAWER:"Cash drawer",SHOP_BANK:"Shop bank account",
  CARD_KBANK:"KBank card",CARD_FIRST_CHOICE:"First Choice card",CARD_AEON:"AEON card",
  CARD_CITIBANK:"Citibank card",CARD_TTB:"TTB card",CARD_HOMEPRO:"HomePro card",CARD_THE1:"The 1 card",
  ACCUMULATED_PROFIT:"Accumulated profit",OTHER:"Other"
};
const categoryLabels:Record<string,string>={
  ingredients:"Ingredients",fillings:"Fillings",packaging:"Packaging",gas:"Gas",utilities:"Utilities",rent:"Rent",
  staff:"Staff",transport:"Transport",marketing:"Marketing",equipment:"Equipment",cleaning:"Cleaning",
  bank_fee:"Bank fee",general:"General"
};
const cardWalletByPayment:Record<string,string>={
  kbank:"CARD_KBANK",firstchoice:"CARD_FIRST_CHOICE",aeon:"CARD_AEON",citibank:"CARD_CITIBANK",
  ttb:"CARD_TTB",homepro:"CARD_HOMEPRO",t1:"CARD_THE1"
};

const action=(label:string,data:string,style="secondary",color?:string)=>({
  type:"button",style,height:"sm",...(color?{color}:{}),
  action:{type:"postback",label,data,displayText:label}
});
const title=(text:string,color=brown)=>[{type:"text",text,weight:"bold",size:"xl",color,wrap:true}];
const row=(label:string,value:string)=>({type:"box",layout:"baseline",margin:"md",contents:[
  {type:"text",text:label,size:"sm",color:"#666666",flex:4,wrap:true},
  {type:"text",text:value,size:"sm",color:"#111111",flex:6,wrap:true}
]});
const money=(satang:number)=>(satang/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
const displayDate=(iso:string)=>{const [y,m,d]=iso.split("-");return y&&m&&d?`${d}/${m}/${y}`:iso;};
const referenceSuffix=(value:string)=>value.length<=8?value:value.slice(-8);
export const paymentWallet=(paymentKey:string):string=>paymentKey==="cash"?"CASH_DRAWER":paymentKey==="transfer"?"SHOP_BANK":cardWalletByPayment[paymentKey]||"SHOP_BANK";
export const paymentForWallet=(wallet:string,current="cash"):string=>{
  if(wallet==="CASH_DRAWER")return"cash";if(wallet==="SHOP_BANK")return"transfer";
  const found=Object.entries(cardWalletByPayment).find(([,value])=>value===wallet);return found?.[0]||current;
};

export function buildExpenseSummaryFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId),body=[...title("Review expense 🧾"),
    {type:"separator",margin:"md"},row("Item",expense.description),row("Amount",`${money(expense.amountSatang)} THB`),
    row("Category",categoryLabels[expense.category]||expense.category),row("Payment",paymentLabels[expense.paymentKey]||expense.paymentKey),
    row("Paid from",walletLabels[expense.sourceWallet]||expense.sourceWallet),row("Date",displayDate(expense.transactionDate))];
  if(expense.documentType==="BANK_SLIP"){
    body.push(row("Document",expense.channel==="G_WALLET"?"G-Wallet receipt":"Bank slip"));
    if(expense.institution)body.push(row("Institution",expense.institution));
    if(expense.grossAmountSatang!=null&&expense.grossAmountSatang!==expense.amountSatang)body.push(row("Original amount",`${money(expense.grossAmountSatang)} THB`));
    if(expense.discountAmountSatang!=null&&expense.discountAmountSatang>0)body.push(row("Discount",`${money(expense.discountAmountSatang)} THB`));
    if(expense.referenceId)body.push(row("Reference",`…${referenceSuffix(expense.referenceId)}`));
  }
  const editActions=expense.documentType==="BANK_SLIP"?[
    action("🏷️ Category",`a=expense_category_menu&id=${id}`),action("📅 Date",`a=expense_date_menu&id=${id}`)
  ]:[
    action("💳 Payment",`a=expense_payment_menu&id=${id}`),action("🧺 Paid from",`a=expense_source_menu&id=${id}`),
    action("🏷️ Category",`a=expense_category_menu&id=${id}`),action("📅 Date",`a=expense_date_menu&id=${id}`)
  ];
  return{type:"flex",altText:`Review expense: ${expense.description} ${money(expense.amountSatang)} THB`,contents:{
    type:"bubble",size:"mega",header:{type:"box",layout:"vertical",backgroundColor:"#FFF3E0",contents:title("MaliPang Expense")},
    body:{type:"box",layout:"vertical",contents:body},footer:{type:"box",layout:"vertical",spacing:"sm",contents:[
      action("✅ Save",`a=expense_confirm&id=${id}`,"primary",green),
      ...editActions,
      action("❌ Cancel",`a=expense_cancel&id=${id}`)
    ]}}
  };
}

export function buildExpensePaymentFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId),keys=["cash","transfer","kbank","firstchoice","aeon","citibank","ttb","homepro","t1"];
  return menu("Choose payment",keys.map(key=>action(`${key===expense.paymentKey?"✅ ":""}${shortPayment(key)}`,`a=expense_set_payment&id=${id}&payment=${key}`,key===expense.paymentKey?"primary":"secondary",key===expense.paymentKey?brownButton:undefined)),id);
}
export function buildExpenseSourceFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId),sources:Array<[string,string]>=[
    ["CASH_DRAWER","💵 Cash drawer"],["SHOP_BANK","🏦 Shop bank"],["CARD_KBANK","💳 KBank"],
    ["CARD_FIRST_CHOICE","💳 First Choice"],["CARD_AEON","💳 AEON"],["CARD_CITIBANK","💳 Citibank"],
    ["CARD_TTB","💳 TTB"],["CARD_HOMEPRO","💳 HomePro"],["CARD_THE1","💳 The 1"]
  ];
  return menu("Choose payment source",sources.map(([key,label])=>action(`${key===expense.sourceWallet?"✅ ":""}${label}`,`a=expense_set_source&id=${id}&source=${key}`,key===expense.sourceWallet?"primary":"secondary",key===expense.sourceWallet?brownButton:undefined)),id);
}
export function buildExpenseCategoryFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId),keys=["ingredients","fillings","packaging","gas","utilities","rent","staff","transport","marketing","equipment","cleaning","bank_fee","general"];
  return menu("Choose category",keys.map(key=>action(`${key===expense.category?"✅ ":""}${shortCategory(key)}`,`a=expense_set_category&id=${id}&category=${key}`,key===expense.category?"primary":"secondary",key===expense.category?brownButton:undefined)),id);
}
export function buildExpenseDateFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId);return{type:"flex",altText:"Select payment date",contents:{type:"bubble",body:{type:"box",layout:"vertical",spacing:"md",contents:[...title("Select payment date"),row("Current date",displayDate(expense.transactionDate))]},footer:{type:"box",layout:"vertical",spacing:"sm",contents:[
    action("Today",`a=expense_set_date_rel&id=${id}&days=0`),action("Yesterday",`a=expense_set_date_rel&id=${id}&days=1`),
    {type:"button",style:"primary",color:brownButton,height:"sm",action:{type:"datetimepicker",label:"📅 Select date",data:`a=expense_set_date&id=${id}`,mode:"date",initial:expense.transactionDate}},
    action("↩️ Back",`a=expense_back&id=${id}`)
  ]}}};
}
export function buildExpenseSavedFlex(expense:ExpenseFlexRecord):FlexMessage{
  const id=encodeURIComponent(expense.expenseId),body=[row("Item",expense.description),row("Amount",`${money(expense.amountSatang)} THB`),row("Payment",paymentLabels[expense.paymentKey]||expense.paymentKey),row("Paid from",walletLabels[expense.sourceWallet]||expense.sourceWallet),row("Category",categoryLabels[expense.category]||expense.category),row("Date",displayDate(expense.transactionDate))];
  if(expense.documentType==="BANK_SLIP"&&expense.institution)body.push(row("Institution",expense.institution));
  return{type:"flex",altText:`Expense saved: ${expense.description} ${money(expense.amountSatang)} THB`,contents:{type:"bubble",header:{type:"box",layout:"vertical",backgroundColor:"#E8F5E9",contents:title("Saved successfully ✅","#2E7D32")},body:{type:"box",layout:"vertical",contents:body},footer:{type:"box",layout:"vertical",contents:[action("↩️ Undo save",`a=expense_undo&id=${id}`)]}}};
}

function menu(heading:string,buttons:Record<string,unknown>[],id:string):FlexMessage{return{type:"flex",altText:heading,contents:{type:"bubble",size:"mega",body:{type:"box",layout:"vertical",spacing:"md",contents:title(heading)},footer:{type:"box",layout:"vertical",spacing:"sm",contents:[...buttons,action("↩️ Back",`a=expense_back&id=${id}`)]}}};}
function shortPayment(key:string):string{return({cash:"💵 Cash",transfer:"🏦 Transfer / QR",kbank:"💳 KBank",firstchoice:"💳 First Choice",aeon:"💳 AEON",citibank:"💳 Citibank",ttb:"💳 TTB",homepro:"💳 HomePro",t1:"💳 The 1"} as Record<string,string>)[key]||key;}
function shortCategory(key:string):string{return({ingredients:"Ingredients",fillings:"Fillings",packaging:"Packaging",gas:"Gas",utilities:"Utilities",rent:"Rent",staff:"Staff",transport:"Transport",marketing:"Marketing",equipment:"Equipment",cleaning:"Cleaning",bank_fee:"Bank fee",general:"General"} as Record<string,string>)[key]||key;}

export function collectFlexActionLabels(value:unknown):string[]{
  const labels:string[]=[];const walk=(node:unknown)=>{if(!node||typeof node!=="object")return;const obj=node as Record<string,unknown>,actionNode=obj.action as Record<string,unknown>|undefined;if(actionNode?.label!==undefined)labels.push(String(actionNode.label));for(const child of Object.values(obj))Array.isArray(child)?child.forEach(walk):walk(child);};walk(value);return labels;
}
