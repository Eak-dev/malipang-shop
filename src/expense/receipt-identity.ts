import { sha256Hex } from "../shared/ids";
import { isIsoDate } from "../shared/time";
import type { Env,PurchaseDocument } from "../types";
import { toSatang } from "./document";

const candidateLimit=100,itemLimit=200,totalItemLimit=2000;
const purchaseTypes="'RECEIPT','TAX_INVOICE','RECEIPT_TAX_INVOICE','ONLINE_ORDER','DELIVERY_ORDER'";
export interface ReceiptItemFacts {
  quantity:number|null;unitPriceSatang:number|null;discountSatang:number|null;lineTotalSatang:number|null;vatSatang:number|null;
}
export interface ReceiptFacts {
  vendor:string;legalVendorName:string;documentNumber:string;documentDate:string;paymentDate:string;
  amountSatang:number|null;items:ReceiptItemFacts[];itemsTruncated?:boolean;
}
export interface ReceiptMatch {documentId:string;expenseId:string|null;status:string;}
export type ReceiptCandidateResult={kind:"NONE"|"EXACT"|"REVIEW"|"LIMIT";matches:ReceiptMatch[]};
type DocumentRow={document_id:string;expense_id:string|null;status:string;vendor_name:string|null;legal_vendor_name:string|null;document_number:string|null;document_date:string|null;payment_date:string|null;final_paid_satang:number|null;paid_amount_satang:number|null;reference_key:string|null};
type ItemRow={document_id:string;quantity:number|null;unit_price_satang:number|null;discount_satang:number|null;line_total_satang:number|null;vat_satang:number|null};
const documentColumns="d.document_id,d.expense_id,d.status,d.vendor_name,d.legal_vendor_name,d.document_number,d.document_date,d.payment_date,d.final_paid_satang,d.paid_amount_satang,d.reference_key";
const itemColumns="document_id,quantity,unit_price_satang,discount_satang,line_total_satang,vat_satang";

/** Formatting normalization only: punctuation is significant, never fuzzy identity. */
function normalized(value:string):string{return value.normalize("NFKC").trim().replace(/\s+/gu," ").toUpperCase();}
function issuer(facts:ReceiptFacts):string{return normalized(facts.legalVendorName.trim()||facts.vendor);}
function date(facts:ReceiptFacts):string{return facts.documentDate||facts.paymentDate;}
function isPurchaseDocument(facts:ReceiptFacts|PurchaseDocument):facts is PurchaseDocument{return "finalPaidAmountBaht" in facts;}
export function receiptFactsFromDocument(document:PurchaseDocument):ReceiptFacts {
  return{vendor:document.vendor,legalVendorName:document.legalVendorName,documentNumber:document.documentNumber,documentDate:document.documentDate,paymentDate:document.paymentDate,amountSatang:toSatang(document.finalPaidAmountBaht),itemsTruncated:document.items.length>itemLimit,items:document.items.slice(0,itemLimit).map(item=>({quantity:item.quantity,unitPriceSatang:toSatang(item.unitPriceBaht),discountSatang:toSatang(item.discountBaht),lineTotalSatang:toSatang(item.lineTotalBaht),vatSatang:toSatang(item.vatBaht)}))};
}
function rowFacts(row:DocumentRow,items:ItemRow[]):ReceiptFacts {
  return{vendor:row.vendor_name||"",legalVendorName:row.legal_vendor_name||"",documentNumber:row.document_number||"",documentDate:row.document_date||"",paymentDate:row.payment_date||"",amountSatang:row.final_paid_satang??row.paid_amount_satang,itemsTruncated:items.length>itemLimit,items:items.slice(0,itemLimit).map(item=>({quantity:item.quantity,unitPriceSatang:item.unit_price_satang,discountSatang:item.discount_satang,lineTotalSatang:item.line_total_satang,vatSatang:item.vat_satang}))};
}
/** Reuses the existing UNIQUE reference_key index, without rewriting evidence. */
export async function receiptReferenceKey(input:ReceiptFacts|PurchaseDocument):Promise<string> {
  const facts=isPurchaseDocument(input)?receiptFactsFromDocument(input):input,vendor=issuer(facts),number=normalized(facts.documentNumber);
  if(!vendor||!number)return"";
  const bytes=new TextEncoder().encode(JSON.stringify([vendor,number]));
  return`receipt:v1:${await sha256Hex(bytes.buffer as ArrayBuffer)}`;
}

