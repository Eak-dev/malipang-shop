import type {Env,SheetsSyncJob} from '../types';
import {newStableSourcePredicate,stableSourceIntegrity} from './stable-source-cutover';

type Row=Record<string,unknown>;
export interface StableExpenseSource {expense:Row;links:Row[];documents:Row[];items:Row[];revision:number;fingerprint:string;digest:string;}

/** One transactional snapshot, including all documents and item rows which
 * can affect the expense's projections. It is not Sheets write authority. */
export async function readStableExpenseSource(env:Env,job:SheetsSyncJob,lease:string,claim:string):Promise<StableExpenseSource|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<1||!book||!lease||!claim)return null;
 const statements=[
  db.prepare(`SELECT e.*,r.revision AS __stable_revision FROM expense_events e CROSS JOIN stable_source_revision r WHERE r.singleton=1 AND ${stableSourceIntegrity} AND e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND ${newStableSourcePredicate('EXPENSE')} AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')`).bind(job.entityKey,job.entityVersion,job.entityKey,lease,book,claim),
  db.prepare('SELECT * FROM expense_document_links WHERE expense_id=? ORDER BY link_id').bind(job.entityKey),
  db.prepare('SELECT * FROM expense_documents WHERE expense_id=? OR document_id IN (SELECT document_id FROM expense_document_links WHERE expense_id=?) ORDER BY document_id').bind(job.entityKey,job.entityKey),
  db.prepare('SELECT * FROM expense_document_items WHERE expense_id=? ORDER BY created_at,item_id').bind(job.entityKey)
 ];
 try{
  const result=await db.batch(statements);if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||result.length!==statements.length||result.some(r=>r.success!==true||!Array.isArray(r.results))||result[0]!.results!.length!==1)return null;
  const {__stable_revision:revision,...expense}=result[0]!.results![0] as Row,links=result[1]!.results as Row[],documents=result[2]!.results as Row[],items=result[3]!.results as Row[];
  if(!Number.isSafeInteger(revision)||Number(revision)<0||links.length>500||documents.length>500||items.length>500)return null;
  const primary=links.filter(x=>x.relation_type==='PRIMARY_PURCHASE_DOCUMENT');if(primary.length>1||primary.some(x=>!documents.some(d=>d.document_id===x.document_id)))return null;
  if(!primary.length&&documents.filter(d=>d.expense_id===job.entityKey).length>1)return null;
  const fingerprint=JSON.stringify({expense,links,documents,items});if(new TextEncoder().encode(fingerprint).byteLength>256000)return null;
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fingerprint))),v=>v.toString(16).padStart(2,'0')).join('');
  return {expense,links,documents,items,revision:Number(revision),fingerprint,digest};
 }catch{return null;}
}
