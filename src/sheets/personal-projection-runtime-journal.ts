import type {Env,SheetsSyncJob} from '../types';

export interface PersonalProjectionContext{revision:number;generation:string;watermark:number}
export interface PersonalGenerationLease{generation:string;revision:number;token:string}
const triggers=['personal_projection_before_insert','personal_projection_insert','personal_projection_before_update','personal_projection_update','personal_projection_delete'];
const schemaGuard=`(SELECT foreign_keys FROM pragma_foreign_keys)=1
  AND (SELECT count(*) FROM pragma_foreign_key_list('owner_personal_transaction_audit'))=1
  AND EXISTS(SELECT 1 FROM pragma_foreign_key_list('owner_personal_transaction_audit') WHERE "table"='owner_personal_transactions' AND "from"='personal_use_id' AND "to"='personal_use_id' AND upper(on_delete)='NO ACTION' AND upper(on_update)='NO ACTION')
  AND (SELECT count(*) FROM pragma_index_list('owner_personal_transactions') WHERE "unique"=1)=2
  AND (SELECT count(*) FROM pragma_index_list('owner_personal_transactions') WHERE "unique"=1 AND name IN ('sqlite_autoindex_owner_personal_transactions_1','sqlite_autoindex_owner_personal_transactions_2'))=2
  AND (SELECT group_concat(name,',') FROM (SELECT name FROM pragma_index_info('sqlite_autoindex_owner_personal_transactions_1') ORDER BY seqno))='personal_use_id'
  AND (SELECT group_concat(name,',') FROM (SELECT name FROM pragma_index_info('sqlite_autoindex_owner_personal_transactions_2') ORDER BY seqno))='message_id'
  AND (SELECT count(*) FROM pragma_index_xinfo('sqlite_autoindex_owner_personal_transactions_1') WHERE key=1 AND (coll IS NULL OR upper(coll)<>'BINARY'))=0
  AND (SELECT count(*) FROM pragma_index_xinfo('sqlite_autoindex_owner_personal_transactions_2') WHERE key=1 AND (coll IS NULL OR upper(coll)<>'BINARY'))=0
  AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (${triggers.map(()=>'?').join(',')}))=5`;

/** Default-off foundation for a NEW personal-use record after cutover. No
 * production route, provider write, enrollment, verification, completion or
 * automatic retry exists here. A D1 fence is not a Sheets lock. */