/** Load original structured receipt facts, not the edited Expense date/description. */
export async function storedReceiptFacts(env:Env,expenseId:string):Promise<ReceiptFacts|null> {
  const rows=(await env.DB.prepare(`SELECT ${documentColumns} FROM expense_documents d WHERE d.expense_id=? AND d.document_type IN (${purchaseTypes}) ORDER BY d.created_at,d.document_id LIMIT 2`).bind(expenseId).all<DocumentRow>()).results||[];
  if(!rows.length)return null;
  // Do not silently choose a different primary receipt in inconsistent legacy data.
  if(rows.length!==1)throw new Error("RECEIPT_PRIMARY_IDENTITY_AMBIGUOUS");
  const row=rows[0]!,items=(await env.DB.prepare(`SELECT ${itemColumns} FROM expense_document_items WHERE document_id=? ORDER BY item_id LIMIT ?`).bind(row.document_id,itemLimit+1).all<ItemRow>()).results||[];
  return rowFacts(row,items);
}
function oneCharacterApart(left:string,right:string):boolean {
  const a=Array.from(left),b=Array.from(right);
  if(!a.length||!b.length||Math.abs(a.length-b.length)>1||left===right)return false;
  let i=0,j=0,edits=0;
  while(i<a.length&&j<b.length){
    if(a[i]===b[j]){i++;j++;continue;}
    if(++edits>1)return false;
    if(a.length>=b.length)i++;
    if(b.length>=a.length)j++;
  }
  return edits+(a.length-i)+(b.length-j)===1;
}
/** A multiset, not a Set: two identical purchased items must remain two items. */
function monetaryMultiset(facts:ReceiptFacts):string|null {
  if(facts.itemsTruncated||!facts.items.length)return null;
  const tuples:string[]=[];
  for(const item of facts.items){
    if(item.quantity==null||!Number.isFinite(item.quantity)||item.quantity<=0||item.lineTotalSatang==null||!Number.isSafeInteger(item.lineTotalSatang)||item.lineTotalSatang<0)return null;
    // OCR can report VAT as absent, included, or separately derived. It must
    // not bypass a REVIEW-only hold when the paid line economics are equal.
    // Preserve VAT in the stored facts; never change it or use this as a merge.
    const money=[item.unitPriceSatang,item.discountSatang,item.lineTotalSatang];
    if(money.some(value=>value!=null&&!Number.isSafeInteger(value)))return null;
    tuples.push(JSON.stringify([item.quantity,...money]));
  }
  return JSON.stringify(tuples.sort());
}
function match(row:DocumentRow):ReceiptMatch{return{documentId:row.document_id,expenseId:row.expense_id,status:row.status};}

/**
 * Bounded, read-only pre-confirm check. Exact identity is not amount/date based.
 * A one-character OCR discrepancy is only a REVIEW hold, never a merge/link.
 * No status filter: cancelled/waiting evidence is still evidence of identity.
 * Legacy Unicode variants are additionally discovered within the date/amount
 * candidate window; no claim of exhaustive fuzzy matching is made.
 */
export async function inspectReceiptCandidates(env:Env,input:ReceiptFacts|PurchaseDocument,options:{excludeExpenseId?:string;excludeDocumentId?:string}={}):Promise<ReceiptCandidateResult> {
  const facts=isPurchaseDocument(input)?receiptFactsFromDocument(input):input,vendor=issuer(facts),number=normalized(facts.documentNumber);
  if(!vendor||!number)return{kind:"NONE",matches:[]};
  if(facts.itemsTruncated)return{kind:"LIMIT",matches:[]};
  const key=await receiptReferenceKey(facts),originalVendor=facts.legalVendorName.trim()||facts.vendor.trim(),originalNumber=facts.documentNumber.trim();
  const candidateDate=date(facts),nearEnabled=isIsoDate(candidateDate)&&Number.isSafeInteger(facts.amountSatang)&&Number(facts.amountSatang)>0;
  const rows=(await env.DB.prepare(`SELECT ${documentColumns} FROM expense_documents d
    WHERE d.document_type IN (${purchaseTypes})
      AND (? IS NULL OR d.document_id<>?)
      AND (? IS NULL OR ((d.expense_id IS NULL OR d.expense_id<>?) AND NOT EXISTS(SELECT 1 FROM expense_document_links l WHERE l.document_id=d.document_id AND l.expense_id=?)))
      AND (d.reference_key=? OR (
        trim(d.document_number) COLLATE NOCASE IN (?,?)
        AND trim(COALESCE(NULLIF(trim(d.legal_vendor_name),''),d.vendor_name,'')) COLLATE NOCASE IN (?,?)
      ) OR (?=1 AND COALESCE(NULLIF(d.document_date,''),d.payment_date)=? AND COALESCE(d.final_paid_satang,d.paid_amount_satang)=?))
    ORDER BY d.document_id LIMIT ?`).bind(options.excludeDocumentId??null,options.excludeDocumentId??null,options.excludeExpenseId??null,options.excludeExpenseId??null,options.excludeExpenseId??null,key,originalNumber,number,originalVendor,vendor,nearEnabled?1:0,candidateDate,facts.amountSatang,candidateLimit+1).all<DocumentRow>()).results||[];
  if(rows.length>candidateLimit)return{kind:"LIMIT",matches:[]};
  const exact=rows.filter(row=>row.reference_key===key||(issuer(rowFacts(row,[]))===vendor&&normalized(row.document_number||"")===number));
  if(exact.length)return{kind:"EXACT",matches:exact.map(match)};
  if(!nearEnabled)return{kind:"NONE",matches:[]};
  const fingerprint=monetaryMultiset(facts);
  if(!fingerprint)return{kind:"NONE",matches:[]};
  const near=rows.filter(row=>issuer(rowFacts(row,[]))===vendor&&date(rowFacts(row,[]))===candidateDate&&(row.final_paid_satang??row.paid_amount_satang)===facts.amountSatang&&oneCharacterApart(number,normalized(row.document_number||"")));
  if(!near.length)return{kind:"NONE",matches:[]};
  const items=(await env.DB.prepare(`SELECT ${itemColumns} FROM expense_document_items WHERE document_id IN (SELECT value FROM json_each(?)) ORDER BY document_id,item_id LIMIT ?`).bind(JSON.stringify(near.map(row=>row.document_id)),totalItemLimit+1).all<ItemRow>()).results||[];
  if(items.length>totalItemLimit)return{kind:"LIMIT",matches:[]};
  const matches:ReceiptMatch[]=[];
  for(const row of near){
    const candidate=rowFacts(row,items.filter(item=>item.document_id===row.document_id));
    if(candidate.itemsTruncated)return{kind:"LIMIT",matches:[]};
    if(monetaryMultiset(candidate)===fingerprint)matches.push(match(row));
  }
  return{kind:matches.length?"REVIEW":"NONE",matches};
}
