import type {Env,SheetsSyncJob} from '../types';

export type ExpenseProjection='RAW'|'DAILY'|'DETAIL';
export interface ExpenseProjectionContext{revision:number;generation:string;watermark:number}
export interface ExpenseGenerationLease{generation:string;revision:number;token:string}
const projections=new Set<ExpenseProjection>(['RAW','DAILY','DETAIL']);
// Presence catches accidental incomplete installation; it is not proof that
// a privileged database editor has not replaced a trigger's SQL.
const triggerIntegrity=`(SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('expense_projection_event_before_update','expense_projection_event_before_insert','expense_projection_event_insert','expense_projection_event_update','expense_projection_event_delete','expense_projection_document_before_update','expense_projection_document_before_insert','expense_projection_document_insert','expense_projection_document_update','expense_projection_document_delete','expense_projection_link_before_update','expense_projection_link_before_insert','expense_projection_link_insert','expense_projection_link_update','expense_projection_link_delete','expense_projection_item_before_update','expense_projection_item_before_insert','expense_projection_item_insert','expense_projection_item_update','expense_projection_item_delete'))=20`;
// REPLACE collision coverage depends on this exact unique-index inventory.
// A new or removed unique index must stop the writer until reviewed.
const uniqueIndexIntegrity=[
  ['expense_events',['sqlite_autoindex_expense_events_1','sqlite_autoindex_expense_events_2']],
  ['expense_documents',['sqlite_autoindex_expense_documents_1','sqlite_autoindex_expense_documents_2','idx_expense_documents_reference_key','idx_expense_documents_image_hash','idx_expense_document_invoice_identity_v2']],
  ['expense_document_links',['sqlite_autoindex_expense_document_links_1','sqlite_autoindex_expense_document_links_2']],
  ['expense_document_items',['sqlite_autoindex_expense_document_items_1']]
].map(([table,names])=>{const list=names as string[];return `(SELECT count(*) FROM pragma_index_list('${table}') WHERE "unique"=1)=${list.length} AND (SELECT count(*) FROM pragma_index_list('${table}') WHERE "unique"=1 AND name IN (${list.map(n=>`'${n}'`).join(',')}))=${list.length}`;}).join(' AND ');
const expectedIndexColumns:Record<string,string>={
  sqlite_autoindex_expense_events_1:'expense_id',sqlite_autoindex_expense_events_2:'message_id',
  sqlite_autoindex_expense_documents_1:'document_id',sqlite_autoindex_expense_documents_2:'message_id',idx_expense_documents_reference_key:'reference_key',idx_expense_documents_image_hash:'image_hash',idx_expense_document_invoice_identity_v2:'legal_vendor_name,document_number',
  sqlite_autoindex_expense_document_links_1:'link_id',sqlite_autoindex_expense_document_links_2:'expense_id,document_id',sqlite_autoindex_expense_document_items_1:'item_id'
};
const indexColumnIntegrity=Object.entries(expectedIndexColumns).map(([name,columns])=>`(SELECT group_concat(name,',') FROM (SELECT name FROM pragma_index_info('${name}') ORDER BY seqno))='${columns}' AND (SELECT count(*) FROM pragma_index_xinfo('${name}') WHERE key=1 AND (coll IS NULL OR upper(coll)<>'BINARY'))=0`).join(' AND ');
const expectedPartialIndexes:Record<string,string>={
  idx_expense_documents_reference_key:`CREATE UNIQUE INDEX idx_expense_documents_reference_key\nON expense_documents(reference_key)\nWHERE reference_key IS NOT NULL AND reference_key <> ''`,
  idx_expense_documents_image_hash:`CREATE UNIQUE INDEX idx_expense_documents_image_hash\nON expense_documents(image_hash)\nWHERE image_hash IS NOT NULL AND image_hash <> ''`,
  idx_expense_document_invoice_identity_v2:`CREATE UNIQUE INDEX idx_expense_document_invoice_identity_v2\nON expense_documents(legal_vendor_name,document_number)\nWHERE legal_vendor_name IS NOT NULL AND legal_vendor_name<>''\n  AND document_number IS NOT NULL AND document_number<>''\n  AND NOT (expense_id IS NULL\n    AND COALESCE(reference_key,'') GLOB 'receipt:linked:v1:*'\n    AND order_id IS NOT NULL AND trim(order_id)<>'')`
};
// Preserve literal case and whitespace: normalizing all whitespace/case could
// hide a meaningful change *inside* a quoted partial-index predicate.
const partialIndexIntegrity=Object.entries(expectedPartialIndexes).map(([name,sql])=>`EXISTS(SELECT 1 FROM sqlite_master WHERE type='index' AND name='${name}' AND sql='${sql.replace(/'/g,"''")}')`).join(' AND ');
const expectedForeignKeys:Record<string,Array<[string,string]>>={expense_document_links:[['expense_documents','document_id'],['expense_events','expense_id']],expense_document_items:[['expense_documents','document_id'],['expense_events','expense_id']]};
const foreignKeyIntegrity=`(SELECT foreign_keys FROM pragma_foreign_keys)=1 AND `+Object.entries(expectedForeignKeys).map(([table,keys])=>`(SELECT count(*) FROM pragma_foreign_key_list('${table}'))=${keys.length} AND `+keys.map(([target,column])=>`EXISTS(SELECT 1 FROM pragma_foreign_key_list('${table}') WHERE "table"='${target}' AND "from"='${column}' AND upper(on_delete)='NO ACTION' AND upper(on_update)='NO ACTION')`).join(' AND ')).join(' AND ');