export class PersonalProjectionRuntimeJournal{
  private readonly job:SheetsSyncJob;
  private readonly generationLease:PersonalGenerationLease|undefined;
  constructor(private readonly env:Env,job:SheetsSyncJob,private readonly lease:string,generationLease?:PersonalGenerationLease){this.job={...job};this.generationLease=generationLease?{...generationLease}:undefined;}
  private check():void{
    const e=this.env,j=this.job;if(e.RUNTIME_MODE!=='production'||e.PERSONAL_STABLE_PROJECTION_ENABLED!=='true'||!e.GOOGLE_SPREADSHEET_ID||j.kind!=='SHEETS_SYNC'||j.entityType!=='PERSONAL_USE'||!/^personal_[A-Za-z0-9_-]{1,128}$/.test(j.entityKey)||!Number.isSafeInteger(j.entityVersion)||j.entityVersion<1||!/^[-A-Za-z0-9_]{8,128}$/.test(this.lease))throw Error('PERSONAL_PROJECTION_DISABLED');
    const v=this.generationLease;if(e.PERSONAL_GENERATION_WORKER_ENABLED!=='true'||!v||!/^[-A-Za-z0-9_]{8,128}$/.test(v.generation)||!Number.isSafeInteger(v.revision)||v.revision<1||!/^[-A-Za-z0-9_]{8,128}$/.test(v.token))throw Error('PERSONAL_GENERATION_LEASE_REQUIRED');
  }
  private sheet():string{return this.env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW';}
  private valid(c:PersonalProjectionContext):boolean{return !!c&&Number.isSafeInteger(c.revision)&&c.revision>0&&Number.isSafeInteger(c.watermark)&&c.watermark>=0&&typeof c.generation==='string'&&/^[-A-Za-z0-9_]{8,128}$/.test(c.generation);}
  private generationGuard():string{return `EXISTS(SELECT 1 FROM personal_projection_generation_jobs v WHERE v.spreadsheet_id=c.spreadsheet_id AND v.cutover_generation=c.generation AND v.cutover_generation=? AND v.personal_use_id=p.personal_use_id AND v.source_version=p.version AND v.source_revision=r.revision AND v.source_revision=? AND v.state='IN_FLIGHT' AND v.lease_token=? AND v.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NOT EXISTS(SELECT 1 FROM personal_projection_generation_jobs other WHERE other.spreadsheet_id=v.spreadsheet_id AND other.personal_use_id=v.personal_use_id AND other.state IN ('IN_FLIGHT','REVIEW') AND (other.cutover_generation<>v.cutover_generation OR other.source_version<>v.source_version OR other.source_revision<>v.source_revision)))`;}
  private generationArgs():unknown[]{const v=this.generationLease!;return[v.generation,v.revision,v.token];}
  private guard():string{return `EXISTS(SELECT 1 FROM owner_personal_transactions p
    JOIN personal_projection_source_revisions r ON r.personal_use_id=p.personal_use_id AND r.state='TRACKED' AND r.revision=?
    JOIN personal_projection_admissions a ON a.personal_use_id=p.personal_use_id
    JOIN personal_projection_cutovers c ON c.spreadsheet_id=? AND c.sheet_name=? AND c.state='ACTIVE' AND c.generation=? AND c.admission_watermark=? AND a.sequence>c.admission_watermark
    JOIN personal_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.state='HOLD' AND g.generation=c.generation
    JOIN sync_jobs j ON j.entity_type='PERSONAL_USE' AND j.entity_key=p.personal_use_id AND j.entity_version=p.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE p.personal_use_id=? AND p.version=? AND p.status='CONFIRMED' AND EXISTS(SELECT 1 FROM personal_projection_bootstrap b WHERE b.singleton=1 AND b.state='COMPLETE') AND ${schemaGuard}
    AND NOT EXISTS(SELECT 1 FROM personal_projection_generation_observations seen WHERE seen.spreadsheet_id=c.spreadsheet_id AND seen.personal_use_id=p.personal_use_id AND seen.source_revision>r.revision)
    AND NOT EXISTS(SELECT 1 FROM personal_projection_generation_jobs seen WHERE seen.spreadsheet_id=c.spreadsheet_id AND seen.personal_use_id=p.personal_use_id AND seen.source_revision>r.revision)
    AND ${this.generationGuard()}
    AND NOT EXISTS(SELECT 1 FROM sheet_row_index s WHERE s.sheet_name=c.sheet_name AND s.entity_key=p.personal_use_id)
    AND NOT EXISTS(SELECT 1 FROM sync_jobs q WHERE q.entity_type='PERSONAL_USE' AND q.entity_key=p.personal_use_id AND q.entity_version<>p.version AND q.status IN ('PROCESSING','REVIEW')))`;}
  private args(c:PersonalProjectionContext):unknown[]{return[c.revision,this.env.GOOGLE_SPREADSHEET_ID,this.sheet(),c.generation,c.watermark,this.lease,this.job.entityKey,this.job.entityVersion,...triggers,...this.generationArgs()];}
  /** Snapshot only, not permission to send a provider request. */
  async context():Promise<PersonalProjectionContext|null>{
    this.check();const row=await this.env.DB.prepare(`SELECT r.revision,c.generation,c.admission_watermark AS watermark FROM owner_personal_transactions p
      JOIN personal_projection_source_revisions r ON r.personal_use_id=p.personal_use_id AND r.state='TRACKED'
      JOIN personal_projection_admissions a ON a.personal_use_id=p.personal_use_id
      JOIN personal_projection_cutovers c ON c.spreadsheet_id=? AND c.sheet_name=? AND c.state='ACTIVE' AND a.sequence>c.admission_watermark
      JOIN personal_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.state='HOLD' AND g.generation=c.generation
      JOIN sync_jobs j ON j.entity_type='PERSONAL_USE' AND j.entity_key=p.personal_use_id AND j.entity_version=p.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE p.personal_use_id=? AND p.version=? AND p.status='CONFIRMED' AND EXISTS(SELECT 1 FROM personal_projection_bootstrap b WHERE b.singleton=1 AND b.state='COMPLETE') AND ${schemaGuard}
      AND NOT EXISTS(SELECT 1 FROM personal_projection_generation_observations seen WHERE seen.spreadsheet_id=c.spreadsheet_id AND seen.personal_use_id=p.personal_use_id AND seen.source_revision>r.revision)
      AND NOT EXISTS(SELECT 1 FROM personal_projection_generation_jobs seen WHERE seen.spreadsheet_id=c.spreadsheet_id AND seen.personal_use_id=p.personal_use_id AND seen.source_revision>r.revision)
      AND ${this.generationGuard()}
      AND NOT EXISTS(SELECT 1 FROM sheet_row_index s WHERE s.sheet_name=c.sheet_name AND s.entity_key=p.personal_use_id)
      AND NOT EXISTS(SELECT 1 FROM sync_jobs q WHERE q.entity_type='PERSONAL_USE' AND q.entity_key=p.personal_use_id AND q.entity_version<>p.version AND q.status IN ('PROCESSING','REVIEW'))`).bind(this.env.GOOGLE_SPREADSHEET_ID,this.sheet(),this.lease,this.job.entityKey,this.job.entityVersion,...triggers,...this.generationArgs()).first<PersonalProjectionContext>();return row&&this.valid(row)?row:null;
  }
  async begin(c:PersonalProjectionContext):Promise<string|null>{
    this.check();if(!this.valid(c))return null;const token=crypto.randomUUID();
    const r=await this.env.DB.prepare(`INSERT INTO personal_projection_runtime_intents(spreadsheet_id,personal_use_id,source_version,source_revision,state,operation_token,cutover_generation,admission_watermark,updated_at)
      SELECT ?,?,?,?,'IN_FLIGHT',?,?,?,? WHERE ${this.guard()}
      AND NOT EXISTS(SELECT 1 FROM personal_projection_runtime_intents i WHERE i.spreadsheet_id=? AND i.personal_use_id=? AND i.state IN ('IN_FLIGHT','REVIEW'))
      ON CONFLICT(spreadsheet_id,personal_use_id,source_version,source_revision) DO NOTHING`).bind(this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey,this.job.entityVersion,c.revision,token,c.generation,c.watermark,new Date().toISOString(),...this.args(c),this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey).run();return Number(r.meta.changes||0)===1?token:null;
  }
  dispatchFence(token:string,c:PersonalProjectionContext):{sql:string;args:unknown[]}{
    this.check();if(!/^[-A-Za-z0-9_]{16,128}$/.test(token)||!this.valid(c))throw Error('PERSONAL_PROJECTION_FENCE_INVALID');
    return{sql:`EXISTS(SELECT 1 FROM personal_projection_runtime_intents i WHERE i.spreadsheet_id=? AND i.personal_use_id=? AND i.source_version=? AND i.source_revision=? AND i.state='IN_FLIGHT' AND i.operation_token=? AND i.cutover_generation=? AND i.admission_watermark=? AND ${this.guard()}
      AND NOT EXISTS(SELECT 1 FROM personal_projection_runtime_intents q WHERE q.spreadsheet_id=i.spreadsheet_id AND q.personal_use_id=i.personal_use_id AND q.state IN ('IN_FLIGHT','REVIEW') AND (q.source_version<>i.source_version OR q.source_revision<>i.source_revision)))`,args:[this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey,this.job.entityVersion,c.revision,token,c.generation,c.watermark,...this.args(c)]};
  }
  async canDispatch(token:string,c:PersonalProjectionContext):Promise<boolean>{
    const f=this.dispatchFence(token,c),r=await this.env.DB.prepare(`SELECT 1 AS ok WHERE ${f.sql}`).bind(...f.args).first<{ok:number}>();return !!r;
  }
  /** This transition requires a trusted full provider readback recorded by the
   * matching inner intent. It does not complete a job or authorize a retry. */
  async verify(token:string,c:PersonalProjectionContext,evidenceDigest:string):Promise<boolean>{
    this.check();if(!this.valid(c)||!/^[-A-Za-z0-9_]{16,128}$/.test(token)||!/^[a-f0-9]{64}$/.test(evidenceDigest))return false;
    const f=this.dispatchFence(token,c);
    const r=await this.env.DB.prepare(`UPDATE personal_projection_runtime_intents SET state='VERIFIED',evidence_digest=?,updated_at=? WHERE spreadsheet_id=? AND personal_use_id=? AND source_version=? AND source_revision=? AND state='IN_FLIGHT' AND operation_token=? AND cutover_generation=? AND admission_watermark=? AND ${f.sql}
      AND EXISTS(SELECT 1 FROM personal_raw_identity_intents i WHERE i.spreadsheet_id=? AND i.sheet_name=? AND i.personal_use_id=? AND i.state='VERIFIED' AND i.projected_version=? AND i.projected_revision=? AND i.source_version=? AND i.source_revision=? AND i.verified_outer_token=? AND i.verified_generation=? AND i.verified_evidence_digest=?
        AND NOT EXISTS(SELECT 1 FROM full_raw_identity_intents x WHERE x.spreadsheet_id=i.spreadsheet_id AND x.metadata_id=i.metadata_id)
        AND NOT EXISTS(SELECT 1 FROM full_raw_append_intents x WHERE x.spreadsheet_id=i.spreadsheet_id AND x.metadata_id=i.metadata_id)
        AND CASE WHEN json_valid(i.baseline_json) THEN json_type(i.baseline_json)='object' AND (SELECT count(*) FROM json_each(i.baseline_json))=14 AND (SELECT count(DISTINCT key) FROM json_each(i.baseline_json))=14 AND NOT EXISTS(SELECT 1 FROM json_each(i.baseline_json) b WHERE CAST(b.key AS INTEGER)<1 OR CAST(b.key AS INTEGER)>14 OR CAST(CAST(b.key AS INTEGER) AS TEXT)<>b.key OR b.type<>'text' OR length(b.value)<>64 OR b.value GLOB '*[^0-9a-f]*') ELSE 0 END)`)
      .bind(evidenceDigest,new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey,this.job.entityVersion,c.revision,token,c.generation,c.watermark,...f.args,this.env.GOOGLE_SPREADSHEET_ID,this.sheet(),this.job.entityKey,this.job.entityVersion,c.revision,this.job.entityVersion,c.revision,token,c.generation,evidenceDigest).run();
    return Number(r.meta.changes||0)===1;
  }
  async hold(token:string,c:PersonalProjectionContext):Promise<boolean>{
    this.check();if(!/^[-A-Za-z0-9_]{16,128}$/.test(token)||!this.valid(c))return false;
    const r=await this.env.DB.prepare(`UPDATE personal_projection_runtime_intents SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND personal_use_id=? AND source_version=? AND source_revision=? AND state='IN_FLIGHT' AND operation_token=? AND cutover_generation=? AND admission_watermark=?`).bind(new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey,this.job.entityVersion,c.revision,token,c.generation,c.watermark).run();return Number(r.meta.changes||0)===1;
  }
}
