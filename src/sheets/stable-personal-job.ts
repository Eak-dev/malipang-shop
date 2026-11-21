import type {Env,SheetsSyncJob} from '../types';
import {writeNewPersonalUnderClaim} from './stable-personal-writer';
import {newStableSourcePredicate,stableSourceIntegrity} from './stable-source-cutover';
import {withStableWorkbookClaim} from './stable-workbook-claim';

/** Unrouted candidate. A durable claim stays held on uncertain outcomes. */
export async function runStablePersonalJob(env:Env,job:SheetsSyncJob,lease:string):Promise<void>{
 await withStableWorkbookClaim(env,async claim=>{
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,proof=await writeNewPersonalUnderClaim(env,job,lease,claim);
  const result=await db.prepare(`UPDATE sync_jobs SET status='COMPLETED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=NULL
   WHERE entity_type='PERSONAL_USE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND ${stableSourceIntegrity}
   AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?)
   AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')
   AND ${newStableSourcePredicate('PERSONAL_USE')}
   AND EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='PERSONAL_USE' AND p.entity_id=? AND p.projection='PERSONAL_RAW' AND p.source_version=? AND p.source_digest=? AND p.state='VERIFIED')`)
   .bind(job.entityKey,job.entityVersion,lease,proof.revision,book,claim,job.entityKey,book,job.entityKey,job.entityVersion,proof.digest).run();
  if(result.success!==true||Number(result.meta?.changes)!==1)throw Error('STABLE_PERSONAL_COMPLETION_UNCERTAIN');
 },job);
}
