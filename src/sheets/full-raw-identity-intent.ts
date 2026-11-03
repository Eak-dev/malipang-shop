import type {Env,SheetsSyncJob} from '../types';
import {digestLedgerCell,type LedgerBaseline} from './ledger-stable-journal';
import {rawProjectionValuesMatch,rawSourceStillMatches,type RawSourceProof} from './raw-source-proof';
import type {RawFullIntentPort} from './raw-full-projection-shadow';
import {ExpenseProjectionRuntimeJournal,type ExpenseProjectionContext} from './expense-projection-runtime-journal';
import {createExpenseRawProductionProbe} from './ledger-google-probe';
import {verifyLedgerMetadataWitness,type LedgerWriteIdentity} from './ledger-metadata-writer';

/** Compatible with the outer expense projection journal; no row address. */
export type FullRawCutoverContext=ExpenseProjectionContext;
export type FullRawFinishResult={status:'VERIFIED';evidenceDigest:string}|{status:'NOT_VERIFIED'|'UNKNOWN'};
export type FullRawFinishDisposition={status:'INNER_VERIFIED_OUTER_IN_FLIGHT';evidenceDigest:string}|{status:'OUTER_REVIEW'|'OUTER_REVIEW_INNER_UNCERTAIN'|'OUTER_HOLD_UNCONFIRMED'};
function canonicalFullExpenseBaseline(value:LedgerBaseline):string{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==16)throw Error('FULL_RAW_BASELINE_INVALID');
  const out:LedgerBaseline={};for(let i=1;i<17;i++){const hash=value[String(i)];if(!/^[a-f0-9]{64}$/.test(hash||''))throw Error('FULL_RAW_BASELINE_INVALID');out[String(i)]=hash!;}
  return JSON.stringify(out);
}

/**
 * Default-off inner identity intent for an already enrolled EXPENSE RAW row.
 * The outer RAW projection intent must already be IN_FLIGHT. No API here
 * enrolls legacy rows, creates new rows, completes the outer projection, or dispatches
 * to Sheets. Missing 0029/0030 tables or guard failures hold by throwing or
 * returning false. Editor exclusion/old-worker drainage remain prerequisites.
 */
