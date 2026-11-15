import type {Env,SheetsSyncJob} from '../types';
import {reviewedJobState,reviewedClaimState,type NormalNoticeAuthority} from './normal-notice-authority';
import {stableSourceIntegrity} from './stable-source-cutover';
import {cancelledFinancialFingerprint,cancelledJournalRevisionSnapshot,cancelledPriorMarker,cancelledPriorMarkerSnapshot,cancelledProjectionSnapshot} from './cancelled-financial-fingerprint';
import {cancellationProtocol} from './cancelled-protocol';

/** Read-only evidence for a CANCELLED expense, including records reachable
 * through linked documents. The global revision is read in the same D1
 * transaction and must be compared again by the caller's write CAS. */
export async function readCancelledExpenseSource(env:Env,job:SheetsSyncJob,claim:string,lease?:string,authority:NormalNoticeAuthority='REVIEW'):Promise<{revision:number;digest:string;financialJournalRevision?:number}|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,review=lease===undefined;
 if(!book||!claim||job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<2||!review&&!lease)return null;
 const state=review?reviewedJobState('j',authority):"j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')";
 const args:unknown[]=[job.entityKey,job.entityVersion];if(!review)args.push(lease);args.push(book,claim);
 const claimState=review?reviewedClaimState('c',authority):"c.state='HELD'";
 const docs="SELECT d.document_id FROM expense_documents d WHERE d.expense_id=? OR d.document_id IN (SELECT l.document_id FROM expense_document_links l WHERE l.expense_id=?)";
 let protocol;try{protocol=await cancellationProtocol(env,job);}catch{return null;}if(!protocol)return null;const financial=protocol.financial;
 const expenseStatement=db.prepare(`SELECT e.*,r.revision AS __stable_revision FROM expense_events e CROSS JOIN stable_source_revision r WHERE r.singleton=1 AND ${stableSourceIntegrity} AND e.expense_id=? AND e.version=? AND e.status='CANCELLED' AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND ${state}) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND ${claimState})`).bind(...args);
 const statements=financial?[expenseStatement,cancelledProjectionSnapshot(env,job),cancelledPriorMarkerSnapshot(env,job),cancelledJournalRevisionSnapshot(env)]:[
  expenseStatement,
  db.prepare('SELECT * FROM expense_document_links WHERE expense_id=? ORDER BY link_id').bind(job.entityKey),
  db.prepare(`SELECT * FROM expense_documents WHERE document_id IN (${docs}) ORDER BY document_id`).bind(job.entityKey,job.entityKey),
  db.prepare(`SELECT * FROM expense_document_items WHERE expense_id=? OR document_id IN (${docs}) ORDER BY item_id`).bind(job.entityKey,job.entityKey,job.entityKey)
 ];
 try{
  const results=await db.batch(statements);if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||results.length!==4||results.some(r=>r.success!==true||!Array.isArray(r.results))||results[0]!.results!.length!==1)return null;
  const {__stable_revision:revision,...expense}=results[0]!.results![0] as Record<string,unknown>;
  if(financial){const priorRows=results[2]!.results!,revisions=results[3]!.results!,prior=priorRows.length===1?cancelledPriorMarker(job,priorRows[0] as Record<string,unknown>):null,journalRevision=(revisions[0] as {revision?:unknown}|undefined)?.revision;if(!prior||revisions.length!==1||!Number.isSafeInteger(revision)||Number(revision)<0||!Number.isSafeInteger(journalRevision)||Number(journalRevision)<0)return null;const digest=await cancelledFinancialFingerprint(job,expense,results[1]!.results as Record<string,unknown>[],prior),latest=await cancellationProtocol(env,job);return digest&&latest?.signature===protocol.signature&&env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book?{revision:Number(revision),digest,financialJournalRevision:Number(journalRevision)}:null;}
  const links=results[1]!.results!,documents=results[2]!.results!,items=results[3]!.results!;
  if(!Number.isSafeInteger(revision)||Number(revision)<0||links.length>500||documents.length>500||items.length>500)return null;
  const bytes=new TextEncoder().encode(JSON.stringify({expense,links,documents,items}));if(bytes.byteLength>256000)return null;
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
  const latest=await cancellationProtocol(env,job);return latest?.signature===protocol.signature&&env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book?{revision:Number(revision),digest}:null;
 }catch{return null;}
}
