import type {Env,SheetsSyncJob} from '../types';
import {normalNoticeHandoffEnabled,hasNormalNoticeHandoff,finishFinalNormalStage} from './continuous-normal-notice-handoff';
import {readStableExpenseSource} from './stable-expense-source';
import {planStableExpenseProjections} from './stable-expense-projection-plan';
import {writeNewExpenseLedgerUnderClaim} from './stable-expense-ledger-writer';
import {StableDailyCapacityError,StableDailyPreflightReviewError,writeNewDailyUnderClaim} from './stable-daily-writer';
import {newStableSourcePredicate,stableSourceIntegrity} from './stable-source-cutover';
import {withStableWorkbookClaim} from './stable-workbook-claim';
import {stableWorkbookClaimOwned} from './stable-workbook-claim';
import {verifyStableExpenseProjections} from './stable-expense-final-check';
import {admitStableRecovery,recoveryGateConfigured,recoveryGateValid} from './stable-recovery-admission';
import {SheetsHttpError,SheetsReadNetworkError,continuousSheetsReadPolicy,getSpreadsheetSheetProperties} from './client';
import {GoogleOAuthHttpError,GoogleOAuthPreflightError} from './google-auth';
import {OperationTimeoutError} from '../shared/async';
import {assertContinuousDailyActivated} from './continuous-daily-route';
import {chooseContinuousDailyCutover,continuousAdmissionIntegrity,continuousDailyCutoverIntegrity} from './continuous-daily-cutover';
import {InsertDailyDefiniteFailure,InsertDailyPendingCancellationError,InsertDailyPreflightReviewError,insertDailyExpenseUnderClaim} from './insert-daily-writer';
import {writeCarrierLedgerUnderClaim} from './atomic-expense-ledger-writer';
import {executeUnwrittenExpenseCancellation} from './unwritten-expense-cancellation-candidate';
import {resolvePublicationTarget} from './continuous-publication-route';
import {publicationOperationUnderClaim} from './continuous-publication-operation';
import {decodePublicationCarrier} from './continuous-publication-template';
import {readPublicationAccountingEvidence,type PublicationAccountingTarget} from './publication-accounting-evidence';
import {verifyPublicationFinalGuard} from './continuous-publication-final-guard';
import {ReviewRequestBudget} from './review-request-budget';
import {planPublicationSnapshot} from './publication-snapshot-plan';
import {capturePublicationBatchSnapshot} from './publication-batch-snapshot';
import {normalNoticeHandoffReady} from './continuous-normal-notice-handoff';
import {publicationHandoffHooks} from './publication-handoff-hooks';

/** These codes apply only before notice-mutation authorization. OAuth only
 * exchanges a token; it is not a Sheets business write. */
/** PUBLISH stays disabled until a measured full invocation proves both request
 * quotas and post-dispatch verification, including all queue and D1 work. */
function publicationPublishInvocationReady(_budget:ReviewRequestBudget|undefined):boolean{return false;}

function untouchedNoticeFailureCode(error:unknown):string|null{
 if(error instanceof SheetsHttpError&&error.message==='STABLE_NOTICE_READ'&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599)return `SHEETS_READ_HTTP_${error.status}`;
 if(error instanceof SheetsReadNetworkError)return 'SHEETS_READ_NETWORK';
 if(error instanceof GoogleOAuthHttpError&&Number.isInteger(error.status)&&error.status>=400&&error.status<=599)return `GOOGLE_OAUTH_HTTP_${error.status}`;
 if(error instanceof GoogleOAuthPreflightError)return error.code;
 if(error instanceof OperationTimeoutError&&/^Stable notice read timed out after \d+ms$/.test(error.message))return 'SHEETS_READ_TIMEOUT';
 if(error instanceof OperationTimeoutError&&/^Google OAuth timed out after \d+ms$/.test(error.message))return 'GOOGLE_OAUTH_TIMEOUT';
 return null;
}

/** Scope a read-only failure to this job only if the source, lease, claim and
 * absence of all projection intents are proven in the same D1 statement.
 * The recovery gate has its own epoch lifecycle; leave it fail-closed. */
