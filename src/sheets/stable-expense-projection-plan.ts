import type {StableExpenseSource} from './stable-expense-source';
import {buildExpenseRawSheetValues} from './raw-projection';
import {buildPurchaseDetailEntries,type PurchaseDetailDocument,type PurchaseDetailRecord} from './purchase-details';
import type {DailyExpenseDocumentItem} from './daily-expense';

/** Build from one captured source, never from a caller-supplied Sheet row. */
export function planStableExpenseProjections(source:StableExpenseSource):{record:PurchaseDetailRecord;raw:unknown[];details:Array<{itemId:string;values:unknown[]}>}{
 const e=source.expense,id=String(e.expense_id||'');
 if(!/^exp_[A-Za-z0-9_-]{1,128}$/.test(id)||e.status!=='CONFIRMED'||!Number.isSafeInteger(e.amount_satang)||Number(e.amount_satang)<=0)throw Error('STABLE_EXPENSE_INVALID');
 const primary=source.links.filter(link=>link.relation_type==='PRIMARY_PURCHASE_DOCUMENT');
 if(primary.length>1)throw Error('STABLE_EXPENSE_DOCUMENT_CONFLICT');
 const document=primary.length?source.documents.find(doc=>doc.document_id===primary[0]!.document_id):source.documents.find(doc=>doc.expense_id===id);
 if(primary.length&&!document)throw Error('STABLE_EXPENSE_DOCUMENT_CONFLICT');
 const record:PurchaseDetailRecord={expenseId:id,transactionDate:String(e.transaction_date||''),description:String(e.description||''),amountBaht:Number(e.amount_satang)/100,paymentKey:String(e.payment_key||''),sourceWallet:String(e.source_wallet||''),category:String(e.category||''),branchId:String(e.branch_id||''),status:'CONFIRMED',createdAt:String(e.created_at||''),updatedAt:String(e.updated_at||e.created_at||'')};
 const doc:PurchaseDetailDocument|null=primary.length&&document?{documentId:String(document.document_id),documentType:String(document.document_type),vendorName:String(document.vendor_name||''),legalVendorName:String(document.legal_vendor_name||''),documentNumber:String(document.document_number||''),orderId:String(document.order_id||''),documentDate:String(document.document_date||'')}:null;
 if(source.items.length&&(!doc||source.items.some(item=>item.document_id!==doc.documentId||item.expense_id!==id||!/^item_[A-Za-z0-9_-]{1,128}$/.test(String(item.item_id||''))||!String(item.description||'').trim())))throw Error('STABLE_EXPENSE_ITEMS_UNVERIFIED');
 const ids=source.items.map(item=>String(item.item_id));if(new Set(ids).size!==ids.length)throw Error('STABLE_EXPENSE_ITEMS_UNVERIFIED');
 if(source.items.some(item=>['quantity','unit_price_satang','discount_satang','line_total_satang'].some(key=>item[key]!=null&&(typeof item[key]!=='number'||!Number.isFinite(item[key] as number)))))throw Error('STABLE_EXPENSE_ITEMS_UNVERIFIED');
 const items:DailyExpenseDocumentItem[]=source.items.map(item=>({itemId:String(item.item_id),documentId:String(item.document_id),expenseId:item.expense_id==null?null:String(item.expense_id),sellerKey:String(item.seller_key||''),productCode:String(item.product_code||''),description:String(item.description||''),quantity:item.quantity==null?null:Number(item.quantity),unit:String(item.unit||''),unitPriceSatang:item.unit_price_satang==null?null:Number(item.unit_price_satang),discountSatang:item.discount_satang==null?null:Number(item.discount_satang),lineTotalSatang:item.line_total_satang==null?null:Number(item.line_total_satang)}));
 const entries=buildPurchaseDetailEntries(record,doc,items);if(entries.length!==items.length)throw Error('STABLE_EXPENSE_ITEMS_UNVERIFIED');
 return{record,raw:buildExpenseRawSheetValues(e,document||null),details:entries.map(entry=>({itemId:entry.itemId,values:entry.values}))};
}