export class FullRawIdentityIntent implements RawFullIntentPort{
  private baselineAtBegin:string|null=null;
  private projectedVersionAtBegin:number|null=null;
  private readonly outer:ExpenseProjectionRuntimeJournal;
  private readonly job:SheetsSyncJob;
  private readonly context:FullRawCutoverContext;
  constructor(private readonly env:Env,job:SheetsSyncJob,private readonly lease:string,private readonly outerToken:string,context:FullRawCutoverContext){this.job={...job};this.context={...context};this.outer=new ExpenseProjectionRuntimeJournal(env,this.job,lease);}
  private check():void{
    const e=this.env,c=this.context,j=this.job;
    if(e.RUNTIME_MODE!=='production'||e.RAW_FULL_IDENTITY_WRITER_ENABLED!=='true'||e.EXPENSE_STABLE_PROJECTION_ENABLED!=='true'||e.DAILY_LEGACY_WRITER_GATE_ENABLED!=='true'||!e.GOOGLE_SPREADSHEET_ID||!e.SHEET_EXPENSE_RAW||!e.SHEET_EXPENSE_DAILY||j.kind!=='SHEETS_SYNC'||j.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(j.entityKey)||!Number.isSafeInteger(j.entityVersion)||j.entityVersion<1||!/^[-A-Za-z0-9_]{8,128}$/.test(this.lease)||!/^[-A-Za-z0-9_]{8,128}$/.test(this.outerToken)||!Number.isSafeInteger(c.revision)||c.revision<1||!Number.isSafeInteger(c.watermark)||c.watermark<0||!/^[-A-Za-z0-9_]{8,128}$/.test(c.generation))throw Error('FULL_RAW_INTENT_DISABLED');
  }
  private matches(source:RawSourceProof,metadataId:number,token:string):boolean{
    return source.kind==='EXPENSE'&&source.entityId===this.job.entityKey&&source.version===this.job.entityVersion&&/^[a-f0-9]{64}$/.test(source.fingerprint)&&Number.isSafeInteger(metadataId)&&metadataId>0&&metadataId<=2147483647&&/^[-A-Za-z0-9_]{16,128}$/.test(token);
  }
  async begin(source:RawSourceProof,metadataId:number,baseline:LedgerBaseline,token:string):Promise<boolean>{
    this.check();if(!this.matches(source,metadataId,token))return false;const canonical=canonicalFullExpenseBaseline(baseline);
    const fence=this.outer.dispatchFence('RAW',this.outerToken,this.context);
    const r=await this.env.DB.prepare(`UPDATE full_raw_identity_intents SET state='IN_FLIGHT',source_version=?,source_revision=?,source_fingerprint=?,operation_token=?,outer_token=?,cutover_generation=?,updated_at=?
      WHERE spreadsheet_id=? AND sheet_name=? AND expense_id=? AND metadata_id=? AND state='VERIFIED' AND projected_version<? AND baseline_json=? AND ${fence.sql} RETURNING projected_version`)
      .bind(source.version,this.context.revision,source.fingerprint,token,this.outerToken,this.context.generation,new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,source.version,canonical,...fence.args).first<{projected_version:number}>();
    if(!r||!Number.isSafeInteger(r.projected_version)||r.projected_version<1)return false;
    this.baselineAtBegin=canonical;this.projectedVersionAtBegin=r.projected_version;return true;
  }
  async canDispatch(source:RawSourceProof,metadataId:number,token:string):Promise<boolean>{
    this.check();if(!this.matches(source,metadataId,token)||this.baselineAtBegin===null||this.projectedVersionAtBegin===null)return false;
    const fence=this.outer.dispatchFence('RAW',this.outerToken,this.context);
    const row=await this.env.DB.prepare(`SELECT 1 AS ok FROM full_raw_identity_intents WHERE spreadsheet_id=? AND sheet_name=? AND expense_id=? AND metadata_id=? AND state='IN_FLIGHT' AND source_version=? AND source_revision=? AND source_fingerprint=? AND operation_token=? AND outer_token=? AND cutover_generation=? AND baseline_json=? AND projected_version=? AND ${fence.sql}`)
      .bind(this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,source.version,this.context.revision,source.fingerprint,token,this.outerToken,this.context.generation,this.baselineAtBegin,this.projectedVersionAtBegin,...fence.args).first<{ok:number}>();return !!row;
  }
  /** Fresh provider readback followed by the atomic D1 fence. This verifies
   * only this RAW identity; the outer projection stays IN_FLIGHT. Exclusion of
   * editors and old writers is still required because Sheets has no value CAS. */
  async finish(source:RawSourceProof,identity:LedgerWriteIdentity,metadataId:number,token:string):Promise<FullRawFinishResult>{
    this.check();if(!this.matches(source,metadataId,token)||identity.kind!=='EXPENSE'||identity.entityId!==source.entityId||identity.itemId!==undefined||this.baselineAtBegin===null||this.projectedVersionAtBegin===null)return {status:'NOT_VERIFIED'};
    let expected:RawSourceProof,canonical:string,evidenceDigest:string;
    try{
      expected={...source,values:[...source.values]};const target:LedgerWriteIdentity={...identity};
      const post=await createExpenseRawProductionProbe(this.env,this.env.SHEET_EXPENSE_RAW,target,metadataId).read();
      if(post.witness.metadataId!==metadataId)throw Error('FULL_RAW_READBACK_INVALID');
      verifyLedgerMetadataWitness(target,post.witness,post.identityRows);
      if(post.guard.observed.some(cell=>!cell||cell.note!==null||cell.hasValidation!==false)||!rawProjectionValuesMatch(expected,post.guard.observed)||!await rawSourceStillMatches(this.env,expected))throw Error('FULL_RAW_READBACK_INVALID');
      const next:LedgerBaseline={};for(let i=1;i<17;i++)next[String(i)]=await digestLedgerCell(post.guard.observed[i]!.entered);
      canonical=canonicalFullExpenseBaseline(next);
      const evidence=new TextEncoder().encode(JSON.stringify(['full-raw-readback-v1',this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,expected.version,this.context.revision,this.context.generation,this.outerToken,canonical]));
      evidenceDigest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',evidence)),byte=>byte.toString(16).padStart(2,'0')).join('');
    }catch{return {status:'NOT_VERIFIED'};}
    try{
      const fence=this.outer.dispatchFence('RAW',this.outerToken,this.context);
      const row=await this.env.DB.prepare(`UPDATE full_raw_identity_intents SET state='VERIFIED',projected_version=?,baseline_json=?,verified_evidence_digest=?,verified_outer_token=?,verified_generation=?,operation_token=NULL,outer_token=NULL,cutover_generation=NULL,source_fingerprint=NULL,updated_at=?
        WHERE spreadsheet_id=? AND sheet_name=? AND expense_id=? AND metadata_id=? AND state='IN_FLIGHT' AND source_version=? AND source_revision=? AND source_fingerprint=? AND operation_token=? AND outer_token=? AND cutover_generation=? AND baseline_json=? AND projected_version=? AND ${fence.sql} RETURNING metadata_id`)
        .bind(expected.version,canonical,evidenceDigest,this.outerToken,this.context.generation,new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,expected.version,this.context.revision,expected.fingerprint,token,this.outerToken,this.context.generation,this.baselineAtBegin,this.projectedVersionAtBegin,...fence.args).first<{metadata_id:number}>();
      if(!row||row.metadata_id!==metadataId)return {status:'UNKNOWN'};this.baselineAtBegin=null;this.projectedVersionAtBegin=null;return {status:'VERIFIED',evidenceDigest};
    }catch{return {status:'UNKNOWN'};}
  }
  /** A failed or uncertain finish is never replayed. Keep the outer intent in
   * REVIEW when possible; an unacknowledged hold remains explicitly unknown. */
  async finishOrHold(source:RawSourceProof,identity:LedgerWriteIdentity,metadataId:number,token:string):Promise<FullRawFinishDisposition>{
    let result:FullRawFinishResult;try{result=await this.finish(source,identity,metadataId,token);}catch{result={status:'NOT_VERIFIED'};}
    if(result.status==='VERIFIED')return {status:'INNER_VERIFIED_OUTER_IN_FLIGHT',evidenceDigest:result.evidenceDigest};
    let innerHeld=false;try{await this.hold(metadataId,token);innerHeld=true;}catch{/* may already be VERIFIED after a lost acknowledgement */}
    try{if(!await this.outer.hold('RAW',this.outerToken))return {status:'OUTER_HOLD_UNCONFIRMED'};}catch{return {status:'OUTER_HOLD_UNCONFIRMED'};}
    return {status:innerHeld?'OUTER_REVIEW':'OUTER_REVIEW_INNER_UNCERTAIN'};
  }
  async hold(metadataId:number,token:string):Promise<void>{
    this.check();if(!Number.isSafeInteger(metadataId)||metadataId<1||!/^[-A-Za-z0-9_]{16,128}$/.test(token))throw Error('FULL_RAW_INTENT_INVALID');
    const r=await this.env.DB.prepare(`UPDATE full_raw_identity_intents SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND expense_id=? AND metadata_id=? AND state='IN_FLIGHT' AND operation_token=? AND outer_token=?`).bind(new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,token,this.outerToken).run();if(Number(r.meta.changes||0)!==1)throw Error('FULL_RAW_INTENT_OWNERSHIP_LOST');
  }
}
