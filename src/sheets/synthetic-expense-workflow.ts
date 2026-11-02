import type {Env,SheetsSyncJob} from '../types';
import {assertStableShadowConfig,assertStableShadowDatabase,writeDailyStableShadow} from './daily-stable-row-shadow';
import {classifyStableShadowSource} from './daily-stable-cutover';
import {SyntheticExpenseProjectionJournal,type SyntheticProjection} from './synthetic-expense-projection-journal';
import {buildExpenseRawSheetValues,loadExpenseDailyPosting} from './sync';
import {getLedgerUatSnapshotPart} from './client';
import {createLedgerGoogleUatProbe} from './ledger-google-probe';
import {projectExistingLedgerShadow} from './ledger-stable-projector';
import type {LedgerSourceProof} from './ledger-stable-journal';

/** A trusted in-process fixture adapter must independently check its Sheets
 * readback and its own dispatch fence. Its returned digest is a journal marker,
 * not independently verified proof. No request may supply these callbacks. */
export type SyntheticProjectionAdapters=Partial<Record<SyntheticProjection,(fence:()=>Promise<void>)=>Promise<string|'PARTIAL'>>>;
export type SyntheticWorkflowResult='VERIFIED'|'REVIEW'|'BUSY';
export async function assertSyntheticLedgerUat(env:Env):Promise<void>{
  if(env.SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE!=='true'||!env.SHEETS_LEDGER_UAT_SPREADSHEET_ID||!env.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||env.SHEETS_LEDGER_UAT_SPREADSHEET_ID===env.SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID||env.GOOGLE_SPREADSHEET_ID!==env.SHEETS_LEDGER_UAT_SPREADSHEET_ID||!env.SHEETS_LEDGER_UAT_DATABASE_MARKER)throw new Error('SYNTHETIC_RAW_UAT_UNVERIFIED');
  try{const marker=await env.DB.prepare(`SELECT marker FROM ledger_stable_uat_guard WHERE marker=?`).bind(env.SHEETS_LEDGER_UAT_DATABASE_MARKER).first<{marker:string}>();if(!marker)throw new Error('missing');}catch{throw new Error('SYNTHETIC_RAW_DATABASE_UNVERIFIED');}
}

/** Isolated UAT only. A missing, failed, ambiguous or prior in-flight
 * projection is never retried blindly; the durable outbox is held for review.
 * The caller must provide a pre-existing synthetic expense and outbox. */
export async function runSyntheticExpenseWorkflow(env:Env,job:SheetsSyncJob,adapters:SyntheticProjectionAdapters):Promise<SyntheticWorkflowResult>{
  if(job.kind!=='SHEETS_SYNC'||job.entityType!=='EXPENSE'||!Number.isSafeInteger(job.entityVersion)||job.entityVersion<1)throw new Error('SYNTHETIC_WORKFLOW_INVALID');
  assertStableShadowConfig(env,job.entityKey);await assertStableShadowDatabase(env);await assertSyntheticLedgerUat(env);
  const existing=await env.DB.prepare(`SELECT status FROM sync_jobs WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=?`).bind(job.entityKey,job.entityVersion).first<{status:string}>();
  if(!existing)throw new Error('SYNTHETIC_WORKFLOW_OUTBOX_MISSING');
  if(existing.status==='REVIEW'||existing.status==='COMPLETED')return 'REVIEW';
  const now=new Date().toISOString(),lease=crypto.randomUUID();
  const claim=await env.DB.prepare(`UPDATE sync_jobs SET status='PROCESSING',attempt_count=attempt_count+1,updated_at=?,next_attempt_at=NULL,lease_until=?,lease_token=?,last_error=NULL
    WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status IN ('PENDING','FAILED') AND (next_attempt_at IS NULL OR next_attempt_at<=?)
    AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=? AND j.status IN ('PROCESSING','REVIEW'))
    AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES' AND substr(f.job_key,1,length(sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':'))=sync_jobs.entity_type || ':' || sync_jobs.entity_key || ':')`).bind(now,new Date(Date.now()+15*60_000).toISOString(),lease,job.entityKey,job.entityVersion,now,job.entityKey).run();
  if(Number(claim.meta.changes||0)!==1)return 'BUSY';
  const journal=new SyntheticExpenseProjectionJournal(env,job,lease);
  const hold=async()=>{const r=await env.DB.prepare(`UPDATE sync_jobs SET status='REVIEW',updated_at=?,next_attempt_at=NULL,lease_until=NULL,lease_token=NULL,last_error='SYNTHETIC_WORKFLOW_REVIEW_REQUIRED' WHERE entity_type='EXPENSE' AND entity_key=? AND entity_version=? AND status='PROCESSING' AND lease_token=?`).bind(new Date().toISOString(),job.entityKey,job.entityVersion,lease).run();if(Number(r.meta.changes||0)!==1)throw new Error('SYNTHETIC_WORKFLOW_OUTBOX_OWNERSHIP_LOST');};
  try{
    for(const projection of ['DAILY','RAW','DETAIL'] as const){
      const eligible=await classifyStableShadowSource(env,job.entityKey,job.entityVersion);if(eligible.kind==='REVIEW'||!adapters[projection]){await hold();return 'REVIEW';}
      const token=await journal.begin(projection);if(!token){await hold();return 'REVIEW';}
      const requireDispatchFence=async()=>{assertStableShadowConfig(env,job.entityKey);await assertStableShadowDatabase(env);await assertSyntheticLedgerUat(env);if(!await journal.canDispatch(projection,token,eligible))throw new Error('SYNTHETIC_WORKFLOW_DISPATCH_FENCE_LOST');};
      try{await requireDispatchFence();const evidence=await adapters[projection]!(requireDispatchFence);if(evidence==='PARTIAL'||!await journal.verify(projection,token,evidence)){await journal.hold(projection,token);await hold();return 'REVIEW';}}
      catch{await journal.hold(projection,token);await hold();return 'REVIEW';}
    }
    if(!await journal.complete()){await hold();return 'REVIEW';}
    return 'VERIFIED';
  }catch(error){await hold();throw error;}
}

