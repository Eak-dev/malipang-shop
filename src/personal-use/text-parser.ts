import { isIsoDate,isoDateInBangkok } from "../shared/time";

export type PersonalTransactionType="PERSONAL_USE"|"PERSONAL_RETURN";
export interface ParsedPersonalUseText{
  transactionType:PersonalTransactionType;
  amountSatang:number;
  sourceWallet:"SHOP_BANK"|"CASH_DRAWER";
  description:string;
  transactionDate:string;
}

const useCommands=new Set(["ส่วนตัว","personal use","personal ยู","personal u"]);
const returnCommands=new Set(["คืนเงินส่วนตัว","personal return","คืนเงิน personal"]);
const shopBankAliases=new Set(["kbank ร้าน","บัญชีร้าน","shop bank","kbank shop","scb ร้าน","scb shop"]);
const cashAliases=new Set(["เงินสดหน้าร้าน","cash drawer","เงินสดร้าน"]);

function normalize(value:string):string{return value.trim().toLowerCase().replace(/\s+/g," ");}

/**
 * Strict pipe-delimited grammar deliberately prevents a withdrawal being
 * mistaken for an ordinary Expense: `ส่วนตัว | 40000 | KBank ร้าน | ค่าเครดิต`.
 */
export function parsePersonalUseText(text:string,now=new Date()):ParsedPersonalUseText|null{
  const parts=text.split("|").map(part=>part.trim());
  if(parts.length<4||parts.length>5)return null;
  const command=normalize(parts[0]||"");
  const transactionType=useCommands.has(command)?"PERSONAL_USE":returnCommands.has(command)?"PERSONAL_RETURN":null;
  if(!transactionType)return null;
  const amountText=String(parts[1]||"").replace(/,/g,"");
  if(!/^\d+(?:\.\d{1,2})?$/.test(amountText))return null;
  const amountSatang=Math.round(Number(amountText)*100);
  if(!Number.isSafeInteger(amountSatang)||amountSatang<=0)return null;
  const wallet=normalize(parts[2]||"");
  const sourceWallet=shopBankAliases.has(wallet)?"SHOP_BANK":cashAliases.has(wallet)?"CASH_DRAWER":null;
  if(!sourceWallet)return null;
  const description=String(parts[3]||"").replace(/\s+/g," ").trim();
  if(!description||description.length>200)return null;
  const transactionDate=parts.length===5?String(parts[4]||"").trim():isoDateInBangkok(now);
  if(!isIsoDate(transactionDate))return null;
  return{transactionType,amountSatang,sourceWallet,description,transactionDate};
}
