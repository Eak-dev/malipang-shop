import type {Env} from '../types';

/** Experimental shadow journal only; this is not a rollout or enrollment API. */
export type LedgerSourceProof = {
  kind:'EXPENSE'; id:string; version:number; status:'CONFIRMED'|'CANCELLED';
  transactionDate:string; description:string; amountSatang:number; paymentKey:string;
  sourceWallet:string; category:string; updatedAt:string|null;
}|{
  kind:'PERSONAL_USE'; id:string; version:number; status:'CONFIRMED'|'CANCELLED';
  transactionDate:string; description:string; amountSatang:number; transactionType:string;
  sourceWallet:string; updatedAt:string;
}|{
  kind:'PURCHASE_DETAILS'; id:string; version:number; status:'CONFIRMED'|'CANCELLED';
  transactionDate:string; description:string; amountSatang:number; category:string; branchId:string|null; createdAt:string; updatedAt:string|null;
  documentId:string; documentType:string; documentDate:string|null; vendorName:string|null; legalVendorName:string|null;
  documentNumber:string|null; orderId:string|null; documentUpdatedAt:string|null;
  itemId:string; itemDescription:string; quantity:number|null; unit:string|null; unitPriceSatang:number|null;
  discountSatang:number|null; lineTotalSatang:number|null; itemUpdatedAt:string;
  validItemCount:number; totalLineSatang:number; firstItemId:string;
};
/** Only per-cell digests are retained, not another copy of private RAW data. */
export type LedgerBaseline=Record<string,string>;
export type LedgerCellValue=string|number|boolean|null;
const allowed:Record<LedgerSourceProof['kind'],ReadonlySet<number>>={
  // Only fields covered by sourcePredicate are allowed. Document / submitter
  // metadata in RAW and personal timestamps without a matching proof remain held.
  EXPENSE:new Set([1,2,3,4,5,6,7]),
  PERSONAL_USE:new Set([1,2,3,4,5,6,13,14]),
  PURCHASE_DETAILS:new Set([2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,18,19])
};
export function canonicalLedgerBaseline(kind:LedgerSourceProof['kind'],value:LedgerBaseline):string{
  if(!value||Array.isArray(value)||typeof value!=='object')throw new Error('LEDGER_BASELINE_INVALID');
  const keys=Object.keys(value).sort((a,b)=>Number(a)-Number(b));
  if(keys.length!==allowed[kind].size||keys.some(k=>!/^(0|[1-9]\d*)$/.test(k)||!allowed[kind].has(Number(k))))throw new Error('LEDGER_BASELINE_INVALID');
  const normalized:LedgerBaseline={};
  for(const k of keys){const v=value[k];if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))throw new Error('LEDGER_BASELINE_INVALID');normalized[k]=v;}
  const json=JSON.stringify(normalized);if(json.length>32768)throw new Error('LEDGER_BASELINE_INVALID');return json;
}
/** Digest typed cell values; low-entropy values remain guessable. D1 remains private. */
export async function digestLedgerCell(value:LedgerCellValue):Promise<string>{
  if(value!==null&&typeof value!=='string'&&typeof value!=='boolean'&&(typeof value!=='number'||!Number.isFinite(value)))throw new Error('LEDGER_CELL_INVALID');
  const bytes=new TextEncoder().encode(JSON.stringify([value===null?'null':typeof value,value]));
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Verify every selected field against its previously recorded digest. */
export async function baselineMatches(baseline:LedgerBaseline,cells:Record<string,LedgerCellValue>):Promise<boolean>{
  const keys=Object.keys(cells);
  if(!keys.length||keys.some(k=>typeof baseline[k]!=='string'||!/^[a-f0-9]{64}$/.test(baseline[k]!)))return false;
  for(const k of keys)if(await digestLedgerCell(cells[k]!)!==baseline[k])return false;
  return true;
}
function sourcePredicate(p:LedgerSourceProof):{sql:string;args:unknown[]}{
  const idPattern=p.kind==='PERSONAL_USE'?/^personal_[A-Za-z0-9_-]{1,128}$/:/^exp_[A-Za-z0-9_-]{1,128}$/;
  if(!idPattern.test(p.id)||!Number.isSafeInteger(p.version)||p.version<1||!Number.isSafeInteger(p.amountSatang)||p.amountSatang<1||!['CONFIRMED','CANCELLED'].includes(p.status))throw new Error('LEDGER_SOURCE_INVALID');
  if(p.kind==='EXPENSE')return {sql:`EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=? AND e.version=? AND e.status=? AND e.transaction_date=? AND e.description=? AND e.amount_satang=? AND e.payment_key=? AND e.source_wallet=? AND e.category=? AND e.updated_at IS ?)`,args:[p.id,p.version,p.status,p.transactionDate,p.description,p.amountSatang,p.paymentKey,p.sourceWallet,p.category,p.updatedAt]};
  if(p.kind==='PERSONAL_USE')return {sql:`EXISTS(SELECT 1 FROM owner_personal_transactions p WHERE p.personal_use_id=? AND p.version=? AND p.status=? AND p.transaction_date=? AND p.description=? AND p.amount_satang=? AND p.transaction_type=? AND p.source_wallet=? AND p.updated_at IS ?)`,args:[p.id,p.version,p.status,p.transactionDate,p.description,p.amountSatang,p.transactionType,p.sourceWallet,p.updatedAt]};
  if(!/^item_[A-Za-z0-9_-]{1,128}$/.test(p.itemId)||!p.documentId||!Number.isSafeInteger(p.validItemCount)||p.validItemCount<1||!Number.isSafeInteger(p.totalLineSatang)||!p.firstItemId)throw new Error('LEDGER_SOURCE_INVALID');
  // Guard all fields used to build the row, including the document-wide
  // adjustment aggregate and first item. Item rows do not have a version.
  const valid=`j.expense_id=e.expense_id AND j.document_id=d.document_id AND length(trim(j.item_id))>0 AND length(trim(j.description))>0`;
  return {sql:`EXISTS(SELECT 1 FROM expense_events e JOIN expense_documents d ON d.document_id=? JOIN expense_document_items i ON i.document_id=d.document_id AND i.expense_id=e.expense_id
    WHERE e.expense_id=? AND e.version=? AND e.status=? AND e.transaction_date=? AND e.description=? AND e.amount_satang=? AND e.category=? AND e.branch_id IS ? AND e.created_at IS ? AND e.updated_at IS ?
    AND d.document_type=? AND d.document_date IS ? AND d.vendor_name IS ? AND d.legal_vendor_name IS ? AND d.document_number IS ? AND d.order_id IS ? AND d.updated_at IS ?
    AND i.item_id=? AND i.description=? AND i.quantity IS ? AND i.unit IS ? AND i.unit_price_satang IS ? AND i.discount_satang IS ? AND i.line_total_satang IS ? AND i.updated_at IS ?
    AND d.document_id=(SELECT l.document_id FROM expense_document_links l WHERE l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' ORDER BY l.created_at ASC LIMIT 1)
    AND (SELECT count(*) FROM expense_document_items j WHERE ${valid})=?
    AND (SELECT COALESCE(sum(CASE WHEN typeof(j.line_total_satang)='integer' AND abs(j.line_total_satang)<=9007199254740991 THEN j.line_total_satang ELSE 0 END),0) FROM expense_document_items j WHERE ${valid})=?
    AND (SELECT j.item_id FROM expense_document_items j WHERE ${valid} ORDER BY j.created_at ASC,j.item_id ASC LIMIT 1)=?)`,args:[p.documentId,p.id,p.version,p.status,p.transactionDate,p.description,p.amountSatang,p.category,p.branchId,p.createdAt,p.updatedAt,p.documentType,p.documentDate,p.vendorName,p.legalVendorName,p.documentNumber,p.orderId,p.documentUpdatedAt,p.itemId,p.itemDescription,p.quantity,p.unit,p.unitPriceSatang,p.discountSatang,p.lineTotalSatang,p.itemUpdatedAt,p.validItemCount,p.totalLineSatang,p.firstItemId]};
}
const journalKey=(p:LedgerSourceProof):string=>p.kind==='PURCHASE_DETAILS'?`${p.id}|${p.itemId}`:p.id;
const journalScope=(p:LedgerSourceProof):'CORE'|'ITEM'=>p.kind==='PURCHASE_DETAILS'?'ITEM':'CORE';

/** Never caches a physical row number; uncertain dispatches never auto-expire. */
export class LedgerStableJournal {
  constructor(private readonly env:Env,private readonly sheet:string,private readonly proof:LedgerSourceProof){}
  private async assertShadow():Promise<void>{
    const e=this.env;
    if(e.RUNTIME_MODE!=='shadow'||e.SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE!=='true'||!e.SHEETS_LEDGER_UAT_SPREADSHEET_ID||!e.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||e.SHEETS_LEDGER_UAT_SPREADSHEET_ID===e.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||e.GOOGLE_SPREADSHEET_ID!==e.SHEETS_LEDGER_UAT_SPREADSHEET_ID||!e.SHEETS_LEDGER_UAT_DATABASE_MARKER||!this.sheet)throw new Error('LEDGER_JOURNAL_DISABLED');
    try{const row=await e.DB.prepare('SELECT marker FROM ledger_stable_uat_guard WHERE marker=?').bind(e.SHEETS_LEDGER_UAT_DATABASE_MARKER).first();if(!row)throw new Error('missing');}
    catch{throw new Error('LEDGER_UAT_DATABASE_UNVERIFIED');}
  }
  /** Read the verified metadata and digest baseline, not a row address. */
  async getVerified(metadataId:number,projectedVersion:number):Promise<LedgerBaseline|null>{
    await this.assertShadow();const p=this.proof;
    const row=await this.env.DB.prepare(`SELECT baseline_json FROM ledger_stable_identity_journal WHERE spreadsheet_id=? AND sheet_name=? AND kind=? AND entity_key=? AND scope=? AND metadata_id=? AND state='VERIFIED' AND projected_version=?`).bind(this.env.GOOGLE_SPREADSHEET_ID,this.sheet,p.kind,journalKey(p),journalScope(p),metadataId,projectedVersion).first<{baseline_json:string|null}>();
    if(!row?.baseline_json)return null;
    try{const baseline=JSON.parse(row.baseline_json) as LedgerBaseline;canonicalLedgerBaseline(p.kind,baseline);return baseline;}catch{throw new Error('LEDGER_BASELINE_INVALID');}
  }
  /** Transition only a previously verified identity with exact old baseline. */
  async beginUpdate(metadataId:number,projectedVersion:number,baseline:LedgerBaseline,token:string):Promise<boolean>{
    await this.assertShadow();const p=this.proof,old=canonicalLedgerBaseline(p.kind,baseline),source=sourcePredicate(p);
    if(!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647||!Number.isSafeInteger(projectedVersion)||projectedVersion<1||p.version<=projectedVersion||!/^[-A-Za-z0-9_]{16,128}$/.test(token))return false;
    const now=new Date().toISOString();
    const result=await this.env.DB.prepare(`UPDATE ledger_stable_identity_journal SET state='IN_FLIGHT',source_version=?,intent_token=?,updated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND kind=? AND entity_key=? AND scope=? AND metadata_id=? AND state='VERIFIED' AND projected_version=? AND baseline_json=? AND ${source.sql}`).bind(p.version,token,now,this.env.GOOGLE_SPREADSHEET_ID,this.sheet,p.kind,journalKey(p),journalScope(p),metadataId,projectedVersion,old,...source.args).run();
    return Number(result.meta.changes||0)===1;
  }
  /** Only call after exact Sheets postimage; caller must ensure source is still current. */
  async finish(metadataId:number,token:string,baseline:LedgerBaseline):Promise<boolean>{
    await this.assertShadow();const p=this.proof,next=canonicalLedgerBaseline(p.kind,baseline),source=sourcePredicate(p),now=new Date().toISOString();
    const result=await this.env.DB.prepare(`UPDATE ledger_stable_identity_journal SET state='VERIFIED',projected_version=?,baseline_json=?,intent_token=NULL,updated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND kind=? AND entity_key=? AND scope=? AND metadata_id=? AND state='IN_FLIGHT' AND source_version=? AND intent_token=? AND ${source.sql}`).bind(p.version,next,now,this.env.GOOGLE_SPREADSHEET_ID,this.sheet,p.kind,journalKey(p),journalScope(p),metadataId,p.version,token,...source.args).run();
    return Number(result.meta.changes||0)===1;
  }
  /** Check the exact source and in-flight token again immediately before dispatch. */
  async canDispatch(metadataId:number,token:string):Promise<boolean>{
    await this.assertShadow();const p=this.proof,source=sourcePredicate(p);
    const row=await this.env.DB.prepare(`SELECT 1 AS ok FROM ledger_stable_identity_journal WHERE spreadsheet_id=? AND sheet_name=? AND kind=? AND entity_key=? AND scope=? AND metadata_id=? AND state='IN_FLIGHT' AND source_version=? AND intent_token=? AND ${source.sql}`).bind(this.env.GOOGLE_SPREADSHEET_ID,this.sheet,p.kind,journalKey(p),journalScope(p),metadataId,p.version,token,...source.args).first<{ok:number}>();
    return !!row;
  }
  /** Retain ambiguity. REVIEW cannot be resumed automatically. */
  async hold(metadataId:number,token:string):Promise<boolean>{
    await this.assertShadow();const p=this.proof;
    const result=await this.env.DB.prepare(`UPDATE ledger_stable_identity_journal SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND kind=? AND entity_key=? AND scope=? AND metadata_id=? AND state='IN_FLIGHT' AND intent_token=?`).bind(new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.sheet,p.kind,journalKey(p),journalScope(p),metadataId,token).run();
    return Number(result.meta.changes||0)===1;
  }
}
