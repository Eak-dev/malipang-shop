import { isIsoDate, minutesOf } from "../shared/time";
import type { BankSlipDocument, VisionResult } from "../types";

const categories=new Set(["ingredients","fillings","packaging","gas","utilities","rent","staff","transport","marketing","equipment","cleaning","bank_fee","general"]);

export interface BankSlipValidation {
  ok:boolean;
  code:string;
  missing:string[];
  review:boolean;
  note:string;
}

export interface BankSlipExpenseDraft {
  description:string;
  amountSatang:number;
  paymentKey:"transfer";
  sourceWallet:"SHOP_BANK";
  category:string;
  transactionDate:string;
}

function validTime(value:string):boolean{
  if(!value)return true;
  try{minutesOf(value);return true;}catch{return false;}
}

export function validateBankSlip(reading:VisionResult):BankSlipValidation{
  const document=reading.document;
  if(reading.kind!=="BANK_SLIP"||!document)return{ok:false,code:"BANK_SLIP_DATA_MISSING",missing:["document"],review:true,note:"The image was not read as a bank or wallet payment receipt."};
  const missing:string[]=[];
  if(document.transactionStatus!=="SUCCESS")missing.push("successful status");
  if(!isIsoDate(document.paymentDate))missing.push("payment date");
  if(!validTime(document.paymentTime))missing.push("payment time");
  if(!document.referenceId.trim())missing.push("reference ID");
  if(!document.merchant.trim()&&!document.recipient.trim())missing.push("recipient or merchant");
  if(document.currency.trim().toUpperCase()!=="THB")missing.push("THB currency");
  if(document.paidAmountBaht==null||!Number.isFinite(document.paidAmountBaht)||document.paidAmountBaht<=0)missing.push("paid amount");
  const satang=Math.round(Number(document.paidAmountBaht||0)*100);
  if(satang<=0||!Number.isSafeInteger(satang))missing.push("valid paid amount");
  if(document.grossAmountBaht!=null&&document.discountAmountBaht!=null&&document.paidAmountBaht!=null&&Math.abs(document.grossAmountBaht-document.discountAmountBaht-document.paidAmountBaht)>0.011)missing.push("amount reconciliation");
  if(missing.length)return{ok:false,code:"BANK_SLIP_FIELDS_MISSING",missing:[...new Set(missing)],review:true,note:`Missing or invalid: ${[...new Set(missing)].join(", ")}`};
  const review=document.needsReview||document.confidence<0.85||document.suggestedCategory==="general"||document.transactionType==="TOPUP";
  return{ok:true,code:review?"BANK_SLIP_CONFIRM_REQUIRED":"OK",missing:[],review,note:review?document.note||"Please confirm the item and category before saving.":""};
}

export function bankSlipExpenseDraft(document:BankSlipDocument):BankSlipExpenseDraft{
  const counterparty=document.merchant.trim()||document.recipient.trim(),description=(document.suggestedDescription.trim()||`${document.transactionType==="WALLET_PAYMENT"?"Payment to":"Transfer to"} ${counterparty}`).slice(0,200),hint=`${document.merchant} ${document.recipient} ${description}`.toLowerCase();let category=categories.has(document.suggestedCategory)?document.suggestedCategory:"general";
  if(category==="general"&&/(plastic|packag|พลาสติก|ถุง|กล่อง)/i.test(hint))category="packaging";
  if(category==="general"&&/(print|printing|การพิมพ์|โรงพิมพ์)/i.test(hint))category="marketing";
  const amountSatang=Math.round(Number(document.paidAmountBaht||0)*100);
  return{description,amountSatang,paymentKey:"transfer",sourceWallet:"SHOP_BANK",category,transactionDate:document.paymentDate};
}

export function bankSlipReferenceKey(document:BankSlipDocument):string{
  const normalized=(value:string)=>value.trim().toUpperCase().replace(/[^A-Z0-9]/g,"");
  return`${normalized(document.institution)||document.channel}|${normalized(document.referenceId)}`;
}

export function bankSlipReferenceSuffix(referenceId:string):string{
  const value=referenceId.trim();return value.length<=8?value:value.slice(-8);
}
