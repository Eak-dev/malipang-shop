import type { PurchaseDocument } from "../types";

export type ExpenseDocumentRelation="PRIMARY_PURCHASE_DOCUMENT"|"PAYMENT_EVIDENCE"|"SUPPORTING_DOCUMENT";

export interface ExistingExpenseDocument{
  documentId:string;
  expenseId:string|null;
  documentType:string;
  legalVendorName:string;
  documentNumber:string;
  orderId:string;
}

/** Only printed identifiers can create an automatic relation. */
export function exactDocumentMatch(incoming:PurchaseDocument,existing:ExistingExpenseDocument):{matched:boolean;reason:string}{
  const orderId=incoming.orderId.trim(),existingOrder=existing.orderId.trim();
  if(orderId&&existingOrder&&orderId===existingOrder)return{matched:true,reason:"Exact order ID"};
  const number=incoming.documentNumber.trim(),existingNumber=existing.documentNumber.trim();
  const incomingVendor=(incoming.legalVendorName||incoming.vendor).trim(),existingVendor=existing.legalVendorName.trim();
  if(number&&existingNumber&&number===existingNumber&&incomingVendor&&existingVendor&&incomingVendor===existingVendor)return{matched:true,reason:"Exact vendor and document number"};
  return{matched:false,reason:"No shared exact identifier"};
}

export function relationForIncomingDocument(document:PurchaseDocument):ExpenseDocumentRelation{
  return document.documentType==="DELIVERY_ORDER"?"SUPPORTING_DOCUMENT":"PRIMARY_PURCHASE_DOCUMENT";
}
