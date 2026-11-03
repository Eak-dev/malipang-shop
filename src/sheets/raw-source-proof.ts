import type {Env} from '../types';
import {buildExpenseRawSheetValues,buildPersonalUseRawSheetValues} from './raw-projection';
import type {LedgerCellState} from './ledger-metadata-writer';

export type RawProofKind='EXPENSE'|'PERSONAL_USE';
export interface RawSourceProof{kind:RawProofKind;entityId:string;version:number;values:readonly (string|number|boolean|null)[];fingerprint:string;}
type Row=Record<string,unknown>;
const normalize=(value:unknown):string|number|boolean|null=>{
  if(value===null||value===undefined)return null;
  if(typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return value;
  throw Error('RAW_SOURCE_PROJECTION_INVALID');
};
const validId=(value:string,kind:RawProofKind)=>kind==='EXPENSE'?/^exp_[A-Za-z0-9_-]{1,128}$/.test(value):/^personal_[A-Za-z0-9_-]{1,128}$/.test(value);
async function fingerprint(value:unknown):Promise<string>{
  const data=new TextEncoder().encode(JSON.stringify(value));if(data.length>131072)throw Error('RAW_SOURCE_PROJECTION_TOO_LARGE');
  const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',data));
  return Array.from(digest,b=>b.toString(16).padStart(2,'0')).join('');
}

/**
 * Read-only source snapshot for eventual identity-based RAW sync. All fields
 * written to the RAW row are captured, including document and submitter data.
 * A single D1 SELECT observes expense and document together. Ambiguous primary
 * links or fallback documents are held instead of choosing arbitrarily.
 * This is not a Sheets lock, database-to-Sheets transaction, or an ABA-proof
 * immutable source revision. Do not log or persist values/fingerprint as if
 * hashing were confidentiality; caller must recheck its operation lease.
 */
export async function readRawSourceProof(env:Env,kind:RawProofKind,entityId:string,version:number):Promise<RawSourceProof>{
  if(!['EXPENSE','PERSONAL_USE'].includes(kind)||typeof entityId!=='string'||!validId(entityId,kind)||!Number.isSafeInteger(version)||version<1)throw Error('RAW_SOURCE_PROOF_INVALID');
  let row:Row|null,values:unknown[],provenance:unknown[];
  if(kind==='PERSONAL_USE'){
    row=await env.DB.prepare('SELECT * FROM owner_personal_transactions WHERE personal_use_id=?').bind(entityId).first<Row>();
    if(!row)throw Error('RAW_SOURCE_UNAVAILABLE');
    values=buildPersonalUseRawSheetValues(row);provenance=[row.updated_at];
  }else{
    row=await env.DB.prepare(`SELECT e.*,
      (SELECT count(*) FROM expense_document_links l JOIN expense_documents x ON x.document_id=l.document_id WHERE l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT') AS __stable_primary_count,
      (SELECT count(*) FROM expense_documents x WHERE x.expense_id=e.expense_id) AS __stable_fallback_count,
      (SELECT l.link_id FROM expense_document_links l JOIN expense_documents x ON x.document_id=l.document_id WHERE l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' ORDER BY l.created_at ASC LIMIT 1) AS __stable_link_id,
      d.document_id AS __stable_doc_id,d.document_type AS __stable_doc_type,d.vendor_name AS __stable_doc_vendor,d.document_number AS __stable_doc_number,d.order_id AS __stable_doc_order,d.updated_at AS __stable_doc_updated
      FROM expense_events e LEFT JOIN expense_documents d ON d.document_id=COALESCE(
        (SELECT l.document_id FROM expense_document_links l JOIN expense_documents x ON x.document_id=l.document_id WHERE l.expense_id=e.expense_id AND l.relation_type='PRIMARY_PURCHASE_DOCUMENT' ORDER BY l.created_at ASC LIMIT 1),
        (SELECT x.document_id FROM expense_documents x WHERE x.expense_id=e.expense_id ORDER BY x.created_at ASC LIMIT 1))
      WHERE e.expense_id=?`).bind(entityId).first<Row>();
    if(!row)throw Error('RAW_SOURCE_UNAVAILABLE');
    const primary=Number(row.__stable_primary_count),fallback=Number(row.__stable_fallback_count);
    if(!Number.isSafeInteger(primary)||!Number.isSafeInteger(fallback)||primary>1||primary===0&&fallback>1)throw Error('RAW_SOURCE_DOCUMENT_AMBIGUOUS');
    const doc=row.__stable_doc_id==null?null:{document_id:row.__stable_doc_id,document_type:row.__stable_doc_type,vendor_name:row.__stable_doc_vendor,document_number:row.__stable_doc_number,order_id:row.__stable_doc_order};
    values=buildExpenseRawSheetValues(row,doc);provenance=[row.updated_at,row.__stable_link_id,row.__stable_doc_updated,primary,fallback];
  }
  if(Number(row.version)!==version||!['CONFIRMED','CANCELLED'].includes(String(row.status)))throw Error('RAW_SOURCE_VERSION_OR_STATUS_CHANGED');
  if(!Number.isSafeInteger(row.amount_satang)||Number(row.amount_satang)<1)throw Error('RAW_SOURCE_AMOUNT_INVALID');
  const normalized=values.map(normalize),safeProvenance=provenance.map(normalize);
  if(normalized[0]!==entityId)throw Error('RAW_SOURCE_ID_MISMATCH');
  return{kind,entityId,version,values:normalized,fingerprint:await fingerprint([kind,entityId,version,normalized,safeProvenance])};
}
/** Returns false on a changed or unavailable source. Never logs row contents. */
export async function rawSourceStillMatches(env:Env,expected:RawSourceProof):Promise<boolean>{
  try{const current=await readRawSourceProof(env,expected.kind,expected.entityId,expected.version);return current.fingerprint===expected.fingerprint&&JSON.stringify(current.values)===JSON.stringify(expected.values);}catch{return false;}
}
/** Compare every user-entered value of the target RAW row; this deliberately
 * does not attest to metadata identity, editor exclusivity, styles or a lease. */
export function rawProjectionValuesMatch(expected:RawSourceProof,cells:readonly LedgerCellState[]):boolean{
  const size=expected.kind==='EXPENSE'?17:expected.kind==='PERSONAL_USE'?15:0;
  if(!size||!Array.isArray(expected.values)||expected.values.length!==size||!Array.isArray(cells)||cells.length!==size)return false;
  return cells.every((cell,i)=>{
    if(!cell||cell.formula!==null||!('entered' in cell))return false;
    const desired=expected.values[i];return desired===''?cell.entered===null||cell.entered==='':desired===cell.entered;
  });
}