/** Production candidate, intentionally not wired to the queue yet. A D1
 * revision is not a Sheets lock: an operator must still exclude and drain old
 * workers, direct integrations and human editors before any Google mutation.
 * Only records admitted after the cutoff are eligible; historic identities and
 * cancellation require separate verified migration and recovery workflows. */
export class ExpenseProjectionRuntimeJournal{
  private readonly generationLease:ExpenseGenerationLease|undefined;
  private readonly job:SheetsSyncJob;
  constructor(private readonly env:Env,job:SheetsSyncJob,private readonly lease:string,generationLease?:ExpenseGenerationLease){this.job={...job};this.generationLease=generationLease?{...generationLease}:undefined;}
  private check(projection?:ExpenseProjection):void{
    if(this.env.RUNTIME_MODE!=='production'||this.env.EXPENSE_STABLE_PROJECTION_ENABLED!=='true'||this.env.DAILY_LEGACY_WRITER_GATE_ENABLED!=='true'||!this.env.GOOGLE_SPREADSHEET_ID||!this.env.SHEET_EXPENSE_DAILY||!this.env.SHEET_EXPENSE_RAW||this.job.kind!=='SHEETS_SYNC'||this.job.entityType!=='EXPENSE'||!/^exp_[A-Za-z0-9_-]{1,128}$/.test(this.job.entityKey)||!Number.isSafeInteger(this.job.entityVersion)||this.job.entityVersion<1||!this.lease||projection&&!projections.has(projection))throw new Error('EXPENSE_PROJECTION_DISABLED');
    const v=this.generationLease;
    if(this.env.EXPENSE_GENERATION_WORKER_ENABLED!=='true'||!v||!/^[-A-Za-z0-9_]{8,128}$/.test(v.generation)||!Number.isSafeInteger(v.revision)||v.revision<1||!/^[-A-Za-z0-9_]{8,128}$/.test(v.token))throw new Error('EXPENSE_GENERATION_LEASE_REQUIRED');
  }
  // Aliases e, r and c belong to the canonical source guard. This entire
  // predicate is embedded into the same D1 statement as each projection write.
  private generationGuard():string{return this.generationLease?` AND EXISTS(SELECT 1 FROM expense_projection_generation_jobs v WHERE v.spreadsheet_id=c.spreadsheet_id AND v.cutover_generation=c.generation AND v.cutover_generation=? AND v.expense_id=e.expense_id AND v.source_version=e.version AND v.source_revision=r.revision AND v.source_revision=? AND v.state='IN_FLIGHT' AND v.lease_token=? AND v.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND NOT EXISTS(SELECT 1 FROM expense_projection_generation_jobs other WHERE other.spreadsheet_id=v.spreadsheet_id AND other.expense_id=v.expense_id AND other.state IN ('IN_FLIGHT','REVIEW') AND (other.cutover_generation<>v.cutover_generation OR other.source_version<>v.source_version OR other.source_revision<>v.source_revision))
    AND NOT EXISTS(SELECT 1 FROM expense_projection_generation_observations seen WHERE seen.spreadsheet_id=v.spreadsheet_id AND seen.expense_id=v.expense_id AND seen.source_revision>v.source_revision)
    AND NOT EXISTS(SELECT 1 FROM expense_projection_generation_jobs seen WHERE seen.spreadsheet_id=v.spreadsheet_id AND seen.expense_id=v.expense_id AND seen.source_revision>v.source_revision))`:'';}
  private generationArgs():unknown[]{const v=this.generationLease;return v?[v.generation,v.revision,v.token]:[];}
  private guard():string{return `EXISTS(SELECT 1 FROM expense_events e
    JOIN expense_projection_source_revisions r ON r.expense_id=e.expense_id AND r.state='TRACKED' AND r.revision=?
    JOIN expense_projection_admissions a ON a.expense_id=e.expense_id
    JOIN expense_projection_cutovers c ON c.spreadsheet_id=? AND c.sheet_name=? AND c.state='ACTIVE' AND c.generation=? AND c.admission_watermark=? AND a.sequence>c.admission_watermark
    JOIN daily_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.state='HOLD' AND g.generation=c.generation
    JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND EXISTS(SELECT 1 FROM expense_projection_bootstrap b WHERE b.singleton=1 AND b.state='COMPLETE') AND ${triggerIntegrity} AND ${uniqueIndexIntegrity} AND ${indexColumnIntegrity} AND ${partialIndexIntegrity} AND ${foreignKeyIntegrity}
    AND NOT EXISTS(SELECT 1 FROM sheet_row_index s WHERE s.sheet_name IN (?,?,?) AND (s.entity_key=e.expense_id OR substr(s.entity_key,1,length(e.expense_id)+1)=e.expense_id||'|'))${this.generationGuard()})`;}
  private args(c:ExpenseProjectionContext):unknown[]{return[c.revision,this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_DAILY,c.generation,c.watermark,this.lease,this.job.entityKey,this.job.entityVersion,this.env.SHEET_EXPENSE_DAILY,this.env.SHEET_EXPENSE_RAW,this.env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',...this.generationArgs()];}
  private valid(c:ExpenseProjectionContext):boolean{return Number.isSafeInteger(c.revision)&&c.revision>0&&c.revision<=9007199254740991&&typeof c.generation==='string'&&/^[A-Za-z0-9_-]{8,128}$/.test(c.generation)&&Number.isSafeInteger(c.watermark)&&c.watermark>=0;}
  /** Current context is only a preimage, not permission to dispatch. */
  async context():Promise<ExpenseProjectionContext|null>{
    this.check();const row=await this.env.DB.prepare(`SELECT r.revision,c.generation,c.admission_watermark AS watermark FROM expense_events e
      JOIN expense_projection_source_revisions r ON r.expense_id=e.expense_id AND r.state='TRACKED'
      JOIN expense_projection_admissions a ON a.expense_id=e.expense_id
      JOIN expense_projection_cutovers c ON c.spreadsheet_id=? AND c.sheet_name=? AND c.state='ACTIVE' AND a.sequence>c.admission_watermark
      JOIN daily_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.state='HOLD' AND g.generation=c.generation
      JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version AND j.status='PROCESSING' AND j.lease_token=? AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE e.expense_id=? AND e.version=? AND e.status='CONFIRMED' AND EXISTS(SELECT 1 FROM expense_projection_bootstrap b WHERE b.singleton=1 AND b.state='COMPLETE') AND ${triggerIntegrity} AND ${uniqueIndexIntegrity} AND ${indexColumnIntegrity} AND ${partialIndexIntegrity} AND ${foreignKeyIntegrity}
      AND NOT EXISTS(SELECT 1 FROM sheet_row_index s WHERE s.sheet_name IN (?,?,?) AND (s.entity_key=e.expense_id OR substr(s.entity_key,1,length(e.expense_id)+1)=e.expense_id||'|'))${this.generationGuard()}`).bind(this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_DAILY,this.lease,this.job.entityKey,this.job.entityVersion,this.env.SHEET_EXPENSE_DAILY,this.env.SHEET_EXPENSE_RAW,this.env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',...this.generationArgs()).first<ExpenseProjectionContext>();
    return row&&this.valid(row)?row:null;
  }
  async begin(projection:ExpenseProjection,c:ExpenseProjectionContext):Promise<string|null>{
    this.check(projection);if(!this.valid(c))return null;const token=crypto.randomUUID();
    const result=await this.env.DB.prepare(`INSERT INTO expense_projection_runtime_intents(spreadsheet_id,expense_id,source_version,source_revision,projection,state,operation_token,cutover_generation,admission_watermark,updated_at)
      SELECT ?,?,?,?,?,'IN_FLIGHT',?,?,?,? WHERE ${this.guard()}
      AND NOT EXISTS(SELECT 1 FROM expense_projection_runtime_intents p WHERE p.spreadsheet_id=? AND p.expense_id=? AND p.state IN ('IN_FLIGHT','REVIEW'))
      ON CONFLICT(spreadsheet_id,expense_id,source_version,source_revision,projection) DO NOTHING`).bind(this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey,this.job.entityVersion,c.revision,projection,token,c.generation,c.watermark,new Date().toISOString(),...this.args(c),this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey).run();return Number(result.meta.changes||0)===1?token:null;
  }
  /** Reusable SQL predicate for an inner identity-intent UPDATE in the same
   * D1 statement. Copying only a prior JS boolean creates a race. */
  private projectionFence(projection:ExpenseProjection,token:string,c:ExpenseProjectionContext):{sql:string;args:unknown[]}{
    this.check(projection);if(!token||!this.valid(c))throw new Error('EXPENSE_PROJECTION_FENCE_INVALID');
    return {sql:`EXISTS(SELECT 1 FROM expense_projection_runtime_intents p WHERE p.spreadsheet_id=? AND p.expense_id=? AND p.source_version=? AND p.source_revision=? AND p.projection=? AND p.state='IN_FLIGHT' AND p.operation_token=? AND p.cutover_generation=? AND p.admission_watermark=? AND ${this.guard()}
      AND NOT EXISTS(SELECT 1 FROM expense_projection_runtime_intents q WHERE q.spreadsheet_id=p.spreadsheet_id AND q.expense_id=p.expense_id AND q.state IN ('IN_FLIGHT','REVIEW') AND (q.source_version<>p.source_version OR q.source_revision<>p.source_revision OR q.projection<>p.projection)))`,args:[this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey,this.job.entityVersion,c.revision,projection,token,c.generation,c.watermark,...this.args(c)]};
  }
  dispatchFence(projection:ExpenseProjection,token:string,c:ExpenseProjectionContext):{sql:string;args:unknown[]}{
    const fence=this.projectionFence(projection,token,c);
    // The owner chose a cooperative pause, not a hard human lock. Until
    // the in-Sheets signal and independently verified system-writer drain
    // exist, DAILY writes remain impossible even when other leases match.
    return projection==='DAILY'?{sql:`(${fence.sql} AND 0=1)`,args:fence.args}:fence;
  }
  /** Only publishes a D1 NOTICE; this cannot authorize a provider write. */
  async requestDailyNotice(token:string,c:ExpenseProjectionContext,windowToken:string,seconds:number):Promise<boolean>{
    if(this.env.DAILY_EDIT_COORDINATION_ENABLED!=='true'||!/^[-A-Za-z0-9_]{16,128}$/.test(windowToken)||!Number.isInteger(seconds)||seconds<15||seconds>60)throw Error('DAILY_EDIT_COORDINATION_DISABLED');
    const fence=this.projectionFence('DAILY',token,c);
    const result=await this.env.DB.prepare(`UPDATE daily_edit_coordination SET state='NOTICE',window_token=?,cutover_generation=?,notice_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+'||?||' seconds'),deadline=strftime('%Y-%m-%dT%H:%M:%fZ','now','+2 minutes'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=? AND sheet_name=? AND state='AVAILABLE' AND julianday(updated_at) BETWEEN julianday('now','-15 seconds') AND julianday('now','+5 seconds') AND ${fence.sql}`).bind(windowToken,c.generation,seconds,this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_DAILY,...fence.args).run();
    return Number(result.meta.changes||0)===1;
  }
  async canDispatch(projection:ExpenseProjection,token:string,c:ExpenseProjectionContext):Promise<boolean>{
    this.check(projection);if(!token||!this.valid(c))return false;const fence=this.dispatchFence(projection,token,c);
    const row=await this.env.DB.prepare(`SELECT 1 AS ok WHERE ${fence.sql}`).bind(...fence.args).first<{ok:number}>();return !!row;
  }
  /** The caller must perform independent provider identity and full postimage
   * verification first. A digest passed here is not proof by itself. */
  async verify(projection:ExpenseProjection,token:string,c:ExpenseProjectionContext,evidenceDigest:string):Promise<boolean>{
    this.check(projection);if(projection==='DAILY'||!token||!this.valid(c)||!/^[a-f0-9]{64}$/.test(evidenceDigest))return false;
    const result=await this.env.DB.prepare(`UPDATE expense_projection_runtime_intents SET state='VERIFIED',evidence_digest=?,updated_at=? WHERE spreadsheet_id=? AND expense_id=? AND source_version=? AND source_revision=? AND projection=? AND state='IN_FLIGHT' AND operation_token=? AND cutover_generation=? AND admission_watermark=? AND ${this.guard()}
      AND (?<>'RAW' OR EXISTS(SELECT 1 FROM full_raw_identity_intents i WHERE i.spreadsheet_id=? AND i.sheet_name=? AND i.expense_id=? AND i.state='VERIFIED' AND i.projected_version=? AND i.projected_revision=? AND i.source_version=? AND i.source_revision=? AND i.verified_outer_token=? AND i.verified_generation=? AND i.verified_evidence_digest=?
        AND CASE WHEN json_valid(i.baseline_json) THEN json_type(i.baseline_json)='object' AND (SELECT count(*) FROM json_each(i.baseline_json))=16 AND (SELECT count(DISTINCT key) FROM json_each(i.baseline_json))=16 AND NOT EXISTS(SELECT 1 FROM json_each(i.baseline_json) b WHERE CAST(b.key AS INTEGER)<1 OR CAST(b.key AS INTEGER)>16 OR CAST(CAST(b.key AS INTEGER) AS TEXT)<>b.key OR b.type<>'text' OR length(b.value)<>64 OR b.value GLOB '*[^0-9a-f]*') ELSE 0 END))
      AND NOT EXISTS(SELECT 1 FROM expense_projection_runtime_intents q WHERE q.spreadsheet_id=expense_projection_runtime_intents.spreadsheet_id AND q.expense_id=expense_projection_runtime_intents.expense_id AND q.state IN ('IN_FLIGHT','REVIEW') AND (q.source_version<>expense_projection_runtime_intents.source_version OR q.source_revision<>expense_projection_runtime_intents.source_revision OR q.projection<>expense_projection_runtime_intents.projection))`).bind(evidenceDigest,new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey,this.job.entityVersion,c.revision,projection,token,c.generation,c.watermark,...this.args(c),projection,this.env.GOOGLE_SPREADSHEET_ID,this.env.SHEET_EXPENSE_RAW,this.job.entityKey,this.job.entityVersion,c.revision,this.job.entityVersion,c.revision,token,c.generation,evidenceDigest).run();return Number(result.meta.changes||0)===1;
  }
  async hold(projection:ExpenseProjection,token:string):Promise<boolean>{
    this.check(projection);const result=await this.env.DB.prepare(`UPDATE expense_projection_runtime_intents SET state='REVIEW',updated_at=? WHERE spreadsheet_id=? AND expense_id=? AND source_version=? AND projection=? AND state='IN_FLIGHT' AND operation_token=?`).bind(new Date().toISOString(),this.env.GOOGLE_SPREADSHEET_ID,this.job.entityKey,this.job.entityVersion,projection,token).run();return Number(result.meta.changes||0)===1;
  }
  async complete(c:ExpenseProjectionContext):Promise<boolean>{
    this.check();void c;
    // A generation-aware, three-projection completion transaction does not
    // exist yet. Never complete the old sync job as a substitute.
    return false;
  }
}
