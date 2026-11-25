import {consumeCapturedProjectionProof,type CapturedProjectionProof} from './stable-expense-final-check';
import {takePausedPilot,inheritPausedPilot,verifiedPilotStage,attestedPilotOwned,type PausedPilot} from './parked-notice-adoption';
import {claimAttestedContinuationDraft,continuationFenceOwned,recordAttestedLedgerStageDraft,preflightAttestedFinalDraft,recordAttestedFinalDraft,completeAttestedFinalDraft,releaseAttestedLedgerStageDraft,releaseAttestedNoticeDraft} from './serial-notice-release-draft';
import {hasTerminalSheetHold,STABLE_TERMINAL_HOLD} from './sheet-terminal-hold';
import type {Env,SheetsSyncJob} from '../types';
import type {ReviewRequestBudget} from './review-request-budget';
import type {GoogleOAuthLease} from './google-auth';
import {hasNormalNoticeHandoff,normalNoticeHandoffReady,wakeNormalNoticeHandoff} from './continuous-normal-notice-handoff';
import {beginStableNotice,endStableNotice,stableNoticePaused,readStablePausedNotice} from './stable-edit-notice';
import {stableFaultReason} from './stable-fault';
import {SheetsHttpError} from './client';
import {admitStableRecovery,verifyStableRecoveryAdmission,holdStableRecoveryCapacity,completeStableRecoveryTarget,stableRecoveryGateBlocked,recoveryGateConfigured,STABLE_RECOVERY_BLOCKED,type RecoveryIdentity} from './stable-recovery-admission';
import {admitPacedWorkbookOperation,pacingPreflightBlocked,STABLE_SHEETS_PACING_BLOCKED,STABLE_SHEETS_PACING_UNAVAILABLE} from './stable-sheet-pacing';

export type StableClaimPhase='ADMISSION'|'BEGIN_NOTICE'|'OPERATION'|'END_NOTICE'|'RELEASE';
export const STABLE_NOTICE_READ_DEFERRED='STABLE_NOTICE_READ_DEFERRED';
export const STABLE_NONFINANCIAL_JOB_CLOSED='STABLE_NONFINANCIAL_JOB_CLOSED';
type SheetIdentity=Extract<RecoveryIdentity,{entityType:string}>;
async function nonfinancialJobClosed(db:D1Database,job:SheetIdentity):Promise<boolean>{
 const row=await db.prepare("SELECT status FROM sync_jobs WHERE entity_type=? AND entity_key=? AND entity_version=?").bind(job.entityType,job.entityKey,job.entityVersion).first<{status:string}>();
 return row?.status==='REVIEW'||row?.status==='COMPLETED';
}
function readMayBeSafelyDeferred(error:unknown):boolean{
  return error instanceof SheetsHttpError && error.message==='STABLE_NOTICE_READ' &&
    (error.status===429||error.status>=500&&error.status<=599);
}

/** Read-only. A retained review claim blocks every workbook writer until an
 * operator investigates it; retrying sooner only spends D1, queue and Sheets
 * quota without making progress. */
export async function stableWorkbookInReview(env:Env):Promise<boolean>{
  if(env.STABLE_PHASE1_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID)return false;
  const row=await env.DB.prepare("SELECT 1 AS review FROM stable_workbook_claims WHERE spreadsheet_id=? AND state='REVIEW'").bind(env.GOOGLE_SPREADSHEET_ID).first<{review:number}>();
  return row?.review===1;
}