async function holdUnwrittenExpenseReview(env:Env,job:SheetsSyncJob,lease:string,claim:string,reason:string,mode:'STALE'|'PREFLIGHT',revision?:number):Promise<boolean>{
 if(recoveryGateConfigured(env)||!env.GOOGLE_SPREADSHEET_ID)return false;
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 // Before migration 0023 there is no epoch table to fence. Retain the
 // existing workbook-wide REVIEW behavior instead of referencing a missing
 // table or assuming that a scoped release is safe.
 const schema=await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='stable_recovery_epochs'").first<{n:number}>();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||recoveryGateConfigured(env)||!schema||!Number.isSafeInteger(schema.n))throw Error('STABLE_SCOPED_REVIEW_UNCERTAIN');
 if(schema.n===0)return false;
 if(schema.n!==1)throw Error('STABLE_SCOPED_REVIEW_UNCERTAIN');
 const sourceGuard=mode==='STALE'
  ? "EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=? AND (e.status='CANCELLED' OR e.version<>?))"
  : "EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED') AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?)";
 const result=await db.prepare(`UPDATE sync_jobs SET status='REVIEW',last_error=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL
  WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND ${stableSourceIntegrity} AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')
  AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs r WHERE r.spreadsheet_id=? AND r.state IN ('ARMED','REVIEW'))
  AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=sync_jobs.entity_type||':'||sync_jobs.entity_key||':'||sync_jobs.entity_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')
  AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|')) AND ${sourceGuard}`)
  .bind(reason,job.entityKey,job.entityVersion,lease,book,claim,book,book,job.entityKey,job.entityKey,job.entityKey,job.entityKey,job.entityVersion,...(mode==='PREFLIGHT'?[revision]:[])).run();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||recoveryGateConfigured(env)||result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('STABLE_SCOPED_REVIEW_UNCERTAIN');
 return Number(result.meta.changes)===1;
}

/** Defer this untouched job while another, already-verified carrier waits for
 * its normal Undo job. Unknown cancellation writes are not admitted here. */
async function deferUnwrittenForCancellation(env:Env,job:SheetsSyncJob,lease:string,claim:string,revision:number,pendingId:string):Promise<boolean>{
 if(recoveryGateConfigured(env)||!env.GOOGLE_SPREADSHEET_ID)return false;
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 const schema=await db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='stable_recovery_epochs'").first<{n:number}>();if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||schema?.n!==1)return false;
 const result=await db.prepare(`UPDATE sync_jobs SET status='PENDING',attempt_count=CASE WHEN attempt_count>0 THEN attempt_count-1 ELSE 0 END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+90 seconds'),lease_until=NULL,lease_token=NULL,last_error='WAITING_FOR_CANCELLATION'
  WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')
  AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs r WHERE r.spreadsheet_id=? AND r.state IN ('ARMED','REVIEW'))
  AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=sync_jobs.entity_type||':'||sync_jobs.entity_key||':'||sync_jobs.entity_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')
  AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=? OR substr(p.entity_id,1,length(?)+1)=?||'|'))
  AND EXISTS(SELECT 1 FROM stable_projection_writes p JOIN expense_events e ON e.expense_id=p.entity_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.projection='DAILY' AND p.entity_id=? AND p.state='VERIFIED' AND e.status='CANCELLED' AND e.version=p.source_version+1 AND j.status IN ('PENDING','PROCESSING') AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=p.spreadsheet_id AND c.entity_type=p.entity_type AND c.entity_id=p.entity_id AND c.projection=p.projection))`)
  .bind(job.entityKey,job.entityVersion,lease,revision,book,claim,book,book,job.entityKey,job.entityKey,job.entityKey,book,pendingId).run();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('INSERT_DAILY_DEFER_UNCERTAIN');
 return Number(result.meta.changes)===1;
}

/** An older confirmed job becomes obsolete after Undo. Close only its own
 * lease when every dispatched projection has verified preimage/reservation,
 * the next version's cancellation job exists, and no cancellation intent is
 * ambiguous. The Undo job remains responsible for cancelling every row. */
