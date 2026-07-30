import { isIsoDate } from "../shared/time";
import type { ExpenseDocumentItem,PurchaseDocument } from "../types";

export const expenseCategories=new Set(["ingredients","fillings","packaging","gas","utilities","rent","staff","transport","marketing","equipment","cleaning","bank_fee","general"]);
export const expensePayments=new Set(["cash","transfer","kbank","firstchoice","aeon","citibank","ttb","homepro","t1"]);
export const expenseWallets=new Set(["CASH_DRAWER","SHOP_BANK","CARD_KBANK","CARD_FIRST_CHOICE","CARD_AEON","CARD_CITIBANK","CARD_TTB","CARD_HOMEPRO","CARD_THE1"]);

export interface PurchaseExpenseDraft{
  description:string;
  amountSatang:number;
  paymentKey:string;
  sourceWallet:string;
  category:string;
  transactionDate:string;
  needsPaymentConfirmation:boolean;
  needsReview:boolean;
  reviewReasons:string[];
}

export function toSatang(value:number|null):number|null{
  if(value==null||!Number.isFinite(value))return null;
  const result=Math.round(value*100);
  return Number.isSafeInteger(result)?result:null;
}

function inferredPayment(source:string):{paymentKey:string;sourceWallet:string}|null{
  const wallet=source.trim().toUpperCase();
  const pairs:Record<string,{paymentKey:string;sourceWallet:string}>={
    CASH_DRAWER:{paymentKey:"cash",sourceWallet:"CASH_DRAWER"},SHOP_BANK:{paymentKey:"transfer",sourceWallet:"SHOP_BANK"},
    CARD_KBANK:{paymentKey:"kbank",sourceWallet:"CARD_KBANK"},CARD_FIRST_CHOICE:{paymentKey:"firstchoice",sourceWallet:"CARD_FIRST_CHOICE"},
    CARD_AEON:{paymentKey:"aeon",sourceWallet:"CARD_AEON"},CARD_CITIBANK:{paymentKey:"citibank",sourceWallet:"CARD_CITIBANK"},
    CARD_TTB:{paymentKey:"ttb",sourceWallet:"CARD_TTB"},CARD_HOMEPRO:{paymentKey:"homepro",sourceWallet:"CARD_HOMEPRO"},CARD_THE1:{paymentKey:"t1",sourceWallet:"CARD_THE1"}
  };
  return pairs[wallet]||null;
}

export function purchaseExpenseDraft(document:PurchaseDocument):PurchaseExpenseDraft|null{
  const amountSatang=toSatang(document.finalPaidAmountBaht);
  const date=document.documentType==="ONLINE_ORDER"?document.paymentDate:(document.paymentDate||document.documentDate);
  if(document.documentType==="DELIVERY_ORDER"||amountSatang==null||amountSatang<=0||!isIsoDate(date))return null;
  const payment=inferredPayment(document.sourceWalletCandidate);
  const needsPaymentConfirmation=!payment;
  const category=expenseCategories.has(document.suggestedCategory)?document.suggestedCategory:"general";
  const vendor=document.vendor.trim()||document.legalVendorName.trim();
  const description=(document.suggestedDescription.trim()||vendor||"Expense document").slice(0,200);
  const reviewReasons=[...document.reviewReasons];
  if(needsPaymentConfirmation)reviewReasons.push("Payment source must be confirmed");
  if(document.documentType==="ONLINE_ORDER"&&!document.paymentDate)reviewReasons.push("Payment date must be confirmed");
  return{description,amountSatang,paymentKey:payment?.paymentKey||"unconfirmed",sourceWallet:payment?.sourceWallet||"UNCONFIRMED",category,transactionDate:date,needsPaymentConfirmation,needsReview:document.needsReview||document.confidence<0.85||needsPaymentConfirmation||category==="general",reviewReasons:[...new Set(reviewReasons)]};
}

export function documentItemStatements(documentId:string,expenseId:string|null,items:ExpenseDocumentItem[],now:string,randomId:(prefix:string)=>string){
  return items.map(item=>({
    itemId:randomId("item"),documentId,expenseId,sellerKey:item.sellerKey.trim(),productCode:item.productCode.trim(),description:item.description.trim(),quantity:item.quantity,
    unit:item.unit.trim(),unitPriceSatang:toSatang(item.unitPriceBaht),discountSatang:toSatang(item.discountBaht),lineTotalSatang:toSatang(item.lineTotalBaht),vatSatang:toSatang(item.vatBaht),confidence:item.confidence,needsReview:item.needsReview?1:0,now
  })).filter(item=>item.description);
}

export interface SellerDocumentCase{sellerKey:string;vendorName:string;lineTotalSatang:number|null;requiresReview:boolean;}
export function sellerDocumentCases(document:PurchaseDocument):SellerDocumentCase[]{
  const grouped=new Map<string,{vendorName:string;total:number;complete:boolean}>();
  for(const item of document.items){
    const sellerKey=item.sellerKey.trim()||document.vendor.trim()||"UNSPECIFIED";
    const existing=grouped.get(sellerKey)||{vendorName:sellerKey,total:0,complete:true};
    const total=toSatang(item.lineTotalBaht);if(total==null)existing.complete=false;else existing.total+=total;
    grouped.set(sellerKey,existing);
  }
  if(!grouped.size)return[{sellerKey:document.vendor.trim()||"UNSPECIFIED",vendorName:document.vendor.trim(),lineTotalSatang:toSatang(document.finalPaidAmountBaht),requiresReview:document.needsReview}];
  const finalTotal=toSatang(document.finalPaidAmountBaht),sum=[...grouped.values()].reduce((total,item)=>total+item.total,0),allocationSafe=finalTotal!=null&&sum===finalTotal&&[...grouped.values()].every(item=>item.complete);
  return[...grouped.entries()].map(([sellerKey,item])=>({sellerKey,vendorName:item.vendorName,lineTotalSatang:item.complete?item.total:null,requiresReview:document.needsReview||grouped.size>1&&!allocationSafe}));
}
