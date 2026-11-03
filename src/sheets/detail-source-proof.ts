import type {Env} from '../types';
import {buildPurchaseDetailEntries,type PurchaseDetailDocument,type PurchaseDetailRecord} from './purchase-details';
import type {DailyExpenseDocumentItem} from './daily-expense';
import {expenseSourceEvidenceIntegrity} from './expense-projection-runtime-journal';

/** Point-in-time source inventory only. It grants no permission to write Sheets;
 * a consumer must also hold the generation/operation fences and re-read it.
 * Values and fingerprints may contain or identify private purchase information. */
export interface DetailSourceProof {
  expenseId:string; version:number; revision:number;
  entries:readonly {itemId:string; values:readonly (string|number)[]}[];
  fingerprint:string;
}
type Row=Record<string,unknown>;
const requiredText=(v:unknown):string=>{if(typeof v!=='string'||!v.trim()||v.length>1024)throw Error('DETAIL_SOURCE_INVALID');return v;};
const optionalText=(v:unknown):string=>{if(v==null)return '';if(typeof v!=='string'||v.length>4096)throw Error('DETAIL_SOURCE_INVALID');return v;};
const optionalNumber=(v:unknown,integer=false):number|null=>{if(v==null)return null;if(typeof v!=='number'||!Number.isFinite(v)||(integer&&!Number.isSafeInteger(v)))throw Error('DETAIL_SOURCE_INVALID');return v;};
const validDate=(value:string):boolean=>{const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);if(!m)return false;const y=Number(m[1]),month=Number(m[2]),day=Number(m[3]),d=new Date(Date.UTC(y,month-1,day));return y>=100&&d.getUTCFullYear()===y&&d.getUTCMonth()+1===month&&d.getUTCDate()===day;};
const jsonRows=(v:unknown):Row[]=>{if(typeof v!=='string'||v.length>1048576)throw Error('DETAIL_SOURCE_TOO_LARGE');const result:unknown=JSON.parse(v);if(!Array.isArray(result)||result.length>500||result.some(x=>!x||typeof x!=='object'||Array.isArray(x)))throw Error('DETAIL_SOURCE_INVENTORY_INVALID');return result as Row[];};
async function digest(v:unknown):Promise<string>{const bytes=new TextEncoder().encode(JSON.stringify(v));if(bytes.length>1048576)throw Error('DETAIL_SOURCE_TOO_LARGE');return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');}

/** One SQLite SELECT snapshots the expense, selected primary document, all
 * candidate links/items and the monotonic source revision together. A missing
 * or ambiguous relationship is held; never silently filter a sibling item. */
async function readDetailSourceProofInternal(env:Env,expenseId:string,version:number,revision:number):Promise<DetailSourceProof>{
  if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(expenseId)||!Number.isSafeInteger(version)||version<1||!Number.isSafeInteger(revision)||revision<1)throw Error('DETAIL_SOURCE_INVALID');
  const row=await env.DB.prepare(`SELECT e.expense_id,e.version,e.status,e.amount_satang,e.transaction_date,e.description,e.payment_key,e.source_wallet,e.category,e.branch_id,e.created_at,e.updated_at,r.revision,
    (SELECT json_group_array(json_object('link_id',x.link_id,'document_id',x.document_id,'document_type',x.document_type,'vendor_name',x.vendor_name,'legal_vendor_name',x.legal_vendor_name,'document_number',x.document_number,'order_id',x.order_id,'document_date',x.document_date,'document_updated_at',x.document_updated_at)) FROM
      (SELECT l.link_id,d.document_id,d.document_type,d.vendor_name,d.legal_vendor_name,d.document_number,d.order_id,d.document_date,d.updated_at AS document_updated_at FROM expense_document_links l JOIN expense_documents d ON d.document_id=l.document_id WHERE l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' ORDER BY l.created_at,l.link_id LIMIT 501) x) AS primary_documents,
    (SELECT json_group_array(json_object('item_id',x.item_id,'document_id',x.document_id,'expense_id',x.expense_id,'seller_key',x.seller_key,'product_code',x.product_code,'description',x.description,'quantity',x.quantity,'unit',x.unit,'unit_price_satang',x.unit_price_satang,'discount_satang',x.discount_satang,'line_total_satang',x.line_total_satang,'created_at',x.created_at,'updated_at',x.updated_at)) FROM
      (SELECT i.* FROM expense_document_items i WHERE i.expense_id=e.expense_id OR i.document_id IN (SELECT l.document_id FROM expense_document_links l WHERE l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT') ORDER BY i.created_at,i.item_id LIMIT 501) x) AS items
    FROM expense_events e JOIN expense_projection_source_revisions r ON r.expense_id=e.expense_id AND r.state='TRACKED'
    WHERE e.expense_id=? AND e.version=? AND r.revision=? AND e.status='CONFIRMED'
    AND length(COALESCE(e.description,''))+length(COALESCE(e.category,''))+length(COALESCE(e.branch_id,''))+length(COALESCE(e.payment_key,''))+length(COALESCE(e.source_wallet,''))+length(COALESCE(e.transaction_date,''))+length(COALESCE(e.created_at,''))+length(COALESCE(e.updated_at,''))<=16384
    AND NOT EXISTS(SELECT 1 FROM expense_document_links l JOIN expense_documents d ON d.document_id=l.document_id WHERE l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' AND length(COALESCE(d.document_id,''))+length(COALESCE(d.document_type,''))+length(COALESCE(d.vendor_name,''))+length(COALESCE(d.legal_vendor_name,''))+length(COALESCE(d.document_number,''))+length(COALESCE(d.order_id,''))+length(COALESCE(d.document_date,''))+length(COALESCE(d.updated_at,''))+length(COALESCE(l.link_id,''))>8192)
    AND NOT EXISTS(SELECT 1 FROM expense_document_items i WHERE (i.expense_id=e.expense_id OR i.document_id IN (SELECT l.document_id FROM expense_document_links l WHERE l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT')) AND length(COALESCE(i.item_id,''))+length(COALESCE(i.document_id,''))+length(COALESCE(i.expense_id,''))+length(COALESCE(i.seller_key,''))+length(COALESCE(i.product_code,''))+length(COALESCE(i.description,''))+length(COALESCE(i.unit,''))+length(COALESCE(i.created_at,''))+length(COALESCE(i.updated_at,''))>1024)
    AND EXISTS(SELECT 1 FROM expense_projection_bootstrap b WHERE b.singleton=1 AND b.state='COMPLETE') AND ${expenseSourceEvidenceIntegrity}`).bind(expenseId,version,revision).first<Row>();
  if(!row)throw Error('DETAIL_SOURCE_UNAVAILABLE');
  const docs=jsonRows(row.primary_documents),rawItems=jsonRows(row.items);
  if(docs.length>1)throw Error('DETAIL_SOURCE_DOCUMENT_AMBIGUOUS');
  if(!Number.isSafeInteger(row.amount_satang)||Number(row.amount_satang)<1||Math.round(Number(row.amount_satang)/100*100)!==row.amount_satang)throw Error('DETAIL_SOURCE_INVALID');
  const record:PurchaseDetailRecord={expenseId,version,status:'CONFIRMED',transactionDate:requiredText(row.transaction_date),description:requiredText(row.description),amountBaht:Number(row.amount_satang)/100,paymentKey:requiredText(row.payment_key),sourceWallet:requiredText(row.source_wallet),category:requiredText(row.category),branchId:optionalText(row.branch_id),createdAt:requiredText(row.created_at),updatedAt:optionalText(row.updated_at)||requiredText(row.created_at)};
  let document:PurchaseDetailDocument|null=null;
  if(docs.length){const d=docs[0]!;document={documentId:requiredText(d.document_id),documentType:requiredText(d.document_type),vendorName:optionalText(d.vendor_name),legalVendorName:optionalText(d.legal_vendor_name),documentNumber:optionalText(d.document_number),orderId:optionalText(d.order_id),documentDate:optionalText(d.document_date)};requiredText(d.link_id);}
  if(!validDate(record.transactionDate)||document?.documentDate&&!validDate(document.documentDate))throw Error('DETAIL_SOURCE_INVALID_DATE');
  if(!document&&rawItems.length)throw Error('DETAIL_SOURCE_ITEM_CONFLICT');
  const ids=new Set<string>();const items:DailyExpenseDocumentItem[]=rawItems.map(i=>{
    const itemId=requiredText(i.item_id);if(ids.has(itemId)||itemId.length>256||i.expense_id!==expenseId||i.document_id!==document?.documentId)throw Error('DETAIL_SOURCE_ITEM_CONFLICT');ids.add(itemId);
    const lineTotalSatang=optionalNumber(i.line_total_satang,true);if(lineTotalSatang===null)throw Error('DETAIL_SOURCE_AMOUNT_AMBIGUOUS');
    return{itemId,documentId:requiredText(i.document_id),expenseId,sellerKey:optionalText(i.seller_key),productCode:optionalText(i.product_code),description:requiredText(i.description),quantity:optionalNumber(i.quantity),unit:optionalText(i.unit),unitPriceSatang:optionalNumber(i.unit_price_satang,true),discountSatang:optionalNumber(i.discount_satang,true),lineTotalSatang};
  });
  let total=0;for(const item of items){total+=item.lineTotalSatang!;if(!Number.isSafeInteger(total))throw Error('DETAIL_SOURCE_AMOUNT_AMBIGUOUS');}if(!Number.isSafeInteger(Number(row.amount_satang)-total))throw Error('DETAIL_SOURCE_AMOUNT_AMBIGUOUS');
  const entries=buildPurchaseDetailEntries(record,document,items).map(x=>({itemId:x.itemId,values:x.values as (string|number)[]}));
  if(entries.length!==rawItems.length||entries.some(x=>x.values.length!==20||x.values.some(v=>typeof v!=='string'&&(typeof v!=='number'||!Number.isFinite(v)))))throw Error('DETAIL_SOURCE_PROJECTION_INVALID');
  return{expenseId,version,revision,entries,fingerprint:await digest([expenseId,version,revision,docs,rawItems,entries])};
}
/** Do not forward provider/driver/JSON errors, which can contain private data. */
export async function readDetailSourceProof(env:Env,expenseId:string,version:number,revision:number):Promise<DetailSourceProof>{
  try{return await readDetailSourceProofInternal(env,expenseId,version,revision);}catch{throw Error('DETAIL_SOURCE_UNAVAILABLE_OR_INVALID');}
}
export async function detailSourceStillMatches(env:Env,proof:DetailSourceProof):Promise<boolean>{try{const now=await readDetailSourceProof(env,proof.expenseId,proof.version,proof.revision);return now.fingerprint===proof.fingerprint&&JSON.stringify(now.entries)===JSON.stringify(proof.entries);}catch{return false;}}
