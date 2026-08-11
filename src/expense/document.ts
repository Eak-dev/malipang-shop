import { isIsoDate } from "../shared/time";
import type { PurchaseDocument } from "../types";

export const expenseCategories=new Set(["ingredients","fillings","packaging","gas","utilities","rent","staff","transport","marketing","equipment","cleaning","bank_fee","general"]);

/**
 * Canonical payment-to-funding-source pairs for Expense.  Keep payment method
 * and paid-from distinct: the LINE chooser selects a supported pair, while
 * the stored fields remain independently auditable.
 */
export const expensePaymentOptions=[
  {paymentKey:"cash",sourceWallet:"CASH_DRAWER",label:"💵 Cash",sourceLabel:"💵 Cash drawer"},
  {paymentKey:"transfer",sourceWallet:"SHOP_BANK",label:"🏦 Transfer / QR",sourceLabel:"🏦 Shop bank"},
  {paymentKey:"kbank",sourceWallet:"CARD_KBANK",label:"💳 KBank",sourceLabel:"💳 KBank"},
  {paymentKey:"firstchoice",sourceWallet:"CARD_FIRST_CHOICE",label:"💳 First Choice",sourceLabel:"💳 First Choice"},
  {paymentKey:"aeon",sourceWallet:"CARD_AEON",label:"💳 AEON",sourceLabel:"💳 AEON"},
  {paymentKey:"citibank",sourceWallet:"CARD_CITIBANK",label:"💳 Citibank",sourceLabel:"💳 Citibank"},
  {paymentKey:"ttb",sourceWallet:"CARD_TTB",label:"💳 TTB",sourceLabel:"💳 TTB"},
  {paymentKey:"homepro",sourceWallet:"CARD_HOMEPRO",label:"💳 HomePro",sourceLabel:"💳 HomePro"},
  {paymentKey:"t1",sourceWallet:"CARD_THE1",label:"💳 The 1",sourceLabel:"💳 The 1"}
] as const;
export const expensePayments=new Set<string>(expensePaymentOptions.map(option=>option.paymentKey));
export const expenseWallets=new Set<string>(expensePaymentOptions.map(option=>option.sourceWallet));
export type ExpensePaymentOption=(typeof expensePaymentOptions)[number];

export function paymentOptionForPayment(paymentKey:string):ExpensePaymentOption|undefined{
  return expensePaymentOptions.find(option=>option.paymentKey===paymentKey);
}
export function paymentOptionForWallet(sourceWallet:string):ExpensePaymentOption|undefined{
  return expensePaymentOptions.find(option=>option.sourceWallet===sourceWallet);
}
export function paymentOptionForPair(paymentKey:string,sourceWallet:string):ExpensePaymentOption|undefined{
  return expensePaymentOptions.find(option=>option.paymentKey===paymentKey&&option.sourceWallet===sourceWallet);
}

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
  const option=paymentOptionForWallet(source.trim().toUpperCase());
  return option?{paymentKey:option.paymentKey,sourceWallet:option.sourceWallet}:null;
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
  if(document.needsReview&&!reviewReasons.length)reviewReasons.push("Document facts must be confirmed");
  if(needsPaymentConfirmation)reviewReasons.push("Payment source must be confirmed");
  if(document.documentType==="ONLINE_ORDER"&&!document.paymentDate)reviewReasons.push("Payment date must be confirmed");
  return{description,amountSatang,paymentKey:payment?.paymentKey||"unconfirmed",sourceWallet:payment?.sourceWallet||"UNCONFIRMED",category,transactionDate:date,needsPaymentConfirmation,needsReview:document.needsReview||document.confidence<0.85||needsPaymentConfirmation||category==="general",reviewReasons:[...new Set(reviewReasons)]};
}

export function documentItemStatements(documentId:string,expenseId:string|null,document:PurchaseDocument,now:string,randomId:(prefix:string)=>string){
  const issuer=document.legalVendorName.trim()||document.vendor.trim()||"UNSPECIFIED";
  return document.items.map(item=>({
    itemId:randomId("item"),documentId,expenseId,sellerKey:document.documentType==="ONLINE_ORDER"?(item.sellerKey.trim()||issuer):issuer,productCode:item.productCode.trim(),description:item.description.trim(),quantity:item.quantity,
    unit:item.unit.trim(),unitPriceSatang:toSatang(item.unitPriceBaht),discountSatang:toSatang(item.discountBaht),lineTotalSatang:toSatang(item.lineTotalBaht),vatSatang:toSatang(item.vatBaht),confidence:item.confidence,needsReview:item.needsReview?1:0,now
  })).filter(item=>item.description);
}

export interface SellerDocumentCase{sellerKey:string;vendorName:string;grossSatang:number|null;finalPaidSatang:number|null;requiresReview:boolean;}
export function sellerDocumentCases(document:PurchaseDocument):SellerDocumentCase[]{
  const issuer=document.legalVendorName.trim()||document.vendor.trim()||"UNSPECIFIED";
  // A receipt, tax invoice or delivery document has one issuing seller.
  // Item-level labels may contain a buyer, ship-to party, product brand or
  // manufacturer and must not turn a single-issuer document into a marketplace
  // multi-seller case. Only ONLINE_ORDER supports per-item seller grouping.
  if(document.documentType!=="ONLINE_ORDER"){
    return[{sellerKey:issuer,vendorName:issuer,grossSatang:toSatang(document.grossAmountBaht),finalPaidSatang:toSatang(document.finalPaidAmountBaht),requiresReview:document.needsReview}];
  }
  const grouped=new Map<string,{vendorName:string;total:number;complete:boolean}>();
  for(const item of document.items){
    const sellerKey=item.sellerKey.trim()||issuer;
    const existing=grouped.get(sellerKey)||{vendorName:sellerKey,total:0,complete:true};
    const total=toSatang(item.lineTotalBaht);if(total==null)existing.complete=false;else existing.total+=total;
    grouped.set(sellerKey,existing);
  }
  if(!grouped.size)return[{sellerKey:issuer,vendorName:issuer,grossSatang:toSatang(document.grossAmountBaht),finalPaidSatang:toSatang(document.finalPaidAmountBaht),requiresReview:document.needsReview}];
  const finalTotal=toSatang(document.finalPaidAmountBaht),sum=[...grouped.values()].reduce((total,item)=>total+item.total,0),allocationSafe=finalTotal!=null&&sum===finalTotal&&[...grouped.values()].every(item=>item.complete);
  return[...grouped.entries()].map(([sellerKey,item])=>({sellerKey,vendorName:item.vendorName,grossSatang:item.complete?item.total:null,finalPaidSatang:item.complete?item.total:null,requiresReview:document.needsReview||grouped.size>1&&!allocationSafe}));
}
