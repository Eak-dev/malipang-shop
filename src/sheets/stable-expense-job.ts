import type {Env,SheetsSyncJob} from '../types';
import {readStableExpenseSource} from './stable-expense-source';
import {planStableExpenseProjections} from './stable-expense-projection-plan';
import {writeNewExpenseLedgerUnderClaim} from './stable-expense-ledger-writer';
import {StableDailyCapacityError,writeNewDailyUnderClaim} from './stable-daily-writer';
import {newStableSourcePredicate,stableSourceIntegrity} from './stable-source-cutover';
import {withStableWorkbookClaim} from './stable-workbook-claim';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';
import {verifyStableExpenseProjections} from './stable-expense-final-check';

/** Phase-one candidate. The daily preflight happens first so a full month can
 * be held without writing RAW or details. No route calls this yet. */
export async function runStableExpenseJob(env:Env,job:SheetsSyncJob,lease:string):Promise<'COMPLETED'|'CONTINUE'|'CAPACITY_REVIEW'>{
 return withStableWorkbookClaim(env,async claim=>{
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,source=await readStableExpenseSource(env,job,lease,claim);if(!source)throw Error('STABLE_EXPENSE_SOURCE_UNVERIFIED');
  const projections=planStableExpenseProjections(source);
  const recorded=await db.prepare("SELECT entity_id,projection,sheet_id,sheet_name,source_version,source_digest,state FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|')").bind(book,job.entityKey,job.entityKey,job.entityKey).all<{entity_id:string;projection:string;sheet_id:number;sheet_name:string;source_version:number;source_digest:string;state:string}>();
  if(recorded.success!==true||!Array.isArray(recorded.results))throw Error('STABLE_EXPENSE_JOURNAL_UNVERIFIED');
  const journals=recorded.results,expected=[{id:job.entityKey,projection:'DAILY'},{id:job.entityKey,projection:'EXPENSE_RAW'},...projections.details.map(item=>({id:`${job.entityKey}|${item.itemId}`,projection:'DETAIL'}))];
  if(journals.some(j=>j.state!=='VERIFIED'||j.source_version!==job.entityVersion||j.source_digest!==source.digest||!expected.some(e=>e.id===j.entity_id&&e.projection===j.projection)))throw Error('STABLE_EXPENSE_JOURNAL_CONFLICT');
  const missing=expected.find(e=>!journals.some(j=>j.entity_id===e.id&&j.projection===e.projection));
  try{
   if(missing?.projection==='DAILY')await writeNewDailyUnderClaim(env,job,lease,claim,source);
   else if(missing?.projection==='EXPENSE_RAW')await writeNewExpenseLedgerUnderClaim(env,job,lease,claim,source,'EXPENSE_RAW');
   else if(missing?.projection==='DETAIL')await writeNewExpenseLedgerUnderClaim(env,job,lease,claim,source,'DETAIL',missing.id.slice(job.entityKey.length+1));
  }catch(error){
   if(!(error instanceof StableDailyCapacityError))throw error;
   // A capacity failure may also arise during the final recheck, after an
   // intent was reserved. Only release when no intent exists at all.
   const intent=await db.prepare("SELECT 1 AS present FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|') LIMIT 1").bind(book,job.entityKey,job.entityKey,job.entityKey).first<{present:number}>();
   if(intent)throw error;
   const held=await db.prepare("UPDATE sync_jobs SET status='REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error='STABLE_DAILY_CAPACITY' WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?").bind(job.entityKey,job.entityVersion,lease).run();
   if(held.success!==true||Number(held.meta?.changes)!==1)throw Error('STABLE_CAPACITY_HOLD_UNCERTAIN');
   return 'CAPACITY_REVIEW';
  }
  if(missing){
   // A verified projection is durable before yielding. A new invocation gets
   // a fresh subrequest budget and rechecks source and every journal. Never
   // resume an ambiguous IN_FLIGHT write.
   const next=await db.prepare(`UPDATE sync_jobs SET status='PENDING',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error='STABLE_STAGE_CONTINUE' WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND ${stableSourceIntegrity} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.entity_id=? AND p.projection=? AND p.source_version=? AND p.source_digest=? AND p.state='VERIFIED')`).bind(job.entityKey,job.entityVersion,lease,source.revision,book,claim,book,missing.id,missing.projection,job.entityVersion,source.digest).run();
   if(next.success!==true||Number(next.meta?.changes)!==1)throw Error('STABLE_EXPENSE_CONTINUE_UNCERTAIN');
   return 'CONTINUE';
  }
  await verifyStableExpenseProjections(env,job,source,journals);
  const latest=await readStableExpenseSource(env,job,lease,claim);if(!latest||latest.revision!==source.revision||latest.digest!==source.digest||latest.fingerprint!==source.fingerprint)throw Error('STABLE_EXPENSE_SOURCE_CHANGED');
  if(!await stableWorkbookClaimOwned(env,claim))throw Error('STABLE_EXPENSE_CLAIM_CHANGED');
  const itemKeys=JSON.stringify(projections.details.map(item=>`${job.entityKey}|${item.itemId}`));
  const completed=await db.prepare(`UPDATE sync_jobs SET status='COMPLETED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=NULL
   WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND ${stableSourceIntegrity}
   AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?)
   AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')
   AND ${newStableSourcePredicate('EXPENSE')}
   AND (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.entity_id=? AND p.projection IN ('DAILY','EXPENSE_RAW') AND p.source_version=? AND p.source_digest=? AND p.state='VERIFIED')=2
   AND (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.projection='DETAIL' AND p.entity_id IN (SELECT value FROM json_each(?)) AND p.source_version=? AND p.source_digest=? AND p.state='VERIFIED')=?`)
   .bind(job.entityKey,job.entityVersion,lease,source.revision,book,claim,job.entityKey,book,job.entityKey,job.entityVersion,source.digest,book,itemKeys,job.entityVersion,source.digest,projections.details.length).run();
  if(completed.success!==true||Number(completed.meta?.changes)!==1)throw Error('STABLE_EXPENSE_COMPLETION_UNCERTAIN');
  return 'COMPLETED';
 });
}
