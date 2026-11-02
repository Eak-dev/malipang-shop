import type {Env,SheetsSyncJob} from '../types';
import type {LedgerBaseline} from './ledger-stable-journal';
import type {RawSourceProof} from './raw-source-proof';
import type {RawFullIntentPort} from './raw-full-projection-shadow';

/** Compatible with the outer expense projection journal; no row address. */
export interface FullRawCutoverContext{revision:number;generation:string;watermark:number}
export interface FullRawOuterFence{canDispatch(projection:'RAW',token:string,context:FullRawCutoverContext):Promise<boolean>}
const triggerNames=['expense_projection_event_insert','expense_projection_event_update','expense_projection_event_delete','expense_projection_document_insert','expense_projection_document_update','expense_projection_document_delete','expense_projection_link_insert','expense_projection_link_update','expense_projection_link_delete','expense_projection_item_insert','expense_projection_item_update','expense_projection_item_delete'];
// Hard fail-closed until this module embeds the reviewed outer journal's
// canonical dispatchFence in the same SQL statement and integration passes.
const CANONICAL_FENCE_INTEGRATED=false;
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
  constructor(private readonly env:Env,private readonly job:SheetsSyncJob,private readonly lease:string,private readonly outerToken:string,private readonly context:FullRawCutoverContext,private readonly outer:FullRawOuterFence){}
  private check():void{
    if(!CANONICAL_FENCE_INTEGRATED)throw Error('FULL_RAW_SHARED_GUARD_UNAVAILABLE');
    const e=this.env,c=this.context,j=this.job;
    if(e.RUNTIME_MODE!=='production'||e.RAW_FULL_IDENTITY_WRITER_ENABLED!=='true'||e.EXPENSE_STABLE_PROJECTION_ENABLED!=='true'||e.DAILY_LEGACY_WRITER_GATE_ENABLED!=='true'||!e.GOOGLE_SPREADSHEET_ID||!e.SHEET_EXPENSE_RAW||!e.SHEET_EXPENSE_DAILY||typeof this.outer?.canDispatch!=='function'||j.kind!=='SHEETS_SYNC'||j.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(j.entityKey)||!Number.isSafeInteger(j.entityVersion)||j.entityVersion<1||!/^[-A-Za-z0-9_]{8,128}$/.test(this.lease)||!/^[-A-Za-z0-9_]{8,128}$/.test(this.outerToken)||!Number.isSafeInteger(c.revision)||c.revision<1||!Number.isSafeInteger(c.watermark)||c.watermark<0||!/^[-A-Za-z0-9_]{8,128}$/.test(c.generation))throw Error('FULL_RAW_INTENT_DISABLED');
  }
  private matches(source:RawSourceProof,metadataId:number,token:string):boolean{
    return source.kind==='EXPENSE'&&source.entityId===this.job.entityKey&&source.version===this.job.entityVersion&&/^[a-f0-9]{64}$/.test(source.fingerprint)&&Number.isSafeInteger(metadataId)&&metadataId>0&&metadataId<=2147483647&&/^[-A-Za-z0-9_]{16,128}$/.test(token);
  }
  private guard():string{return `EXISTS(SELECT 1 FROM expense_projection_runtime_intents p
    JOIN expense_events e ON e.expense_id=p.expense_id AND e.version=p.source_version AND e.status='CONFIRMED'
    JOIN expense_projection_source_revisions r ON r.expense_id=e.expense_id AND r.state='TRACKED' AND r.revision=p.source_revision
    JOIN expense_projection_admissions a ON a.expense_id=e.expense_id
    JOIN expense_projection_cutovers c ON c.spreadsheet_id=p.spreadsheet_id AND c.sheet_name=? AND c.state='ACTIVE' AND c.generation=p.cutover_generation AND c.admission_watermark=p.admission_watermark AND a.sequence>c.admission_watermark
    JOIN daily_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.state='HOLD' AND g.generation=c.generation
    JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE p.spreadsheet_id=? AND p.expense_id=? AND p.source_version=? AND p.source_revision=? AND p.projection='RAW' AND p.state='IN_FLIGHT' AND p.operation_token=? AND p.cutover_generation=? AND p.admission_watermark=?
    AND EXISTS(SELECT 1 FROM expense_projection_bootstrap b WHERE b.singleton=1 AND b.state='COMPLETE')
    AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (${triggerNames.map(()=>'?').join(',')}))=12
    AND NOT EXISTS(SELECT 1 FROM expense_projection_runtime_intents q WHERE q.spreadsheet_id=p.spreadsheet_id AND q.expense_id=p.expense_id AND q.state IN ('IN_FLIGHT','REVIEW') AND (q.source_version<>p.source_version OR q.projection<>p.projection))
    AND NOT EXISTS(SELECT 1 FROM sheet_row_index s WHERE s.sheet_name IN (?,?,?) AND (s.entity_key=e.expense_id OR substr(s.entity_key,1,length(e.expense_id)+1)=e.expense_id||'|')))`;}
  private args():unknown[]{const e=this.env,c=this.context,j=this.job;return[e.SHEET_EXPENSE_DAILY,this.lease,e.GOOGLE_SPREADSHEET_ID,j.entityKey,j.entityVersion,c.revision,this.outerToken,c.generation,c.watermark,...triggerNames,e.SHEET_EXPENSE_DAILY,e.SHEET_EXPENSE_RAW,e.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ'];}
  async begin(source:RawSourceProof,metadataId:number,baseline:LedgerBaseline,token:string):Promise<boolean>{
    this.check();if(!this.matches(source,metadataId,token))return false;const canonical=canonicalFullExpenseBaseline(baseline);
    const r=await this.env.DB.prepare(`UPDATE full_raw_identity_intents SET state='IN_FLIGHT',source_version=?,source_revision=?,source_fingerprint=?,operation_token=?,outer_token=?,cutover_generation=?,updated_at=?
      WHERE spreadsheet_id=? AND sheet_name=? AND expense_id=? AND metadata_id=? AND state='VERIFIED' AND projected_version<? AND baseline_json=? AND ${this.guard()} RETURNING projected_version`)
      .bind(source.version,this.context.revision,source.fingerprint,token,this.outerToken,this.context.generation,new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,source.version,canonical,...this.args()).first<{projected_version:number}>();
    if(!r||!Number.isSafeInteger(r.projected_version)||r.projected_version<1)return false;
    this.baselineAtBegin=canonical;this.projectedVersionAtBegin=r.projected_version;return true;
  }
  async canDispatch(source:RawSourceProof,metadataId:number,token:string):Promise<boolean>{
    this.check();if(!this.matches(source,metadataId,token)||this.baselineAtBegin===null||this.projectedVersionAtBegin===null)return false;
    const row=await this.env.DB.prepare(`SELECT 1 AS ok FROM full_raw_identity_intents WHERE spreadsheet_id=? AND sheet_name=? AND expense_id=? AND metadata_id=? AND state='IN_FLIGHT' AND source_version=? AND source_revision=? AND source_fingerprint=? AND operation_token=? AND outer_token=? AND cutover_generation=? AND baseline_json=? AND projected_version=? AND ${this.guard()}`)
      .bind(this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,source.version,this.context.revision,source.fingerprint,token,this.outerToken,this.context.generation,this.baselineAtBegin,this.projectedVersionAtBegin,...this.args()).first<{ok:number}>();
    if(!row)return false;try{return await this.outer.canDispatch('RAW',this.outerToken,this.context);}catch{return false;}
  }
  async hold(metadataId:number,token:string):Promise<void>{
    this.check();if(!Number.isSafeInteger(metadataId)||metadataId<1||!/^[-A-Za-z0-9_]{16,128}$/.test(token))throw Error('FULL_RAW_INTENT_INVALID');
    const r=await this.env.DB.prepare(`UPDATE full_raw_identity_intents SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND sheet_name=? AND expense_id=? AND metadata_id=? AND state='IN_FLIGHT' AND operation_token=? AND outer_token=?`).bind(new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,metadataId,token,this.outerToken).run();if(Number(r.meta.changes||0)!==1)throw Error('FULL_RAW_INTENT_OWNERSHIP_LOST');
  }
}