async function finishSupersededConfirmedJob(env:Env,job:SheetsSyncJob,lease:string,claim:string):Promise<boolean>{
 if(!env.GOOGLE_SPREADSHEET_ID)return false;
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,gate=recoveryGateConfigured(env);
 if(gate&&!recoveryGateValid(env))return false;
 const result=await db.prepare(`UPDATE sync_jobs SET status='COMPLETED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error='SUPERSEDED_BY_UNDO'
  WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND ${continuousAdmissionIntegrity}
  AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')
  AND ((?=0 AND NOT EXISTS(SELECT 1 FROM stable_recovery_epochs r WHERE r.spreadsheet_id=? AND r.state IN ('ARMED','REVIEW'))) OR (?=1 AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('stable_recovery_epoch_no_delete','stable_recovery_epoch_transition','stable_recovery_operation_no_delete','stable_recovery_operation_transition'))=4 AND EXISTS(SELECT 1 FROM stable_recovery_epochs r JOIN stable_recovery_operations o ON o.epoch_id=r.epoch_id WHERE r.spreadsheet_id=? AND r.state='ARMED' AND r.target_type='EXPENSE' AND r.target_key=sync_jobs.entity_key AND r.target_version=sync_jobs.entity_version AND o.operation_token=? AND o.state='ADMITTED')))
  AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=sync_jobs.entity_type||':'||sync_jobs.entity_key||':'||sync_jobs.entity_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')
  AND EXISTS(SELECT 1 FROM continuous_daily_cutovers cut WHERE cut.spreadsheet_id=? AND cut.state='ACTIVE' AND (EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses post WHERE post.spreadsheet_id=cut.spreadsheet_id AND post.expense_id=sync_jobs.entity_key) OR EXISTS(SELECT 1 FROM continuous_daily_source_admissions a JOIN stable_projection_writes p ON p.spreadsheet_id=a.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=a.expense_id AND p.projection='DAILY' AND p.source_version=a.source_version AND p.source_digest=a.source_digest AND p.state='VERIFIED' WHERE a.spreadsheet_id=cut.spreadsheet_id AND a.expense_id=sync_jobs.entity_key AND a.source_version=sync_jobs.entity_version)))
  AND EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs undo ON undo.entity_type='EXPENSE' AND undo.entity_key=e.expense_id AND undo.entity_version=e.version WHERE e.expense_id=sync_jobs.entity_key AND e.status='CANCELLED' AND e.version=sync_jobs.entity_version+1 AND undo.status IN ('PENDING','PROCESSING','COMPLETED'))
  AND EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.entity_id=sync_jobs.entity_key AND p.projection='DAILY' AND p.state='VERIFIED' AND p.source_version=sync_jobs.entity_version)
  AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=sync_jobs.entity_key OR substr(p.entity_id,1,length(sync_jobs.entity_key)+1)=sync_jobs.entity_key||'|') AND (p.state<>'VERIFIED' OR p.source_version<>sync_jobs.entity_version OR NOT EXISTS(SELECT 1 FROM stable_expense_projection_preimages i JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=i.spreadsheet_id AND m.sheet_id=i.sheet_id AND m.entity_id=i.entity_id AND m.source_version=i.source_version WHERE i.spreadsheet_id=p.spreadsheet_id AND i.entity_type=p.entity_type AND i.entity_id=p.entity_id AND i.projection=p.projection AND i.sheet_id=p.sheet_id AND i.sheet_name=p.sheet_name AND i.source_version=p.source_version AND i.source_digest=p.source_digest AND m.operation_token=p.operation_token)))
  AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=? AND c.entity_type='EXPENSE' AND (c.entity_id=sync_jobs.entity_key OR substr(c.entity_id,1,length(sync_jobs.entity_key)+1)=sync_jobs.entity_key||'|') AND (c.state<>'VERIFIED' OR c.cancellation_version<>sync_jobs.entity_version+1 OR c.previous_version<>sync_jobs.entity_version))
  AND NOT EXISTS(SELECT 1 FROM sync_jobs undo WHERE undo.entity_type='EXPENSE' AND undo.entity_key=sync_jobs.entity_key AND undo.entity_version=sync_jobs.entity_version+1 AND undo.status='COMPLETED' AND EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND (p.entity_id=sync_jobs.entity_key OR substr(p.entity_id,1,length(sync_jobs.entity_key)+1)=sync_jobs.entity_key||'|') AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=p.spreadsheet_id AND c.entity_type=p.entity_type AND c.entity_id=p.entity_id AND c.projection=p.projection AND c.cancellation_version=undo.entity_version AND c.previous_version=p.source_version AND c.state='VERIFIED')))`).bind(job.entityKey,job.entityVersion,lease,book,claim,Number(gate),book,Number(gate),book,claim,book,book,book,book,book).run();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||recoveryGateConfigured(env)!==gate||gate&&!recoveryGateValid(env)||result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('STABLE_SUPERSEDED_UNCERTAIN');
 return Number(result.meta.changes)===1;
}

/** Undo raced an exact recovery epoch before any projection was reserved.
 * The current lease is closed atomically only for a new post-cutover source,
 * and only if no business-write intent, legacy mapping or failure history exists.
 * An earlier/uncertain operation is never inferred to have finished. */