async function retainForReview(db:D1Database,book:string,token:string,phase:StableClaimPhase,error:unknown):Promise<void>{
  const reason=stableFaultReason(error);
  console.error('stable-workbook-review',{phase,reason,operation:token.slice(0,8)});
  try{await db.prepare("UPDATE stable_workbook_claims SET state='REVIEW',phase=?,review_reason=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind(phase,reason,book,token).run();return;}
  catch{/* A serial claim keeps its durable phase while recording the cause. */}
  try{await db.prepare("UPDATE stable_workbook_claims SET state='REVIEW',review_reason=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind(reason,book,token).run();return;}
  catch{/* Migration 0022 may not be applied yet. */}
  try{await db.prepare("UPDATE stable_workbook_claims SET state='REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind(book,token).run();}catch{/* The remaining HELD state also blocks later operations. */}
}

/** A point-in-time check only. Callers still need a guarded write intent and
 * a final provider readback; this check is not a Google Sheets lock. */
const serialMockEnabled=(env:Env)=>env.APP_ENV==='test'&&env.SERIAL_ATTESTED_HANDOFF_ENABLED==='true'&&env.SERIAL_MOCK_CONTINUATION_ENABLED==='true';
const serialMockScope=(env:Env & {CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED?:string;CONTINUOUS_CANARY_OPERATOR_ENABLED?:string})=>JSON.stringify([env.APP_ENV,env.RUNTIME_MODE,env.SERIAL_ATTESTED_HANDOFF_ENABLED,env.SERIAL_MOCK_CONTINUATION_ENABLED,env.SERIAL_MOCK_FINAL_COMPLETION_ENABLED,env.CF_VERSION_METADATA?.id,env.GOOGLE_SPREADSHEET_ID,env.GOOGLE_SERVICE_ACCOUNT_EMAIL,env.GOOGLE_PRIVATE_KEY_BASE64,env.EXTERNAL_API_TIMEOUT_MS,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS,env.SHEET_ATTENDANCE_RAW,env.SHEET_DAILY_PAYROLL,env.SHEET_OT_REQUESTS,env.SHEET_PERSONAL_USE_RAW,env.SHEET_SHIFT_SCHEDULE,env.SHEET_STAFF_CONFIG,env.SHEET_SYSTEM_LOG,env.SHEET_WAGE_HISTORY,env.SHEET_WEEKLY_PAYROLL,env.CONTINUOUS_DAILY_SHEET,env.CONTINUOUS_DAILY_SHEET_ID,env.CONTINUOUS_RAW_SHEET,env.CONTINUOUS_RAW_SHEET_ID,env.CONTINUOUS_DETAIL_SHEET,env.CONTINUOUS_DETAIL_SHEET_ID,env.STABLE_PHASE1_ENABLED,env.STABLE_RECOVERY_GATE_ENABLED,env.STABLE_SHEETS_PACING_ENABLED,env.STABLE_CANCELLATION_PREIMAGE_ENABLED,env.SHEETS_SYNC_ENABLED,env.CONTINUOUS_DAILY_ENABLED,env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED,env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED,env.CONTINUOUS_CANARY_OPERATOR_ENABLED,env.MONTHLY_REPORT_OPERATOR_ENABLED,env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED,env.CONTINUOUS_PUBLICATION_ENABLED,env.CANARY_UNWRITTEN_RECOVERY_ENABLED,env.UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED,env.CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED,env.EXACT_DAILY_SETTLEMENT_ENABLED]);
// Extra in-process scope pin for a claim already acquired in the local mock.
// D1/session fencing remains authoritative after an invocation is interrupted.
type SerialMockBinding={scope:string;check:()=>Promise<boolean>};
const serialMockClaims=new WeakMap<Env,Map<string,SerialMockBinding>>();
function rememberMockClaim(env:Env,token:string,binding:SerialMockBinding){const claims=serialMockClaims.get(env)??new Map<string,SerialMockBinding>();if(claims.has(token))throw Error('SERIAL_MOCK_BINDING_CONFLICT');claims.set(token,binding);serialMockClaims.set(env,claims);}
function forgetMockClaim(env:Env,token:string){serialMockClaims.get(env)?.delete(token);}
export async function stableWorkbookClaimOwned(env:Env,token:string,budget?:ReviewRequestBudget,oauthLease?:GoogleOAuthLease):Promise<boolean>{
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,flag=env.STABLE_PHASE1_ENABLED;if(!book||!token)return false;
  const pinnedClaim=serialMockClaims.get(env)?.get(token);
  if(pinnedClaim===undefined){
    // Read the provider first, then bind its snapshot to the current D1 claim.
    // This preserves the last D1 check after the asynchronous provider read.
    const notice=flag==='true'?await readStablePausedNotice(env,budget,oauthLease):null;
    if(flag==='true'&&!notice||env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag)return false;
    const counts="(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='serial_pilot_attested_handoffs') AS handoffs,(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='serial_pilot_oracle_fence') AS oracle,(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='serial_pilot_continuation_sessions') AS sessions";
    type Current={phase?:string|null;notice_stamp?:string|null;notice_identity?:string|null;handoffs:number;oracle:number;sessions:number;serial_handoff?:number};
    let current:Current|null;
    try{
      current=await db.prepare(`SELECT c.*,${counts},EXISTS(SELECT 1 FROM serial_pilot_attested_handoffs h WHERE h.spreadsheet_id=c.spreadsheet_id AND h.claim_token=c.operation_token) AS serial_handoff FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD'`).bind(book,token).first<Current>();
    }catch{
      // A genuine pre-0072 database has none of these tables. An incomplete
      // serial schema is rejected by the shape check below, not treated as legacy.
      try{current=await db.prepare(`SELECT c.*,${counts} FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD'`).bind(book,token).first<Current>();}
      catch{return false;}
      if(!current||current.handoffs!==0||current.oracle!==0||current.sessions!==0)return false;
    }
    if(!current||current.handoffs!==current.oracle||current.handoffs===1&&!Object.prototype.hasOwnProperty.call(current,'phase')||current.sessions>current.handoffs||![0,1].includes(current.handoffs)||![0,1].includes(current.sessions)||current.serial_handoff===1||['PILOT_RESERVED','PILOT_TAKEN','SERIAL_CONTINUATION','SERIAL_PILOT_ADOPTED','SERIAL_FINAL_RELEASE'].includes(current.phase??'')||notice&&(current.notice_stamp!==notice.stamp||current.notice_identity!==notice.identity)||env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag)return false;
    if(serialMockEnabled(env)&&await continuationFenceOwned(env,token,()=>env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.STABLE_PHASE1_ENABLED===flag)!=='NO_SESSION')return false;
    return env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.STABLE_PHASE1_ENABLED===flag;
  }
  const schemaCounts="(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='serial_pilot_attested_handoffs') AS handoffs,(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='serial_pilot_oracle_fence') AS oracle,(SELECT count(*) FROM sqlite_master WHERE type='table' AND name='serial_pilot_continuation_sessions') AS sessions";
  const row=await db.prepare(`SELECT 1 AS ok,notice_stamp,notice_identity,phase,${schemaCounts} FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'`).bind(book,token).first<{ok:number;notice_stamp:string|null;notice_identity:string|null;phase:string|null;handoffs:number;oracle:number;sessions:number}>();
  if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag||row?.ok!==1)return false;
  const pinned=serialMockClaims.get(env)?.get(token),scope=serialMockScope(env);
  // Reservation/take are not provider-write authority. Adoption installs
  // the identity and phase first, avoiding a race with serial transfer.
  if(pinned===undefined&&['PILOT_RESERVED','PILOT_TAKEN','SERIAL_CONTINUATION','SERIAL_PILOT_ADOPTED','SERIAL_FINAL_RELEASE'].includes(row.phase??''))return false;
  if(pinned!==undefined&&(!serialMockEnabled(env)||pinned.scope!==scope||!await pinned.check()))return false;
  // A damaged/partial serial installation must not turn an attested claim
  // into a legacy authorization just because its in-memory pin is absent.
  const legacyStillOwned=async()=>{
    try{
      if(![0,1].includes(row.handoffs)||![0,1].includes(row.oracle)||![0,1].includes(row.sessions)||row.handoffs!==row.oracle||row.sessions>row.handoffs)return false;
      const noHandoff=row.handoffs===1?' AND NOT EXISTS(SELECT 1 FROM serial_pilot_attested_handoffs h WHERE h.spreadsheet_id=c.spreadsheet_id AND h.claim_token=c.operation_token)':'';
      const current=await db.prepare(`SELECT 1 AS found FROM stable_workbook_claims c WHERE c.spreadsheet_id=? AND c.operation_token=? AND c.state='HELD' AND c.phase IS ? AND c.notice_stamp IS ? AND c.notice_identity IS ? AND (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='serial_pilot_attested_handoffs')=? AND (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='serial_pilot_oracle_fence')=? AND (SELECT count(*) FROM sqlite_master WHERE type='table' AND name='serial_pilot_continuation_sessions')=?${noHandoff}`).bind(book,token,row.phase,row.notice_stamp,row.notice_identity,row.handoffs,row.oracle,row.sessions).first<{found:number}>();
      return current?.found===1&&env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.STABLE_PHASE1_ENABLED===flag;
    }catch{return false;}
  };
  if(pinned===undefined&&(!await legacyStillOwned()||serialMockEnabled(env)&&await continuationFenceOwned(env,token,()=>env.DB===db&&serialMockScope(env)===scope)!=='NO_SESSION'))return false;
  const paused=flag==='true'?!!row.notice_stamp&&!!row.notice_identity&&await stableNoticePaused(env,row.notice_stamp,row.notice_identity,budget,oauthLease):true;
  if(!paused||env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag)return false;
  return pinned===undefined?await legacyStillOwned():serialMockClaims.get(env)?.get(token)===pinned&&serialMockEnabled(env)&&serialMockScope(env)===pinned.scope&&await pinned.check();
}

/** A durable guard for one workbook operation. It does not itself stop a
 * human editor, an old deployment, or any writer not using this guard.
 * The caller must return only after all provider writes are read back and
 * verified; an exception retains the claim for review rather than retrying. */
export async function withStableWorkbookClaim<T>(env:Env,operation:(token:string,captureFinalProof?: (proof:CapturedProjectionProof)=>Promise<void>)=>Promise<T>,identity?:RecoveryIdentity,onUntouchedNoticeFailure?:(token:string,error:unknown)=>Promise<{value:T}|null>,invocationBudget?:ReviewRequestBudget,expenseInvocation?:{job:SheetsSyncJob;lease:string}):Promise<T>{
  const db=env.DB,book=env.GOOGLE_SPREADSHEET_ID,flag=env.STABLE_PHASE1_ENABLED,gateSetting=env.STABLE_RECOVERY_GATE_ENABLED,pacingSetting=env.STABLE_SHEETS_PACING_ENABLED;
  let token:string=crypto.randomUUID(),pilot:PausedPilot|null=null,continuation=false;
  let finalProof:CapturedProjectionProof|undefined;
  const mockEnabled=serialMockEnabled(env),mockScope=serialMockScope(env);
  const mockStable=()=>db===env.DB&&serialMockEnabled(env)===mockEnabled&&serialMockScope(env)===mockScope;
  const handoffFlag=env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED;
  const untouchedScope=()=>env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED===handoffFlag&&env.DB===db&&env.GOOGLE_SPREADSHEET_ID===book&&env.STABLE_PHASE1_ENABLED===flag&&env.STABLE_RECOVERY_GATE_ENABLED===gateSetting&&env.STABLE_SHEETS_PACING_ENABLED===pacingSetting;
  const sheetJob=identity&&'entityType' in identity?identity:undefined;
  const boundedNotice=sheetJob?.entityType==='EXPENSE'&&env.CONTINUOUS_DAILY_ENABLED==='true';
  const guardedJob=sheetJob&&sheetJob.entityType!=='EXPENSE'&&sheetJob.entityType!=='PERSONAL_USE'?sheetJob:undefined;
  if(!book)throw new Error('STABLE_WORKBOOK_NOT_CONFIGURED');
  // The normal notice handoff has a different release protocol. A serial
  // mock invocation must never enter it, including before notice dispatch.
  if(mockEnabled&&handoffFlag==='true')throw Error('SERIAL_MOCK_HANDOFF_INCOMPATIBLE');
  if(handoffFlag==='true'&&sheetJob?.entityType==='EXPENSE'&&!await normalNoticeHandoffReady(env))throw Error('NORMAL_NOTICE_HANDOFF_NOT_READY');
  // Fast deny before reserving the shared workbook; the atomic D1 admission
  // below remains authoritative against concurrent queue invocations.
  if(await stableRecoveryGateBlocked(env,identity))throw Error(STABLE_RECOVERY_BLOCKED);
  if(await pacingPreflightBlocked(env))throw Error(STABLE_SHEETS_PACING_UNAVAILABLE);
  let claimed=false,phase:StableClaimPhase='ADMISSION',beginNoticeMayHaveWritten=false;
  try{
    const admissionSql=sheetJob?`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at)
      SELECT ?,?,'HELD',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=? AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') ${guardedJob?"AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type=? AND j.entity_key=? AND j.entity_version=? AND j.status IN ('REVIEW','COMPLETED'))":''} ON CONFLICT DO NOTHING`:`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at)
      VALUES(?,?,'HELD',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT DO NOTHING`;
    const args:unknown[]=sheetJob?[book,token,`${sheetJob.entityType}:${sheetJob.entityKey}:${sheetJob.entityVersion}`,...(guardedJob?[guardedJob.entityType,guardedJob.entityKey,guardedJob.entityVersion]:[])]:[book,token];
    let inserted:{success?:boolean;meta?:{changes?:number}};
    if(mockEnabled){
      const sessions=await db.prepare(`SELECT s.job_id,j.entity_type,j.entity_key,j.entity_version,j.trace_id FROM serial_pilot_continuation_sessions s LEFT JOIN sync_jobs j ON j.job_id=s.job_id WHERE s.spreadsheet_id=? AND NOT EXISTS(SELECT 1 FROM serial_pilot_continuation_completions x WHERE x.epoch_id=s.epoch_id) LIMIT 2`).bind(book).all<{job_id:string;entity_type:string;entity_key:string;entity_version:number;trace_id:string}>();
      if(!mockStable()||sessions.success!==true||!Array.isArray(sessions.results)||sessions.results.length>1)throw Error('SERIAL_CONTINUATION_UNVERIFIED');
      const active=sessions.results[0];
      if(active){
        if(!expenseInvocation||sheetJob!==expenseInvocation.job||active.entity_type!==expenseInvocation.job.entityType||active.entity_key!==expenseInvocation.job.entityKey||active.entity_version!==expenseInvocation.job.entityVersion||active.trace_id!==expenseInvocation.job.traceId)throw Error('SERIAL_CONTINUATION_FENCED');
        if(await claimAttestedContinuationDraft(env,expenseInvocation.job,expenseInvocation.lease,token,mockStable)!=='CLAIMED')throw Error('SERIAL_CONTINUATION_CLAIM_UNVERIFIED');
        continuation=true;rememberMockClaim(env,token,{scope:mockScope,check:async()=>await continuationFenceOwned(env,token,mockStable)==='OWNED'});inserted={success:true,meta:{changes:1}};
      }else{
        // A transferred claim is protected against every INSERT collision,
        // including ON CONFLICT DO NOTHING. Inspect it without inserting so
        // the exact takePausedPilot CAS can compete for the existing claim.
        const transferred=await db.prepare(`SELECT 1 AS found FROM stable_workbook_claims c JOIN serial_pilot_attested_handoffs h ON h.spreadsheet_id=c.spreadsheet_id AND h.claim_token=c.operation_token WHERE c.spreadsheet_id=? LIMIT 1`).bind(book).first<{found:number}>();
        if(!mockStable())throw Error('SERIAL_CONTINUATION_UNVERIFIED');
        inserted=transferred?.found===1?{success:true,meta:{changes:0}}:await db.prepare(admissionSql).bind(...args).run();
      }
    }else inserted=await db.prepare(admissionSql).bind(...args).run();
    if(inserted.success!==true||!Number.isSafeInteger(inserted.meta?.changes))throw new Error('STABLE_WORKBOOK_CLAIM_OUTCOME_UNKNOWN');
    if(Number(inserted.meta?.changes)!==1&&sheetJob?.entityType==='EXPENSE'&&expenseInvocation&&sheetJob===expenseInvocation.job&&env.CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED==='true'){
      pilot=await takePausedPilot(env,expenseInvocation.job,expenseInvocation.lease,mockEnabled?mockStable:undefined);
      if(pilot){token=pilot.token;if(mockEnabled&&pilot.attestedMode){const ticket=pilot,invocation=expenseInvocation;rememberMockClaim(env,token,{scope:mockScope,check:()=>attestedPilotOwned(env,invocation.job,invocation.lease,ticket)});}}
    }
    if(Number(inserted.meta?.changes)!==1&&!pilot){
      if(sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);
      if(guardedJob&&await nonfinancialJobClosed(db,guardedJob))throw Error(STABLE_NONFINANCIAL_JOB_CLOSED);
      // A held claim is temporary; a review claim waits for an operator. An
      // unreadable state is treated as temporary so it never escalates a job.
      const current=await db.prepare('SELECT state FROM stable_workbook_claims WHERE spreadsheet_id=?').bind(book).first<{state:string}>().catch(()=>null);
      throw new Error(current?.state==='REVIEW'?'STABLE_WORKBOOK_REVIEW':'STABLE_WORKBOOK_BUSY');
    }
    claimed=true;
    const paced=await admitPacedWorkbookOperation(env,identity,token);
    if(!paced){
      if(pilot||continuation)throw Error('PILOT_PACING_REVIEW');
      const released=await db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND notice_stamp IS NULL").bind(book,token).run();
      if(released.success!==true||Number(released.meta?.changes)!==1)throw Error('STABLE_SHEETS_PACING_RELEASE_UNCERTAIN');
      claimed=false;
      throw Error(STABLE_SHEETS_PACING_BLOCKED);
    }
    phase='BEGIN_NOTICE';
    if(pilot&&expenseInvocation){
      beginNoticeMayHaveWritten=true; // The original operation already paused this workbook.
      await inheritPausedPilot(env,expenseInvocation.job,expenseInvocation.lease,pilot,invocationBudget);
    }else if(flag==='true')await beginStableNotice(env,token,undefined,async()=>{
      // The pre-image is verified and no provider POST has been sent yet.
      // Admit here (not before the notice GETs) so a safe read deferral
      // cannot strand an ADMITTED recovery epoch.
      const terminalAtAdmission=!!sheetJob&&sheetJob.entityType==='EXPENSE'&&recoveryGateConfigured(env);
      if(sheetJob&&!terminalAtAdmission&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);
      if(guardedJob&&await nonfinancialJobClosed(db,guardedJob))throw Error(STABLE_NONFINANCIAL_JOB_CLOSED);
      if(continuation&&(!mockStable()||await continuationFenceOwned(env,token,mockStable)!=='OWNED'))throw Error('SERIAL_CONTINUATION_FENCE_UNVERIFIED');
      if(!await admitStableRecovery(env,identity,token)){if(terminalAtAdmission&&sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);throw Error(STABLE_RECOVERY_BLOCKED);}
      // MUST be the last instruction before returning to mutation dispatch:
      // a lost POST acknowledgement must never look like a safe read defer.
      beginNoticeMayHaveWritten=true;
    },boundedNotice,invocationBudget);
    if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag||continuation&&!mockStable())throw new Error('STABLE_WORKBOOK_SCOPE_CHANGED');
    phase='OPERATION';
    // Notice POST may already have been sent, so closed-state drift here must
    // retain REVIEW rather than silently releasing an uncertain claim.
    if(guardedJob&&await nonfinancialJobClosed(db,guardedJob))throw Error(STABLE_NONFINANCIAL_JOB_CLOSED);
    // A terminal signal after notice authorization may race a provider POST.
    // Stop subsequent stages and retain REVIEW; its provider outcome is unknown.
    if(sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);
    const captureFinalProof=continuation?async(proof:CapturedProjectionProof)=>{
      if(finalProof||!expenseInvocation||!mockStable()||await continuationFenceOwned(env,token,mockStable)!=='OWNED'||!mockStable()||!consumeCapturedProjectionProof(proof,env,expenseInvocation.job,token,expenseInvocation.lease))throw Error('SERIAL_FINAL_PROOF_UNVERIFIED');
      finalProof=proof;
    }:undefined;
    const result=await operation(token,captureFinalProof);
    if(sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);
    if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag||mockEnabled&&!mockStable())throw new Error('STABLE_WORKBOOK_SCOPE_CHANGED');
    if(continuation&&result==='COMPLETED'){
      // This is a local-only protocol experiment. The D1 fence does not stop
      // human/external writers; #296 must establish a continuing real fence.
      if(!mockEnabled||env.APP_ENV!=='test'||env.SERIAL_MOCK_FINAL_COMPLETION_ENABLED!=='true'||!finalProof||!mockStable())throw Error('SERIAL_FINAL_COMPLETION_NOT_READY');
      const proof=finalProof,ready=async()=>mockStable()&&await preflightAttestedFinalDraft(env,token,proof,mockStable)&&mockStable();
      if(!await ready())throw Error('SERIAL_FINAL_COMPLETION_NOT_READY');
      phase='END_NOTICE';
      const observation=await endStableNotice(env,token,boundedNotice,async()=>{if(!await ready())throw Error('SERIAL_FINAL_COMPLETION_NOT_READY');},undefined,true);
      if(!observation||!await ready())throw Error('SERIAL_FINAL_NOTICE_UNVERIFIED');
      const finalObservation={providerDigest:proof.providerDigest,providerObservedAt:proof.providerObservedAt,noticeDigest:observation.postimageDigest,noticeObservedAt:observation.observedAt};
      if(await recordAttestedFinalDraft(env,token,finalObservation,mockStable)!=='RECORDED')throw Error('SERIAL_FINAL_RECEIPT_UNVERIFIED');
      const completed=await completeAttestedFinalDraft(env,token,finalObservation,mockStable);
      if(completed!=='COMPLETED'&&completed!=='COMPLETION_RECORDED')throw Error('SERIAL_FINAL_COMPLETION_UNVERIFIED');
      // A reconciled ACK is historical completion of this exact token; it is
      // never evidence that the workbook is currently free.
      claimed=false;forgetMockClaim(env,token);return result;
    }
    if(continuation&&await continuationFenceOwned(env,token,mockStable)!=='OWNED')throw Error('SERIAL_CONTINUATION_FENCE_UNVERIFIED');
    if(handoffFlag==='true'&&sheetJob?.entityType==='EXPENSE'){
      if(env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED!==handoffFlag)throw Error('NORMAL_NOTICE_HANDOFF_SCOPE_CHANGED');
      if(result==='CONTINUE'&&await hasNormalNoticeHandoff(env,token,sheetJob)){claimed=false;await wakeNormalNoticeHandoff(env,token,sheetJob,invocationBudget);return result;}
      // FINAL and no-journal exits need their own durable evidence design.
      // Never fall through to the legacy two-cell notice writer in opt-in mode.
      throw Error('NORMAL_NOTICE_HANDOFF_UNSUPPORTED_STAGE');
    }
    const ticket=pilot;
    const beforeReady=ticket?async()=>{
      if(result!=='CONTINUE'||mockEnabled&&!mockStable()||!await verifiedPilotStage(env,ticket)||mockEnabled&&!mockStable())throw Error('PILOT_STAGE_UNVERIFIED');
    }:continuation?async()=>{if(result!=='CONTINUE'||!mockStable()||await continuationFenceOwned(env,token,mockStable)!=='OWNED')throw Error('SERIAL_CONTINUATION_FENCE_UNVERIFIED');}:undefined;
    phase='END_NOTICE';
    const noticeObservation=flag==='true'?await endStableNotice(env,token,boundedNotice,beforeReady,ticket?.style,!!ticket?.attestedMode||continuation):undefined;
    if(ticket?.attestedMode){
      if(!mockEnabled||!mockStable()||!noticeObservation)throw Error('ATTESTED_PILOT_RELEASE_UNVERIFIED');
      if(await releaseAttestedNoticeDraft(env,ticket,noticeObservation,mockStable)!=='RELEASED')throw Error('ATTESTED_PILOT_RELEASE_UNVERIFIED');
      claimed=false;forgetMockClaim(env,token);return result;
    }
    if(continuation){
      if(!mockStable()||!noticeObservation)throw Error('SERIAL_CONTINUATION_UNVERIFIED');
      const recorded=await recordAttestedLedgerStageDraft(env,token,noticeObservation,mockStable);
      if(recorded!=='RECORDED'&&recorded!=='RECEIPT_RECORDED')throw Error('SERIAL_CONTINUATION_UNVERIFIED');
      if(await releaseAttestedLedgerStageDraft(env,token,noticeObservation,mockStable)!=='RELEASED')throw Error('SERIAL_CONTINUATION_UNVERIFIED');
      claimed=false;forgetMockClaim(env,token);return result;
    }
    if(sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);
    if(env.DB!==db||env.GOOGLE_SPREADSHEET_ID!==book||env.STABLE_PHASE1_ENABLED!==flag)throw new Error('STABLE_WORKBOOK_SCOPE_CHANGED');
    phase='RELEASE';
    // Each stage (DAILY/RAW/DETAIL/FINAL) is independently admitted,
    // and only a fully verified notice lifecycle frees the next stage.
    if(result==='CAPACITY_REVIEW')await holdStableRecoveryCapacity(env,identity,token);
    else {
      await verifyStableRecoveryAdmission(env,token);
      await completeStableRecoveryTarget(env,identity,token);
    }
    const releaseSql=sheetJob?"DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=? AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')":"DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'";
    const releaseArgs:unknown[]=sheetJob?[book,token,`${sheetJob.entityType}:${sheetJob.entityKey}:${sheetJob.entityVersion}`]:[book,token];
    const released=await db.prepare(releaseSql).bind(...releaseArgs).run();
    if(released.success!==true||!Number.isSafeInteger(released.meta?.changes))throw new Error('STABLE_WORKBOOK_RELEASE_OUTCOME_UNKNOWN');
    if(Number(released.meta.changes)!==1){if(sheetJob&&await hasTerminalSheetHold(env,sheetJob))throw Error(STABLE_TERMINAL_HOLD);throw new Error('STABLE_WORKBOOK_RELEASE_OUTCOME_UNKNOWN');}
    claimed=false;
    return result;
  }catch(error){
    // The optional handler is installed only by the continuous expense path.
    // It may cancel its exact never-written source when a classified notice
    // read/authentication fails before the mutation callback authorized a
    // Sheets POST. Any later/ambiguous failure retains the original fence.
    if(claimed&&phase==='BEGIN_NOTICE'&&!beginNoticeMayHaveWritten&&sheetJob?.entityType==='EXPENSE'&&onUntouchedNoticeFailure&&untouchedScope()){
      try{
        const handled=await onUntouchedNoticeFailure(token,error);
        if(handled){
          if(!untouchedScope())throw Error('STABLE_WORKBOOK_SCOPE_CHANGED');
          await verifyStableRecoveryAdmission(env,token);
          await completeStableRecoveryTarget(env,identity,token);
          if(!untouchedScope())throw Error('STABLE_WORKBOOK_SCOPE_CHANGED');
          const released=await db.prepare(`DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND notice_stamp IS NULL AND notice_identity IS NULL
            AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key=? AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')
            AND (?=0 OR EXISTS(SELECT 1 FROM stable_recovery_epochs r JOIN stable_recovery_operations o ON o.epoch_id=r.epoch_id WHERE r.spreadsheet_id=? AND r.state='COMPLETE' AND r.target_type='EXPENSE' AND r.target_key=? AND r.target_version=? AND o.operation_token=? AND o.state='VERIFIED'))`)
            .bind(book,token,`${sheetJob.entityType}:${sheetJob.entityKey}:${sheetJob.entityVersion}`,Number(recoveryGateConfigured(env)),book,sheetJob.entityKey,sheetJob.entityVersion,token).run();
          if(!untouchedScope()||released.success!==true||Number(released.meta?.changes)!==1)throw Error('STABLE_UNTOUCHED_NOTICE_RELEASE_UNCERTAIN');
          claimed=false;return handled.value;
        }
      }catch(handlerError){await retainForReview(db,book,token,phase,handlerError);throw handlerError;}
    }
    // When a *read* failed before the first Sheets mutation was authorized,
    // this claim never wrote to Google. A guarded release is safe; all other
    // errors (including a lost POST ACK) retain the claim for review.
    if(claimed && phase==='BEGIN_NOTICE' && !beginNoticeMayHaveWritten &&
       (env.STABLE_SHEETS_PACING_ENABLED==='true' && readMayBeSafelyDeferred(error) ||
        error instanceof Error && [STABLE_RECOVERY_BLOCKED,STABLE_TERMINAL_HOLD,STABLE_NONFINANCIAL_JOB_CLOSED].includes(error.message))){
      let released=false;
      try{
        const r=await db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD' AND notice_stamp IS NULL AND notice_identity IS NULL").bind(book,token).run();
        released=r.success===true&&Number(r.meta?.changes)===1;
      }catch{}
      if(released){claimed=false;throw Error(error instanceof Error && [STABLE_RECOVERY_BLOCKED,STABLE_TERMINAL_HOLD,STABLE_NONFINANCIAL_JOB_CLOSED].includes(error.message) ? error.message : STABLE_NOTICE_READ_DEFERRED);}
    }
    if(claimed)await retainForReview(db,book,token,phase,error);
    throw error;
  }
}
