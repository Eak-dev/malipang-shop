import type {Env,SheetsSyncJob} from '../types';
import {normalNoticeHandoffEnabled,hasNormalNoticeHandoff,finishFinalNormalStage} from './continuous-normal-notice-handoff';
import {assertContinuousDailyActivated,continuousDailyTarget} from './continuous-daily-route';
import {continuousDailyCutoverIntegrity,continuousReportCutoverIntegrity,continuousAdmissionIntegrity} from './continuous-daily-cutover';
import {stableSourceIntegrity,newStableSourcePredicate} from './stable-source-cutover';
import {stableWorkbookClaimOwned,withStableWorkbookClaim} from './stable-workbook-claim';
import {cancelAtomicDailyCandidateUnderClaim} from './atomic-daily-cancellation-candidate';
import {cancelCarrierLedgerUnderClaim} from './atomic-expense-ledger-cancellation';
import {resolveCarrierLedgerTarget} from './atomic-expense-ledger-writer';
import {verifyStableCancellationFinal,type CancelProjection,type CancelWrite} from './stable-cancellation-final-check';
import {resolvePublicationTarget} from './continuous-publication-route';
import {publicationOperationUnderClaim} from './continuous-publication-operation';
import {publicationHandoffHooks} from './publication-handoff-hooks';
import {decodePublicationCarrier} from './continuous-publication-template';
import {readCancelledExpenseSource} from './cancelled-expense-source';
import type {PublicationAccountingTarget} from './publication-accounting-evidence';
import {ReviewRequestBudget} from './review-request-budget';
import {continuousSheetsReadPolicy,getSpreadsheetSheetProperties} from './client';
import {readPublicationAccountingEvidence} from './publication-accounting-evidence';
import {planPublicationSnapshot} from './publication-snapshot-plan';
import {capturePublicationBatchSnapshot} from './publication-batch-snapshot';

/** New, post-cutover carrier projections only. An unknown prior intent, a
 * legacy row, a version gap or absent DAILY projection remains REVIEW. This
 * function does not release an existing review claim or prove legacy writer
 * exclusion; those are rollout prerequisites. */