async function finishSupersededBeforeDispatch(env:Env,job:SheetsSyncJob,lease:string,claim:string):Promise<boolean>{
 const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID;
 if(!book||job.entityVersion!==1||!recoveryGateValid(env))return false;
 const result=await db.prepare(`UPDATE sync_jobs SET status='COMPLETED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error='SUPERSEDED_BEFORE_DISPATCH'
  WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=1 AND status='PROCESSING' AND lease_token=? AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND ${stableSourceIntegrity} AND ${continuousDailyCutoverIntegrity} AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('stable_recovery_epoch_no_delete','stable_recovery_epoch_transition','stable_recovery_operation_no_delete','stable_recovery_operation_transition'))=4
  AND EXISTS(SELECT 1 FROM stable_workbook_claims c JOIN stable_recovery_epochs r ON r.spreadsheet_id=c.spreadsheet_id JOIN stable_recovery_operations o ON o.epoch_id=r.epoch_id AND o.operation_token=c.operation_token WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD' AND r.state='ARMED' AND r.target_type='EXPENSE' AND r.target_key=sync_jobs.entity_key AND r.target_version=1 AND o.state='ADMITTED')
  AND EXISTS(SELECT 1 FROM expense_events e JOIN continuous_daily_post_cutover_expenses p ON p.expense_id=e.expense_id JOIN continuous_daily_cutovers cut ON cut.spreadsheet_id=p.spreadsheet_id AND cut.state='ACTIVE' JOIN sync_jobs undo ON undo.entity_type='EXPENSE' AND undo.entity_key=e.expense_id AND undo.entity_version=2 WHERE p.spreadsheet_id=? AND e.expense_id=sync_jobs.entity_key AND e.status='CANCELLED' AND e.version=2 AND undo.status='PENDING' AND undo.lease_token IS NULL AND undo.lease_until IS NULL)
  AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=sync_jobs.entity_key OR substr(p.entity_id,1,length(sync_jobs.entity_key)+1)=sync_jobs.entity_key||'|'))
  AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=sync_jobs.entity_key OR substr(p.entity_id,1,length(sync_jobs.entity_key)+1)=sync_jobs.entity_key||'|'))
  AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=sync_jobs.entity_key OR substr(i.entity_key,1,length(sync_jobs.entity_key)+1)=sync_jobs.entity_key||'|')
  AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key IN ('EXPENSE:'||sync_jobs.entity_key||':1','EXPENSE:'||sync_jobs.entity_key||':2'))
  AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations prior JOIN stable_recovery_epochs e ON e.epoch_id=prior.epoch_id WHERE e.spreadsheet_id=? AND e.target_type='EXPENSE' AND e.target_key=sync_jobs.entity_key AND e.target_version=1 AND prior.operation_token<>?)`).bind(job.entityKey,lease,book,claim,book,book,claim).run();
 if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||!recoveryGateValid(env)||result.success!==true||!Number.isSafeInteger(result.meta?.changes))throw Error('STABLE_SUPERSEDED_UNCERTAIN');
 return Number(result.meta.changes)===1;
}

/** Phase-one candidate. The daily preflight happens first so a full month can
 * be held without writing RAW or details. Called by the stable phase-one dispatcher. */
