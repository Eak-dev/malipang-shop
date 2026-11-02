import type {Env,SheetsSyncJob} from '../types';
import type {LedgerBaseline} from './ledger-stable-journal';
import type {RawSourceProof} from './raw-source-proof';
import type {RawFullIntentPort} from './raw-full-projection-shadow';
import {ExpenseProjectionRuntimeJournal,type ExpenseProjectionContext} from './expense-projection-runtime-journal';

/** Compatible with the outer expense projection journal; no row address. */
export type FullRawCutoverContext=ExpenseProjectionContext;
function canonicalFullExpenseBaseline(value:LedgerBaseline):string{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==16)throw Error('FULL_RAW_BASELINE_INVALID');
  const out:LedgerBaseline={};for(let i=1;i<17;i++){const hash=value[String(i)];if(!/^[a-f0-9]{64}$/.test(hash||''))throw Error('FULL_RAW_BASELINE_INVALID');out[String(i)]=hash!;}
  return JSON.stringify(out);
}

/**
 * Default-off inner identity intent for an already enrolled EXPENSE RAW row.
 * The outer RAW projection intent must already be IN_FLIGHT. No API here
 * enrolls legacy rows, creates new rows, completes a projection, or dispatches
 * to Sheets. Missing 0029/0030 tables or guard failures hold by throwing or
 * returning false. Editor exclusion/old-worker drainage remain prerequisites.
 */
export class FullRawIdentityIntent implements RawFullIntentPort{
  private baselineAtBegin:string|null=null;
  private projectedVersionAtBegin:number|null=null;
  private readonly outer:ExpenseProjectionRuntimeJournal;
  constructor(private readonly env:Env,private readonly job:SheetsSyncJob,private readonly lease:string,private readonly outerToken:string,private readonly context:FullRawCutoverContext){this.outer=new ExpenseProjectionRuntimeJournal(env,job,lease);}
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
  async hold(metadataId:number,token:string):Promise<void>{
    this.check();if(!Number.isSafeInteger(metadataId)||metadataId<1||!/^[-A-Za-z0-9_]{16,128}$/.test(token))throw Error('FULL_RAW_INTENT_INVALID');
    const r=await this.env.DB.prepare(`UPDATE full_raw_identity_intents SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND expense_id=? AND metadata_id=? AND state='IN_FLIGHT' AND operation_token=? AND outer_token=?`).bind(new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,token,this.outerToken).run();if(Number(r.meta.changes||0)!==1)throw Error('FULL_RAW_INTENT_OWNERSHIP_LOST');
  }
}