export async function runStableExpenseCancellationJob(env:Env,job:SheetsSyncJob,lease:string,invocationBudget?:ReviewRequestBudget):Promise<'CONTINUE'|'COMPLETED'>{
 const dailyTarget=await assertContinuousDailyActivated(env);if(!dailyTarget)throw Error('CANCEL_JOB_DISABLED');
 const publicationTarget=await resolvePublicationTarget(env);if(publicationTarget&&env.CONTINUOUS_PUBLICATION_ENABLED==='true')throw Error('PUBLICATION_UNDO_HANDOFF_UNAVAILABLE');
 if(job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(job.entityKey)||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<2||!lease)throw Error('CANCEL_JOB_INVALID');
 return withStableWorkbookClaim(env,async claim=>{
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,identity=JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
  const scope=()=>JSON.stringify([env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.STABLE_PHASE1_ENABLED,env.STABLE_CANCELLATION_PREIMAGE_ENABLED,env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED,env.CONTINUOUS_REVIEW_CLOSE_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS,env.APP_ENV,env.RUNTIME_MODE]);const initial=scope();
  const stable=()=>env.DB===db&&scope()===initial&&identity===JSON.stringify([job.kind,job.entityType,job.entityKey,job.entityVersion]);
  const integrity=`${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousReportCutoverIntegrity} AND ${continuousAdmissionIntegrity} AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND ((tbl_name='stable_expense_projection_preimages' AND name IN ('stable_expense_preimage_verified_source','stable_expense_preimage_no_update','stable_expense_preimage_no_delete','stable_expense_preimage_no_replace')) OR (tbl_name='stable_expense_cancellation_writes' AND name IN ('stable_expense_cancel_preimage_required','stable_expense_cancel_no_delete','stable_expense_cancel_no_replace','stable_expense_cancel_transition')) OR (tbl_name='stable_daily_cancellation_metadata' AND name IN ('stable_daily_cancel_meta_bound','stable_daily_cancel_meta_no_update','stable_daily_cancel_meta_no_delete','stable_daily_cancel_meta_no_replace')) OR (tbl_name='atomic_daily_marker_reservations' AND name IN ('atomic_daily_marker_no_update','atomic_daily_marker_no_delete','atomic_daily_marker_no_replace'))))=15`;
  const sourceGuard=`${integrity} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version JOIN continuous_daily_cutovers cut ON cut.spreadsheet_id=? AND cut.state='ACTIVE' WHERE e.expense_id=? AND e.version=? AND e.status='CANCELLED' AND e.updated_at=? AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND (EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses post WHERE post.spreadsheet_id=cut.spreadsheet_id AND post.expense_id=e.expense_id) OR EXISTS(SELECT 1 FROM continuous_daily_source_admissions a JOIN stable_projection_writes prior ON prior.spreadsheet_id=a.spreadsheet_id AND prior.entity_type='EXPENSE' AND prior.entity_id=a.expense_id AND prior.projection='DAILY' AND prior.state='VERIFIED' AND prior.source_version=a.source_version AND prior.source_digest=a.source_digest WHERE a.spreadsheet_id=cut.spreadsheet_id AND a.expense_id=e.expense_id AND a.source_version=e.version-1)) AND cut.continuous_sheet_id=? AND cut.continuous_sheet_name=? AND cut.raw_sheet_id=? AND cut.raw_sheet_name=? AND cut.detail_sheet_id=? AND cut.detail_sheet_name=? AND (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=cut.spreadsheet_id AND a.stage IN ('DAILY_J','REPORTS','VIEWS') AND a.state='VERIFIED')=3)`;
  const targetNow=continuousDailyTarget(env);if(!book||!targetNow||targetNow.sheet!==dailyTarget.sheet||targetNow.sheetId!==dailyTarget.sheetId)throw Error('CANCEL_JOB_INVALID');
  const results=await db.batch([
   db.prepare(`SELECT e.version,e.status,e.updated_at,r.revision FROM expense_events e CROSS JOIN stable_source_revision r WHERE e.expense_id=? AND r.singleton=1`).bind(job.entityKey),
   db.prepare("SELECT entity_id,projection,sheet_id,sheet_name,source_version,source_digest,state,operation_token FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|')").bind(book,job.entityKey,job.entityKey,job.entityKey),
   db.prepare("SELECT entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state FROM stable_expense_cancellation_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|')").bind(book,job.entityKey,job.entityKey,job.entityKey)
  ]);
  if(!stable()||results.length!==3||results.some(r=>r.success!==true||!Array.isArray(r.results))||results[0]!.results!.length!==1)throw Error('CANCEL_JOB_READ');
  const source=results[0]!.results![0] as {version:number;status:string;updated_at:string;revision:number},projections=results[1]!.results as CancelProjection[],writes=results[2]!.results as CancelWrite[];
  if(source.status!=='CANCELLED'||source.version!==job.entityVersion||!Number.isSafeInteger(source.revision)||typeof source.updated_at!=='string'||projections.length>502||writes.length>projections.length)throw Error('CANCEL_JOB_SOURCE');
  const publicationBudget=publicationTarget?invocationBudget:undefined;
  let publication:PublicationAccountingTarget|undefined;
  const verifyPublicationTarget=async()=>JSON.stringify(await resolvePublicationTarget(env))===JSON.stringify(publicationTarget)&&stable();
  if(publicationTarget&&publicationBudget){
   const row=await db.prepare("SELECT marker,row_number FROM continuous_publication_markers WHERE spreadsheet_id=? AND entity_id=?").bind(book,job.entityKey).first<{marker:string;row_number:number}>();
   if(!row&&projections.length)throw Error('PUBLICATION_UNJOURNALED_CARRIER');
   if(row){
    const marker=decodePublicationCarrier(row.marker),cancelled=await readCancelledExpenseSource(env,job,claim,lease);
    if(!marker||!cancelled||cancelled.revision!==source.revision||marker.expenseId!==job.entityKey||!Number.isSafeInteger(row.row_number))throw Error('PUBLICATION_UNDO_SOURCE');
    if(marker.state!=='REVOKED'){
     if(marker.version!==job.entityVersion-1||!['STAGED','PUBLISHED'].includes(marker.state))throw Error('PUBLICATION_UNDO_MARKER');
     const revoked=await publicationOperationUnderClaim(env,'REVOKE',{job,lease,claim,sourceRevision:cancelled.revision,sourceDigest:cancelled.digest,detailCount:marker.detailCount,target:publicationTarget,budget:publicationBudget,verifyTarget:verifyPublicationTarget,verifyProjections:async()=>false,...publicationHandoffHooks(env,job,claim,lease,cancelled.revision,'REVOKE')});
     if(revoked.state!=='REVOKED'||!await hasNormalNoticeHandoff(env,claim,job))throw Error('PUBLICATION_REVOKE_HANDOFF_UNCERTAIN');
     return 'CONTINUE';
    }
    if(marker.version!==job.entityVersion)throw Error('PUBLICATION_UNDO_MARKER');
    publication={sheet:publicationTarget.sheetName,sheetId:publicationTarget.sheetId,rows:publicationTarget.rows,row:row.row_number,expected:marker,sourceDigest:cancelled.digest};
   }
  }
  // Only close an Undo with no provider activity when the original job is
  // still unleased and pending. A PROCESSING or unknown legacy writer must be
  // held: absence of a journal alone cannot prove an old request settled.
  if(projections.length===0){
   if(job.entityVersion!==2||writes.length)throw Error('CANCEL_JOB_EMPTY_REVIEW');
   const noWriteGuard=`${integrity} AND ${newStableSourcePredicate('EXPENSE')} AND EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1 AND revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD') AND EXISTS(SELECT 1 FROM expense_events e JOIN continuous_daily_cutovers cut ON cut.spreadsheet_id=? AND cut.state='ACTIVE' WHERE e.expense_id=? AND e.status='CANCELLED' AND e.version=2 AND e.updated_at=? AND cut.continuous_sheet_id=? AND cut.continuous_sheet_name=? AND cut.raw_sheet_id=? AND cut.raw_sheet_name=? AND cut.detail_sheet_id=? AND cut.detail_sheet_name=? AND (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=cut.spreadsheet_id AND a.stage IN ('VIEWS','DAILY_J','REPORTS') AND a.state='VERIFIED')=3 AND (EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses p WHERE p.spreadsheet_id=cut.spreadsheet_id AND p.expense_id=e.expense_id) OR (SELECT count(*) FROM continuous_daily_source_admissions a WHERE a.spreadsheet_id=cut.spreadsheet_id AND a.expense_id=e.expense_id AND a.source_version=1)=1)) AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|')) AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|')) AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=? OR substr(i.entity_key,1,length(?)+1)=?||'|') AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN' AND (f.job_key='EXPENSE:'||?||':1' OR f.job_key='EXPENSE:'||?||':2')) AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=? AND j.entity_version NOT IN (1,2)) AND EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=? AND j.entity_version=2 AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
   const id=job.entityKey,guardArgs=[id,source.revision,book,claim,book,id,source.updated_at,dailyTarget.sheetId,dailyTarget.sheet,Number(env.CONTINUOUS_RAW_SHEET_ID),env.CONTINUOUS_RAW_SHEET,Number(env.CONTINUOUS_DETAIL_SHEET_ID),env.CONTINUOUS_DETAIL_SHEET,id,id,id,id,id,id,id,id,id,id,id,id,id,lease];
   const result=await db.batch([
    db.prepare(`UPDATE sync_jobs SET status='COMPLETED',last_error='STABLE_CANCELLED_BEFORE_DISPATCH',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=1 AND ((status='PENDING' AND attempt_count=0 AND lease_token IS NULL AND lease_until IS NULL) OR (status='COMPLETED' AND last_error='SUPERSEDED_BEFORE_DISPATCH' AND lease_token IS NULL AND lease_until IS NULL AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('stable_recovery_epoch_no_delete','stable_recovery_epoch_transition','stable_recovery_operation_no_delete','stable_recovery_operation_transition'))=4 AND EXISTS(SELECT 1 FROM stable_recovery_epochs r JOIN stable_recovery_operations o ON o.epoch_id=r.epoch_id WHERE r.spreadsheet_id=? AND r.state='COMPLETE' AND r.target_type='EXPENSE' AND r.target_key=sync_jobs.entity_key AND r.target_version=1 AND o.state='VERIFIED'))) AND ${noWriteGuard}`).bind(id,book,...guardArgs),
    db.prepare(`UPDATE sync_jobs SET status='COMPLETED',last_error='STABLE_CANCELLED_BEFORE_DISPATCH',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=2 AND status='PROCESSING' AND lease_token=? AND changes()=1`).bind(id,lease),
    db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('invalid-json','$') END AS ok")
   ]);
   if(result.length!==3||result.some(r=>r.success!==true)||Number(result[0]!.meta?.changes)!==1||Number(result[1]!.meta?.changes)!==1)throw Error('CANCEL_JOB_EMPTY_UNCERTAIN');
   return 'COMPLETED';
  }
  const args=[source.revision,book,claim,book,job.entityKey,job.entityVersion,source.updated_at,lease,dailyTarget.sheetId,dailyTarget.sheet,Number(env.CONTINUOUS_RAW_SHEET_ID),env.CONTINUOUS_RAW_SHEET,Number(env.CONTINUOUS_DETAIL_SHEET_ID),env.CONTINUOUS_DETAIL_SHEET];
  const sourceValid=async()=>{const x=await db.prepare(`SELECT 1 AS ok WHERE ${sourceGuard}`).bind(...args).first<{ok:number}>();return stable()&&x?.ok===1&&await stableWorkbookClaimOwned(env,claim,publicationBudget)&&stable();};
  if(!await sourceValid())throw Error('CANCEL_JOB_SOURCE');
  const daily=projections.filter(p=>p.projection==='DAILY'),raw=projections.filter(p=>p.projection==='EXPENSE_RAW'),details=projections.filter(p=>p.projection==='DETAIL');
  if(daily.length!==1||daily[0]!.entity_id!==job.entityKey||daily[0]!.sheet_name!==dailyTarget.sheet||daily[0]!.sheet_id!==dailyTarget.sheetId||raw.length>1||raw.some(p=>p.entity_id!==job.entityKey)||details.some(p=>!p.entity_id.startsWith(`${job.entityKey}|`)||!/^item_[A-Za-z0-9_-]{1,128}$/.test(p.entity_id.slice(job.entityKey.length+1)))||projections.some(p=>!['DAILY','EXPENSE_RAW','DETAIL'].includes(p.projection)||p.state!=='VERIFIED'||p.source_version!==job.entityVersion-1||p.source_digest!==daily[0]!.source_digest))throw Error('CANCEL_JOB_PROJECTION_REVIEW');
  for(const p of [...raw,...details]){const target=resolveCarrierLedgerTarget(env,p.projection as 'EXPENSE_RAW'|'DETAIL');if(p.sheet_id!==target.sheetId||p.sheet_name!==target.sheet)throw Error('CANCEL_JOB_LEGACY_REVIEW');}
  for(const w of writes){const p=projections.find(x=>x.entity_id===w.entity_id&&x.projection===w.projection);if(!p||w.state!=='VERIFIED'||w.cancellation_version!==job.entityVersion||w.previous_version!==p.source_version||!/^[0-9a-f]{64}$/.test(w.preimage_digest))throw Error('CANCEL_JOB_INTENT_REVIEW');}
  const missing=[...daily,...raw,...details].find(p=>!writes.some(w=>w.entity_id===p.entity_id&&w.projection===p.projection));
  if(missing){
   if(missing.projection==='DAILY')await cancelAtomicDailyCandidateUnderClaim(env,job,lease,claim,missing.sheet_name,missing.sheet_id,publication,publicationBudget);
   else await cancelCarrierLedgerUnderClaim(env,job,lease,claim,missing.projection,missing.projection==='DETAIL'?missing.entity_id.slice(job.entityKey.length+1):undefined,publication,publicationBudget);
   if(normalNoticeHandoffEnabled(env)){if(await hasNormalNoticeHandoff(env,claim,job))return 'CONTINUE';throw Error('NORMAL_NOTICE_HANDOFF_MISSING');}
   if(!await sourceValid())throw Error('CANCEL_JOB_STAGE_UNCERTAIN');
   const nextStatement=db.prepare(`UPDATE sync_jobs SET status='PENDING',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error='STABLE_CANCELLATION_STAGE_CONTINUE' WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND ${sourceGuard} AND EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=? AND c.entity_type='EXPENSE' AND c.entity_id=? AND c.projection=? AND c.cancellation_version=? AND c.previous_version=? AND c.state='VERIFIED')`).bind(job.entityKey,job.entityVersion,lease,...args,book,missing.entity_id,missing.projection,job.entityVersion,missing.source_version);
   const next=await nextStatement.run();
   if(next.success!==true||Number(next.meta?.changes)!==1)throw Error('CANCEL_JOB_STAGE_UNCERTAIN');return 'CONTINUE';
  }
  if(publication&&publicationTarget&&publicationBudget){
   if(!await verifyPublicationTarget())throw Error('PUBLICATION_TARGET_CHANGED');
   const policy={...continuousSheetsReadPolicy,budget:publicationBudget},specs=await planPublicationSnapshot(env,await getSpreadsheetSheetProperties(env,policy),publicationTarget),before=await capturePublicationBatchSnapshot(env,specs,publicationBudget),evidence=await readPublicationAccountingEvidence(env,publication,policy,before),after=await capturePublicationBatchSnapshot(env,specs,publicationBudget);
   await verifyStableCancellationFinal(env,job,projections,writes,source.updated_at,claim,evidence,policy,{before,after});
   if(!await verifyPublicationTarget())throw Error('PUBLICATION_TARGET_CHANGED');
  }else await verifyStableCancellationFinal(env,job,projections,writes,source.updated_at,claim);
  if(!await sourceValid())throw Error('CANCEL_JOB_FINAL_UNCERTAIN');
  if(normalNoticeHandoffEnabled(env)){
   const snapshot=await readCancelledExpenseSource(env,job,claim,lease);if(!snapshot||snapshot.revision!==source.revision||!stable())throw Error('CANCEL_JOB_FINAL_SOURCE');
   const manifest=projections.map(p=>{const w=writes.find(x=>x.entity_id===p.entity_id&&x.projection===p.projection);if(!w||!p.operation_token)throw Error('CANCEL_JOB_FINAL_JOURNAL');return {entity_id:p.entity_id,projection:p.projection,sheet_id:p.sheet_id,sheet_name:p.sheet_name,source_version:p.source_version,source_digest:p.source_digest,operation_token:p.operation_token,cancel_operation_token:w.operation_token,cancel_preimage_digest:w.preimage_digest};}).sort((a,b)=>a.projection.localeCompare(b.projection)||a.entity_id.localeCompare(b.entity_id));
   await finishFinalNormalStage(env,job,claim,lease,'CANCEL',snapshot.revision,snapshot.digest,JSON.stringify(manifest));return 'CONTINUE';
  }
  const publicationFinalGuard=publication?" AND EXISTS(SELECT 1 FROM continuous_publication_markers p JOIN continuous_publication_intents i ON i.transition_id=p.transition_id AND i.state='VERIFIED' AND i.kind='REVOKE' WHERE p.spreadsheet_id=? AND p.entity_id=? AND p.sheet_id=? AND p.sheet_name=? AND p.row_number=? AND p.version=? AND p.state='REVOKED' AND p.marker=i.after_value AND i.source_digest=?) AND NOT EXISTS(SELECT 1 FROM continuous_publication_intents pending WHERE pending.spreadsheet_id=? AND pending.entity_id=? AND pending.state IN ('IN_FLIGHT','REVIEW'))":'';
  const finish=await db.prepare(`UPDATE sync_jobs SET status='COMPLETED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=NULL WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND ${sourceGuard} AND (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|'))=? AND (SELECT count(*) FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=? AND c.entity_type='EXPENSE' AND (c.entity_id=? OR substr(c.entity_id,1,length(?)+1)=?||'|'))=? AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|') AND (p.state<>'VERIFIED' OR NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=p.spreadsheet_id AND c.entity_type=p.entity_type AND c.entity_id=p.entity_id AND c.projection=p.projection AND c.cancellation_version=? AND c.previous_version=p.source_version AND c.state='VERIFIED'))) ${publicationFinalGuard}`).bind(job.entityKey,job.entityVersion,lease,...args,book,job.entityKey,job.entityKey,job.entityKey,projections.length,book,job.entityKey,job.entityKey,job.entityKey,projections.length,book,job.entityKey,job.entityKey,job.entityKey,job.entityVersion,...(publication?[book,job.entityKey,publication.sheetId,publication.sheet,publication.row,job.entityVersion,publication.sourceDigest,book,job.entityKey]:[])).run();
  if(finish.success!==true||Number(finish.meta?.changes)!==1)throw Error('CANCEL_JOB_FINAL_UNCERTAIN');return 'COMPLETED';
 },job,undefined,invocationBudget);
}
