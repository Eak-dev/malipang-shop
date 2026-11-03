import type {Env,SheetsSyncJob} from '../types';
import {ExpenseProjectionRuntimeJournal,type ExpenseProjectionContext,type ExpenseGenerationLease} from './expense-projection-runtime-journal';
import {rawSourceStillMatches,type RawSourceProof} from './raw-source-proof';

/**
 * Default-off candidate for a NEW expense admitted after cutover. Sheet lock
 * and metadata identity live in the existing D1 database; no row number is
 * retained. Locks do not expire. No production route, automatic completion,
 * unlock, replay, or legacy enrollment is implemented here.
 */
export class FullRawAppendIntent{
  private readonly job:SheetsSyncJob;
  private readonly context:ExpenseProjectionContext;
  private readonly outer:ExpenseProjectionRuntimeJournal;
  // A fresh process may inspect a held operation, but never resumes it merely
  // because a previous D1 acknowledgement was lost.
  private acknowledgedLock:string|null=null;
  private acknowledgedReservation:{token:string;metadataId:number}|null=null;
  private acknowledgedDispatch:{token:string;metadataId:number}|null=null;
  private providerDispatchClaimed=false;
  constructor(private readonly env:Env,job:SheetsSyncJob,private readonly lease:string,private readonly outerToken:string,context:ExpenseProjectionContext,generationLease?:ExpenseGenerationLease){this.job={...job};this.context={...context};this.outer=new ExpenseProjectionRuntimeJournal(env,this.job,lease,generationLease);}
  private check(source:RawSourceProof,token:string,metadataId?:number):void{
    const e=this.env,c=this.context,j=this.job;
    if(e.RUNTIME_MODE!=='production'||e.RAW_APPEND_WRITER_ENABLED!=='true'||e.RAW_FULL_IDENTITY_WRITER_ENABLED!=='true'||e.EXPENSE_STABLE_PROJECTION_ENABLED!=='true'||e.DAILY_LEGACY_WRITER_GATE_ENABLED!=='true'||!e.GOOGLE_SPREADSHEET_ID||!e.SHEET_EXPENSE_RAW||!e.SHEET_EXPENSE_DAILY||j.kind!=='SHEETS_SYNC'||j.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(j.entityKey)||!Number.isSafeInteger(j.entityVersion)||j.entityVersion<1||source.kind!=='EXPENSE'||source.entityId!==j.entityKey||source.version!==j.entityVersion||!/^[a-f0-9]{64}$/.test(source.fingerprint)||!/^[-A-Za-z0-9_]{16,128}$/.test(token)||!/^[-A-Za-z0-9_]{8,128}$/.test(this.lease)||!/^[-A-Za-z0-9_]{8,128}$/.test(this.outerToken)||!Number.isSafeInteger(c.revision)||c.revision<1||!Number.isSafeInteger(c.watermark)||c.watermark<0||!/^[-A-Za-z0-9_]{8,128}$/.test(c.generation)||metadataId!==undefined&&(!Number.isSafeInteger(metadataId)||metadataId<1||metadataId>2147483647))throw Error('FULL_RAW_APPEND_DISABLED');
  }
  /** One active owner per RAW sheet. A failed or lost acknowledgement never
   * grants another owner permission to acquire. */
  async acquire(source:RawSourceProof,token:string):Promise<boolean>{
    this.check(source,token);if(!await rawSourceStillMatches(this.env,source))return false;const fence=this.outer.dispatchFence('RAW',this.outerToken,this.context);
    const r=await this.env.DB.prepare(`INSERT INTO full_raw_sheet_locks(spreadsheet_id,sheet_name,state,expense_id,operation_token,outer_token,cutover_generation,updated_at)
      SELECT ?,?,'HELD',?,?,?,?,? WHERE ${fence.sql} ON CONFLICT(spreadsheet_id,sheet_name) DO NOTHING`)
      .bind(this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,token,this.outerToken,this.context.generation,new Date().toISOString(),...fence.args).run();
    if(Number(r.meta.changes||0)!==1)return false;this.acknowledgedLock=token;return true;
  }
  /** Bind a fixed metadata ID to this operation before any Sheet mutation. */
  async reserve(source:RawSourceProof,metadataId:number,token:string):Promise<boolean>{
    this.check(source,token,metadataId);if(this.acknowledgedLock!==token||!await rawSourceStillMatches(this.env,source))return false;const fence=this.outer.dispatchFence('RAW',this.outerToken,this.context);
    const r=await this.env.DB.prepare(`INSERT INTO full_raw_append_intents(spreadsheet_id,sheet_name,expense_id,metadata_id,state,source_version,source_revision,source_fingerprint,operation_token,outer_token,cutover_generation,updated_at)
      SELECT ?,?,?,?,'RESERVED',?,?,?,?,?,?,? WHERE ${fence.sql}
      AND EXISTS(SELECT 1 FROM full_raw_sheet_locks l WHERE l.spreadsheet_id=? AND l.sheet_name=? AND l.state='HELD' AND l.expense_id=? AND l.operation_token=? AND l.outer_token=? AND l.cutover_generation=?)
      AND NOT EXISTS(SELECT 1 FROM full_raw_identity_intents i WHERE i.spreadsheet_id=? AND (i.metadata_id=? OR (i.sheet_name=? AND i.expense_id=?))) ON CONFLICT DO NOTHING`)
      .bind(this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,source.version,this.context.revision,source.fingerprint,token,this.outerToken,this.context.generation,new Date().toISOString(),...fence.args,this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,token,this.outerToken,this.context.generation,this.env.GOOGLE_SPREADSHEET_ID,metadataId,this.env.SHEET_EXPENSE_RAW,this.job.entityKey).run();
    if(Number(r.meta.changes||0)!==1)return false;this.acknowledgedReservation={token,metadataId};return true;
  }
  /** Persist IN_FLIGHT before dispatch; never infer safety from a timeout. */
  async beginDispatch(source:RawSourceProof,metadataId:number,token:string):Promise<boolean>{
    this.check(source,token,metadataId);if(this.acknowledgedReservation?.token!==token||this.acknowledgedReservation.metadataId!==metadataId||!await rawSourceStillMatches(this.env,source))return false;const fence=this.outer.dispatchFence('RAW',this.outerToken,this.context);
    const r=await this.env.DB.prepare(`UPDATE full_raw_append_intents SET state='IN_FLIGHT',updated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND expense_id=? AND metadata_id=? AND state='RESERVED' AND source_version=? AND source_revision=? AND source_fingerprint=? AND operation_token=? AND outer_token=? AND cutover_generation=? AND ${fence.sql}
      AND EXISTS(SELECT 1 FROM full_raw_sheet_locks l WHERE l.spreadsheet_id=? AND l.sheet_name=? AND l.state='HELD' AND l.expense_id=? AND l.operation_token=? AND l.outer_token=? AND l.cutover_generation=?)`)
      .bind(new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,source.version,this.context.revision,source.fingerprint,token,this.outerToken,this.context.generation,...fence.args,this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,token,this.outerToken,this.context.generation).run();
    if(Number(r.meta.changes||0)!==1)return false;this.acknowledgedDispatch={token,metadataId};return true;
  }
  private async checkDispatchFence(source:RawSourceProof,metadataId:number,token:string):Promise<boolean>{
    this.check(source,token,metadataId);if(this.acknowledgedDispatch?.token!==token||this.acknowledgedDispatch.metadataId!==metadataId||!await rawSourceStillMatches(this.env,source))return false;const fence=this.outer.dispatchFence('RAW',this.outerToken,this.context);
    const r=await this.env.DB.prepare(`SELECT 1 AS ok FROM full_raw_append_intents i JOIN full_raw_sheet_locks l ON l.spreadsheet_id=i.spreadsheet_id AND l.sheet_name=i.sheet_name AND l.state='HELD' AND l.expense_id=i.expense_id AND l.operation_token=i.operation_token AND l.outer_token=i.outer_token AND l.cutover_generation=i.cutover_generation
      WHERE i.spreadsheet_id=? AND i.sheet_name=? AND i.expense_id=? AND i.metadata_id=? AND i.state='IN_FLIGHT' AND i.source_version=? AND i.source_revision=? AND i.source_fingerprint=? AND i.operation_token=? AND i.outer_token=? AND i.cutover_generation=? AND ${fence.sql}`)
      .bind(this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,source.version,this.context.revision,source.fingerprint,token,this.outerToken,this.context.generation,...fence.args).first<{ok:number}>();return !!r;
  }
  /** One attempt per object, including a failed preflight. This is not a
   * provider dispatch itself; the eventual transport must not reuse the result
   * or replay a request whose outcome is unknown. A new process cannot resume
   * because acknowledgement state is not restored automatically. */
  async claimProviderDispatch(source:RawSourceProof,metadataId:number,token:string):Promise<boolean>{
    if(this.providerDispatchClaimed)return false;this.providerDispatchClaimed=true;
    try{return await this.checkDispatchFence(source,metadataId,token);}catch{return false;}
  }
  /** Hold lock first, then intent. Partial failure still cannot free the sheet. */
  async hold(token:string):Promise<boolean>{
    if(!/^[-A-Za-z0-9_]{16,128}$/.test(token)||!this.env.GOOGLE_SPREADSHEET_ID||!this.env.SHEET_EXPENSE_RAW)throw Error('FULL_RAW_APPEND_INVALID');
    const lock=await this.env.DB.prepare(`UPDATE full_raw_sheet_locks SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND expense_id=? AND operation_token=? AND outer_token=? AND state IN ('HELD','REVIEW')`).bind(new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,token,this.outerToken).run();
    if(Number(lock.meta.changes||0)!==1)return false;
    const intent=await this.env.DB.prepare(`UPDATE full_raw_append_intents SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND expense_id=? AND operation_token=? AND outer_token=? AND state IN ('RESERVED','IN_FLIGHT','REVIEW')`).bind(new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,token,this.outerToken).run();return Number(intent.meta.changes||0)===1;
  }
  /** Hold the sheet/identity and the outer projection without assuming which
   * prior D1 or Google operation committed. No retry or unlock is implied. */
  async holdAndFenceOuter(token:string):Promise<'REVIEW'|'REVIEW_LOCAL_STATE_UNCERTAIN'|'OUTER_HOLD_UNCONFIRMED'>{
    let localHeld=false;try{localHeld=await this.hold(token);}catch{/* lock or intent may already be durable */}
    try{if(!await this.outer.hold('RAW',this.outerToken))return 'OUTER_HOLD_UNCONFIRMED';}catch{return 'OUTER_HOLD_UNCONFIRMED';}
    return localHeld?'REVIEW':'REVIEW_LOCAL_STATE_UNCERTAIN';
  }
}