/** Actual daily plus RAW CORE UAT adapters. CORE deliberately remains PARTIAL:
 * it cannot establish the document/submitter columns or the DETAIL projection. */
export async function runSyntheticDailyAndRawCoreWorkflow(env:Env,job:SheetsSyncJob):Promise<SyntheticWorkflowResult>{
  // Both independent QA bindings must be established before DAILY can write.
  assertStableShadowConfig(env,job.entityKey);await assertStableShadowDatabase(env);await assertSyntheticLedgerUat(env);
  return runSyntheticExpenseWorkflow(env,job,{DAILY:async beforeDispatch=>{
    const loaded=await loadExpenseDailyPosting(env,job.entityKey);
    if(loaded.expense.status!=='CONFIRMED'||loaded.record.version!==job.entityVersion)throw new Error('SYNTHETIC_WORKFLOW_SOURCE_CHANGED');
    await writeDailyStableShadow(env,loaded.record,{beforeDispatch});
    const bytes=new TextEncoder().encode(JSON.stringify(['synthetic-daily-readback',job.entityKey,job.entityVersion]));
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
  },RAW:async beforeDispatch=>{
    const loaded=await loadExpenseDailyPosting(env,job.entityKey),e=loaded.expense,sheet=env.SHEET_EXPENSE_RAW;
    if(e.status!=='CONFIRMED'||Number(e.version)!==job.entityVersion||!sheet)throw new Error('SYNTHETIC_WORKFLOW_SOURCE_CHANGED');
    await assertSyntheticLedgerUat(env);
    const enrolled=await env.DB.prepare(`SELECT metadata_id,projected_version FROM ledger_stable_identity_journal WHERE spreadsheet_id=? AND sheet_name=? AND kind='EXPENSE' AND entity_key=? AND scope='CORE' AND state='VERIFIED'`).bind(env.GOOGLE_SPREADSHEET_ID,sheet,job.entityKey).first<{metadata_id:number;projected_version:number}>();
    if(!enrolled||!Number.isSafeInteger(enrolled.metadata_id)||!Number.isSafeInteger(enrolled.projected_version)||enrolled.projected_version>=job.entityVersion)throw new Error('SYNTHETIC_RAW_ENROLLMENT_UNAVAILABLE');
    const metadata=await getLedgerUatSnapshotPart(env,`/developerMetadata/${enrolled.metadata_id}`) as {location?:{dimensionRange?:{sheetId?:unknown}}};
    const sheetId=metadata?.location?.dimensionRange?.sheetId;if(!Number.isSafeInteger(sheetId)||Number(sheetId)<0)throw new Error('SYNTHETIC_RAW_METADATA_UNVERIFIED');
    const identity={kind:'EXPENSE' as const,sheetId:Number(sheetId),entityId:job.entityKey};
    const proof:LedgerSourceProof={kind:'EXPENSE',id:job.entityKey,version:job.entityVersion,status:'CONFIRMED',transactionDate:String(e.transaction_date),description:String(e.description),amountSatang:Number(e.amount_satang),paymentKey:String(e.payment_key),sourceWallet:String(e.source_wallet),category:String(e.category),updatedAt:e.updated_at==null?null:String(e.updated_at)};
    const result=await projectExistingLedgerShadow(env,sheet,proof,identity,enrolled.metadata_id,enrolled.projected_version,buildExpenseRawSheetValues(e,loaded.summaryDocument),crypto.randomUUID(),createLedgerGoogleUatProbe(env,sheet,identity,enrolled.metadata_id),{beforeDispatch});
    if(result!=='VERIFIED')throw new Error('SYNTHETIC_RAW_CORE_REVIEW');return 'PARTIAL';
  }});
}
