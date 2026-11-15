import type {Env,SheetsSyncJob} from '../types';
import {stableSourceIntegrity} from './stable-source-cutover';

/** Read-only evidence for a CANCELLED expense, including records reachable
 * through linked documents. The global revision is read in the same D1
 * transaction and must be compared again by the caller's write CAS. */
export async function readCancelledExpenseSource(env:Env,job:SheetsSyncJob,claim:string,lease?:string):Promise<{revision:number;digest:string}|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,review=lease===undefined;
 if(!book||!claim||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<2||!review&&!lease)return null;
 const state=review?"j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))":"j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')";
 const args:unknown[]=[job.entityKey,job.entityVersion];if(!review)args.push(lease);args.push(book,claim,review?'REVIEW':'HELD');
 const docs="SELECT d.document_id FROM expense_documents d WHERE d.expense_id=? OR d.document_id IN (SELECT l.document_id FROM expense_document_links l WHERE l.expense_id=?)";
 const statements=[
  db.prepare(`SELECT e.*,r.revision AS __stable_revision FROM expense_events e CROSS JOIN stable_source_revision r WHERE r.singleton=1 AND ${stableSourceIntegrity} AND e.expense_id=? AND e.version=? AND e.status='CANCELLED' AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND ${state}) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state=?)`).bind(...args),
  db.prepare('SELECT * FROM expense_document_links WHERE expense_id=? ORDER BY link_id').bind(job.entityKey),
  db.prepare(`SELECT * FROM expense_documents WHERE document_id IN (${docs}) ORDER BY document_id`).bind(job.entityKey,job.entityKey),
  db.prepare(`SELECT * FROM expense_document_items WHERE expense_id=? OR document_id IN (${docs}) ORDER BY item_id`).bind(job.entityKey,job.entityKey,job.entityKey)
 ];
 try{
  const results=await db.batch(statements);if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||results.length!==4||results.some(r=>r.success!==true||!Array.isArray(r.results))||results[0]!.results!.length!==1)return null;
  const {__stable_revision:revision,...expense}=results[0]!.results![0] as Record<string,unknown>,links=results[1]!.results!,documents=results[2]!.results!,items=results[3]!.results!;
  if(!Number.isSafeInteger(revision)||Number(revision)<0||links.length>500||documents.length>500||items.length>500)return null;
  const bytes=new TextEncoder().encode(JSON.stringify({expense,links,documents,items}));if(bytes.byteLength>256000)return null;
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  return {revision:Number(revision),digest};
 }catch{return null;}
}
