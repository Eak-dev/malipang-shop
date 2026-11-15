import type {Env,SheetsSyncJob} from '../types';
import {newStableSourcePredicate,stableSourceIntegrity} from './stable-source-cutover';

type Row=Record<string,unknown>;
export interface StableExpenseSource {expense:Row;links:Row[];documents:Row[];items:Row[];revision:number;fingerprint:string;digest:string;}

/** One transactional snapshot, including all documents and item rows which
 * can affect the expense's projections. It is not Sheets write authority. */
export async function readStableExpenseSource(env:Env,job:SheetsSyncJob,lease:string,claim:string):Promise<StableExpenseSource|null>{
 return readSource(env,job,claim,{kind:'leased',lease});
}

/** Read only the exact reviewed daily operation. This does not admit a job,
 * change a claim or authorize a provider request. */
export async function readReviewedDailyExpenseSource(env:Env,job:SheetsSyncJob,claim:string):Promise<StableExpenseSource|null>{
 return readSource(env,job,claim,{kind:'review'});
}

async function readSource(env:Env,job:SheetsSyncJob,claim:string,mode:{kind:'leased';lease:string}|{kind:'review'}):Promise<StableExpenseSource|null>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<1||!book||!claim||mode.kind==='leased'&&!mode.lease)return null;
 const authority=mode.kind==='leased'
  ?`EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')`
  :`EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))) AND EXISTS(SELECT 1 FROM stable_workbook_claims c JOIN stable_recovery_epochs epoch ON epoch.spreadsheet_id=c.spreadsheet_id JOIN stable_recovery_operations op ON op.epoch_id=epoch.epoch_id AND op.operation_token=c.operation_token JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=e.expense_id AND p.projection='DAILY' AND p.source_version=e.version AND p.operation_token=c.operation_token JOIN continuous_daily_write_evidence proof ON proof.spreadsheet_id=p.spreadsheet_id AND proof.entity_id=p.entity_id AND proof.source_version=p.source_version AND proof.operation_token=p.operation_token WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='REVIEW' AND c.phase='OPERATION' AND epoch.state IN ('ARMED','REVIEW') AND epoch.target_type='EXPENSE' AND epoch.target_key=e.expense_id AND epoch.target_version=e.version AND op.state='ADMITTED' AND p.state='IN_FLIGHT')`;
 const args=mode.kind==='leased'?[job.entityKey,job.entityVersion,job.entityKey,mode.lease,book,claim]:[job.entityKey,job.entityVersion,job.entityKey,book,claim];
 const statements=[
  db.prepare(`SELECT e.*,r.revision AS __stable_revision FROM expense_events e CROSS JOIN stable_source_revision r WHERE r.singleton=1 AND ${stableSourceIntegrity} AND e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND ${newStableSourcePredicate('EXPENSE')} AND ${authority}`).bind(...args),
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