export async function runStableExpenseJob(env:Env,job:SheetsSyncJob,lease:string,invocationBudget?:ReviewRequestBudget):Promise<'COMPLETED'|'CONTINUE'|'CAPACITY_REVIEW'|'JOB_REVIEW'>{
 // This gate must run before acquiring the workbook claim, which itself
 // changes D1 and the owner notice. A mislabeled test binding must not touch
 // Production even when the experimental route is accidentally enabled.
 const scope=()=>JSON.stringify([env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED,env.CONTINUOUS_REVIEW_CLOSE_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.APP_ENV,env.RUNTIME_MODE]);
 const target=await assertContinuousDailyActivated(env),targetScope=scope();
 const publicationTarget=await resolvePublicationTarget(env);
 if(publicationTarget&&(!(invocationBudget instanceof ReviewRequestBudget)||!target||env.STABLE_SHEETS_PACING_ENABLED!=='true'||!normalNoticeHandoffEnabled(env)||!await normalNoticeHandoffReady(env)))throw Error('PUBLICATION_ROUTE_DISABLED');
 return withStableWorkbookClaim(env,async claim=>{
  if(targetScope!==scope())throw Error('CONTINUOUS_DAILY_SCOPE_CHANGED');
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,source=await readStableExpenseSource(env,job,lease,claim);
  if(targetScope!==scope())throw Error('CONTINUOUS_DAILY_SCOPE_CHANGED');
  if(!source){
   if(target&&await finishSupersededConfirmedJob(env,job,lease,claim))return 'COMPLETED';
   if(target&&await finishSupersededBeforeDispatch(env,job,lease,claim))return 'COMPLETED';
   if(await holdUnwrittenExpenseReview(env,job,lease,claim,'STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED','STALE'))return 'JOB_REVIEW';
   throw Error('STABLE_EXPENSE_SOURCE_UNVERIFIED');
  }
  // The gate currently forbids target activation. If it is later opened only
  // after cutover validation, never route every unjournaled historical
  // expense to the new tab solely because the flag is on.
  const dailyChoice=target?await chooseContinuousDailyCutover(env,job,source.digest):null;
  if(targetScope!==scope())throw Error('CONTINUOUS_DAILY_SCOPE_CHANGED');
  if(dailyChoice?.status==='HOLD'){
   if(dailyChoice.reason==='PRE_CUTOVER_UNJOURNALED'&&await holdUnwrittenExpenseReview(env,job,lease,claim,'CONTINUOUS_PRE_CUTOVER_UNRECONCILED','PREFLIGHT',source.revision))return 'JOB_REVIEW';
   throw Error(`CONTINUOUS_DAILY_${dailyChoice.reason}`);
  }
  if(dailyChoice?.status==='CONTINUOUS'&&(dailyChoice.sheet!==target?.sheet||dailyChoice.sheetId!==target.sheetId))throw Error('CONTINUOUS_DAILY_TARGET_CHANGED');
  const projections=planStableExpenseProjections(source);
  const publicationBudget=publicationTarget&&dailyChoice?.status==='CONTINUOUS'?invocationBudget:undefined;
  let publication:PublicationAccountingTarget|undefined;
  const verifyPublicationTarget=async()=>JSON.stringify(await resolvePublicationTarget(env))===JSON.stringify(publicationTarget)&&targetScope===scope();
  if(publicationTarget&&publicationBudget){
   const prior=await db.prepare("SELECT marker,row_number FROM continuous_publication_markers WHERE spreadsheet_id=? AND entity_id=?").bind(book,job.entityKey).first<{marker:string;row_number:number}>();
   if(!prior){
    const journals=await db.prepare("SELECT 1 AS found FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|') LIMIT 1").bind(book,job.entityKey,job.entityKey,job.entityKey).first<{found:number}>();
    if(journals)throw Error('PUBLICATION_UNJOURNALED_CARRIER');
    const hooks=publicationHandoffHooks(env,job,claim,lease,source.revision,'STAGE');
    const staged=await publicationOperationUnderClaim(env,'STAGE',{job,lease,claim,sourceRevision:source.revision,sourceDigest:source.digest,detailCount:projections.details.length,target:publicationTarget,budget:publicationBudget,verifyTarget:verifyPublicationTarget,verifyProjections:async()=>false,...hooks});
    if(staged.state!=='STAGED')throw Error('PUBLICATION_STAGE_UNVERIFIED');
    const handoff=await db.prepare("SELECT transition_id FROM continuous_publication_markers WHERE spreadsheet_id=? AND entity_id=? AND state='STAGED'").bind(book,job.entityKey).first<{transition_id:string}>();if(!handoff||!await hooks.verifyHandoff(handoff.transition_id))throw Error('PUBLICATION_STAGE_CONTINUE_UNCERTAIN');return 'CONTINUE';
   }
   const marker=decodePublicationCarrier(prior.marker);
   if(!marker||marker.expenseId!==job.entityKey||marker.version!==job.entityVersion||marker.detailCount!==projections.details.length||!['STAGED','PUBLISHED'].includes(marker.state)||!Number.isSafeInteger(prior.row_number))throw Error('PUBLICATION_MARKER_UNVERIFIED');
   publication={sheet:publicationTarget.sheetName,sheetId:publicationTarget.sheetId,rows:publicationTarget.rows,row:prior.row_number,expected:marker,sourceDigest:source.digest};
  }
  const recorded=await db.prepare("SELECT entity_id,projection,sheet_id,sheet_name,source_version,source_digest,state,operation_token FROM stable_projection_writes WHERE spreadsheet_id=? AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|')").bind(book,job.entityKey,job.entityKey,job.entityKey).all<{entity_id:string;projection:string;sheet_id:number;sheet_name:string;source_version:number;source_digest:string;state:string;operation_token?:string}>();
  if(targetScope!==scope())throw Error('CONTINUOUS_DAILY_SCOPE_CHANGED');
  if(recorded.success!==true||!Array.isArray(recorded.results))throw Error('STABLE_EXPENSE_JOURNAL_UNVERIFIED');
  const journals=recorded.results,expected=[{id:job.entityKey,projection:'DAILY'},{id:job.entityKey,projection:'EXPENSE_RAW'},...projections.details.map(item=>({id:`${job.entityKey}|${item.itemId}`,projection:'DETAIL'}))];
  if(journals.some(j=>j.state!=='VERIFIED'||j.source_version!==job.entityVersion||j.source_digest!==source.digest||!expected.some(e=>e.id===j.entity_id&&e.projection===j.projection)))throw Error('STABLE_EXPENSE_JOURNAL_CONFLICT');
  const missing=expected.find(e=>!journals.some(j=>j.entity_id===e.id&&j.projection===e.projection));
  if(publication&&missing&&publication.expected.state!=='STAGED')throw Error('PUBLICATION_MARKER_UNVERIFIED');
  try{
   if(missing?.projection==='DAILY'){
    if(target&&dailyChoice?.status==='CONTINUOUS')await insertDailyExpenseUnderClaim(env,job,lease,claim,source,target.sheet,target.sheetId,publication,publicationBudget);
    else await writeNewDailyUnderClaim(env,job,lease,claim,source);
   }
   else if(missing?.projection==='EXPENSE_RAW'){
    if(target&&dailyChoice?.status==='CONTINUOUS')await writeCarrierLedgerUnderClaim(env,job,lease,claim,source,'EXPENSE_RAW',undefined,publication,publicationBudget);
    else await writeNewExpenseLedgerUnderClaim(env,job,lease,claim,source,'EXPENSE_RAW');
   }else if(missing?.projection==='DETAIL'){
    if(target&&dailyChoice?.status==='CONTINUOUS')await writeCarrierLedgerUnderClaim(env,job,lease,claim,source,'DETAIL',missing.id.slice(job.entityKey.length+1),publication,publicationBudget);
    else await writeNewExpenseLedgerUnderClaim(env,job,lease,claim,source,'DETAIL',missing.id.slice(job.entityKey.length+1));
   }
  }catch(error){
   if(error instanceof InsertDailyPreflightReviewError){
    if(recoveryGateConfigured(env)&&recoveryGateValid(env)&&(/^(REPORT_HEALTH_|LEGACY_COVERAGE_)[A-Z_]+$/.test(error.reason)||/^(?:(?:SHEETS_READ|GOOGLE_OAUTH)_(?:HTTP_[45][0-9]{2}|TIMEOUT)|GOOGLE_OAUTH_(?:CREDENTIAL_INVALID|NETWORK|RESPONSE_INVALID)|SHEETS_READ_(?:NETWORK|RESPONSE_TOO_LARGE))$/.test(error.reason))&&await executeUnwrittenExpenseCancellation(env,{job,lease,claim,sourceRevision:source.revision,sourceDigest:source.digest,description:String(source.expense.description??''),amountSatang:Number(source.expense.amount_satang),reason:error.reason.startsWith('REPORT_HEALTH_')?'REPORT_UNVERIFIED':/^(?:SHEETS_READ|GOOGLE_OAUTH)_/.test(error.reason)?'SHEETS_READ':'LEGACY_READ',errorCode:error.reason},invocationBudget))return 'COMPLETED';
    if(await holdUnwrittenExpenseReview(env,job,lease,claim,error.message,'PREFLIGHT',source.revision))return 'JOB_REVIEW';
    throw error;
   }
   if(error instanceof InsertDailyDefiniteFailure){
    if(await executeUnwrittenExpenseCancellation(env,{job,lease,claim,sourceRevision:source.revision,sourceDigest:source.digest,description:String(source.expense.description??''),amountSatang:Number(source.expense.amount_satang),reason:error.reason},invocationBudget))return 'COMPLETED';
    throw error;
   }
   if(error instanceof InsertDailyPendingCancellationError){
    if(recoveryGateConfigured(env)&&recoveryGateValid(env)&&await executeUnwrittenExpenseCancellation(env,{job,lease,claim,sourceRevision:source.revision,sourceDigest:source.digest,description:String(source.expense.description??''),amountSatang:Number(source.expense.amount_satang),reason:'PENDING_UNDO',errorCode:'INSERT_DAILY_PENDING_CANCELLATION'},invocationBudget))return 'COMPLETED';
    if(await deferUnwrittenForCancellation(env,job,lease,claim,source.revision,error.pendingEntityId))return 'CONTINUE';
    throw error;
   }
   if(error instanceof Error&&['STABLE_DAILY_SOURCE_CHANGED','STABLE_DAILY_RESERVATION'].includes(error.message)){
    if(await holdUnwrittenExpenseReview(env,job,lease,claim,'STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED','STALE'))return 'JOB_REVIEW';
    throw error;
   }
   // Only month-local issues may be isolated. Identity, snapshot and other
   // unexpected integrity failures retain the workbook-wide review fence.
   if(error instanceof StableDailyPreflightReviewError&&['MONTH_OPENING_UNVERIFIED','ROW_HELPER_FORMULA_UNVERIFIED'].includes(error.reason)){
    if(await holdUnwrittenExpenseReview(env,job,lease,claim,`STABLE_DAILY_${error.reason}`,'PREFLIGHT',source.revision))return 'JOB_REVIEW';
    throw error;
   }
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
   if(normalNoticeHandoffEnabled(env)){if(await hasNormalNoticeHandoff(env,claim,job))return 'CONTINUE';throw Error('NORMAL_NOTICE_HANDOFF_MISSING');}
   // A verified projection is durable before yielding. A new invocation gets
   // a fresh subrequest budget and rechecks source and every journal. Never
   // resume an ambiguous IN_FLIGHT write.
   const nextStatement=db.prepare(`UPDATE sync_jobs SET status='PENDING',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error='STABLE_STAGE_CONTINUE' WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND ${stableSourceIntegrity} AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?) AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD') AND EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.entity_id=? AND p.projection=? AND p.source_version=? AND p.source_digest=? AND p.state='VERIFIED')`).bind(job.entityKey,job.entityVersion,lease,source.revision,book,claim,book,missing.id,missing.projection,job.entityVersion,source.digest);
   const next=await nextStatement.run();
   if(next.success!==true||Number(next.meta?.changes)!==1)throw Error('STABLE_EXPENSE_CONTINUE_UNCERTAIN');
   return 'CONTINUE';
  }
  if(targetScope!==scope())throw Error('CONTINUOUS_DAILY_SCOPE_CHANGED');
  if(publication&&publicationTarget&&publicationBudget&&publication.expected.state==='STAGED'){
   if(!publicationPublishInvocationReady(invocationBudget))throw Error('PUBLICATION_PUBLISH_QUOTA_UNPROVEN');
   const hooks=publicationHandoffHooks(env,job,claim,lease,source.revision,'PUBLISH');
   await publicationOperationUnderClaim(env,'PUBLISH',{job,lease,claim,sourceRevision:source.revision,sourceDigest:source.digest,detailCount:projections.details.length,target:publicationTarget,budget:publicationBudget,verifyTarget:verifyPublicationTarget,verifyProjections:(phase,after,row,pending,snapshot,oauthLease)=>verifyPublicationFinalGuard(env,job,source,journals,publicationTarget,claim,phase,after,row,publicationBudget,pending,snapshot,oauthLease),...hooks});
   const handoff=await db.prepare("SELECT transition_id FROM continuous_publication_markers WHERE spreadsheet_id=? AND entity_id=? AND state='PUBLISHED'").bind(book,job.entityKey).first<{transition_id:string}>();if(!handoff||!await hooks.verifyHandoff(handoff.transition_id))throw Error('PUBLICATION_PUBLISH_CONTINUE_UNCERTAIN');return 'CONTINUE';
  }
  if(publication&&!await verifyPublicationTarget())throw Error('PUBLICATION_TARGET_CHANGED');
  const policy=publicationBudget?{...continuousSheetsReadPolicy,budget:publicationBudget}:continuousSheetsReadPolicy;
  const finalSnapshot=publication&&publicationTarget&&publicationBudget?await capturePublicationBatchSnapshot(env,await planPublicationSnapshot(env,await getSpreadsheetSheetProperties(env,policy),publicationTarget),publicationBudget):undefined;
  const publicationEvidence=publication?await readPublicationAccountingEvidence(env,publication,policy,finalSnapshot):undefined;
  await verifyStableExpenseProjections(env,job,source,journals,publicationEvidence?{...publicationEvidence,phase:'PUBLISHED'}:undefined,policy,finalSnapshot);
  if(publication&&!await verifyPublicationTarget())throw Error('PUBLICATION_TARGET_CHANGED');
  const latest=await readStableExpenseSource(env,job,lease,claim);if(!latest||latest.revision!==source.revision||latest.digest!==source.digest||latest.fingerprint!==source.fingerprint)throw Error('STABLE_EXPENSE_SOURCE_CHANGED');
  if(!await stableWorkbookClaimOwned(env,claim))throw Error('STABLE_EXPENSE_CLAIM_CHANGED');
  if(normalNoticeHandoffEnabled(env)){
   const manifest=journals.map(({entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token})=>({entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token})).sort((a,b)=>a.projection.localeCompare(b.projection)||a.entity_id.localeCompare(b.entity_id));
   await finishFinalNormalStage(env,job,claim,lease,'CONFIRM',source.revision,source.digest,JSON.stringify(manifest));return 'CONTINUE';
  }
  const itemKeys=JSON.stringify(projections.details.map(item=>`${job.entityKey}|${item.itemId}`));
  const publicationFinalGuard=publication?" AND EXISTS(SELECT 1 FROM continuous_publication_markers p JOIN continuous_publication_intents i ON i.transition_id=p.transition_id AND i.state='VERIFIED' AND i.kind='PUBLISH' WHERE p.spreadsheet_id=? AND p.entity_id=? AND p.sheet_id=? AND p.sheet_name=? AND p.row_number=? AND p.version=? AND p.state='PUBLISHED' AND p.marker=i.after_value AND i.source_digest=?) AND NOT EXISTS(SELECT 1 FROM continuous_publication_intents pending WHERE pending.spreadsheet_id=? AND pending.entity_id=? AND pending.state IN ('IN_FLIGHT','REVIEW'))":'';
  const completed=await db.prepare(`UPDATE sync_jobs SET status='COMPLETED',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error=NULL
   WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=? AND ${stableSourceIntegrity}
   AND EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=?)
   AND EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD')
   AND ${newStableSourcePredicate('EXPENSE')}
   AND (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.entity_id=? AND p.projection IN ('DAILY','EXPENSE_RAW') AND p.source_version=? AND p.source_digest=? AND p.state='VERIFIED')=2
   AND (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.projection='DETAIL' AND p.entity_id IN (SELECT value FROM json_each(?)) AND p.source_version=? AND p.source_digest=? AND p.state='VERIFIED')=?
   AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=? AND p.entity_type='EXPENSE' AND p.projection='DETAIL' AND substr(p.entity_id,1,length(?)+1)=?||'|' AND p.entity_id NOT IN (SELECT value FROM json_each(?))) ${publicationFinalGuard}`)
   .bind(job.entityKey,job.entityVersion,lease,source.revision,book,claim,job.entityKey,book,job.entityKey,job.entityVersion,source.digest,book,itemKeys,job.entityVersion,source.digest,projections.details.length,book,job.entityKey,job.entityKey,itemKeys,...(publication?[book,job.entityKey,publication.sheetId,publication.sheet,publication.row,job.entityVersion,publication.sourceDigest,book,job.entityKey]:[])).run();
  if(completed.success!==true||Number(completed.meta?.changes)!==1)throw Error('STABLE_EXPENSE_COMPLETION_UNCERTAIN');
  return 'COMPLETED';
 },job,target?async(claim,error)=>{
  const errorCode=untouchedNoticeFailureCode(error);
  if(!errorCode||targetScope!==scope())return null;
  const source=await readStableExpenseSource(env,job,lease,claim);
  if(!source||targetScope!==scope())return null;
  // If anything after durable admission is uncertain, throw so the claim
  // and epoch remain fenced; never treat an unknown D1 result as a no-op.
  if(!await admitStableRecovery(env,job,claim))return null;
  const cancelled=await executeUnwrittenExpenseCancellation(env,{job,lease,claim,sourceRevision:source.revision,sourceDigest:source.digest,description:String(source.expense.description??''),amountSatang:Number(source.expense.amount_satang),reason:'SHEETS_READ',errorCode},invocationBudget);
  if(!cancelled||targetScope!==scope())throw Error('SYNC_UNTOUCHED_NOTICE_CANCEL_UNCERTAIN');
  return{value:'COMPLETED' as const};
 }:undefined,invocationBudget);
}
