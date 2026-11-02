import type {Env} from '../types';

/** Unwired, default-off discovery only. This does not lease work, create an
 * intent, enqueue a job or establish permission to mutate Google Sheets.
 * Dispatch requires its own generation-scoped journal, exclusive fencing,
 * source recheck, trusted provider evidence and reviewed recovery workflow. */
export async function discoverExpenseProjectionGenerations(env:Env,limit:number):Promise<number>{
  if(env.RUNTIME_MODE!=='production'||env.EXPENSE_STABLE_PROJECTION_ENABLED!=='true'||env.DAILY_LEGACY_WRITER_GATE_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||!env.SHEET_EXPENSE_DAILY||!env.SHEET_EXPENSE_RAW||!Number.isInteger(limit)||limit<1||limit>200)throw new Error('EXPENSE_GENERATION_DISCOVERY_DISABLED');
  const run=crypto.randomUUID();
  const init=env.DB.prepare(`INSERT INTO expense_projection_discovery_cursors(spreadsheet_id,cutover_generation,last_expense_id)
    SELECT c.spreadsheet_id,c.generation,'' FROM expense_projection_cutovers c JOIN daily_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.state='HOLD' AND g.generation=c.generation
    WHERE c.spreadsheet_id=? AND c.sheet_name=? AND c.state='ACTIVE' ON CONFLICT(spreadsheet_id,cutover_generation) DO NOTHING`).bind(env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY);
  const insert=env.DB.prepare(`INSERT INTO expense_projection_generation_observations(spreadsheet_id,cutover_generation,expense_id,source_version,source_revision,state,reason,discovery_run_id,discovery_order,discovered_at)
    SELECT ?,c.generation,s.expense_id,s.source_version,s.source_revision,
      CASE WHEN s.reason IS NULL THEN 'PENDING' ELSE 'REVIEW' END,s.reason,?,ROW_NUMBER() OVER (ORDER BY CASE WHEN s.expense_id>q.last_expense_id THEN 0 ELSE 1 END,s.expense_id),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM expense_projection_cutovers c JOIN daily_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.state='HOLD' AND g.generation=c.generation
    JOIN expense_projection_discovery_cursors q ON q.spreadsheet_id=c.spreadsheet_id AND q.cutover_generation=c.generation
    JOIN (
      SELECT r.expense_id,CASE WHEN typeof(e.version)='integer' AND e.version BETWEEN 1 AND 9007199254740991 THEN e.version ELSE 0 END AS source_version,CASE WHEN typeof(r.revision)='integer' AND r.revision BETWEEN 1 AND 9007199254740991 THEN r.revision ELSE 0 END AS source_revision,
        CASE WHEN typeof(r.revision)<>'integer' OR r.revision NOT BETWEEN 1 AND 9007199254740991 THEN 'SOURCE_REVISION_INVALID' WHEN r.state<>'TRACKED' THEN 'SOURCE_REVIEW' WHEN e.expense_id IS NULL THEN 'SOURCE_MISSING' WHEN typeof(e.version)<>'integer' OR e.version NOT BETWEEN 1 AND 9007199254740991 THEN 'SOURCE_VERSION_INVALID' WHEN e.status<>'CONFIRMED' THEN 'SOURCE_NOT_CONFIRMED' WHEN a.expense_id IS NULL THEN 'ADMISSION_MISSING' WHEN a.sequence<=cut.admission_watermark THEN 'HISTORICAL_IDENTITY_UNVERIFIED' WHEN EXISTS(SELECT 1 FROM expense_projection_runtime_intents p WHERE p.spreadsheet_id=cut.spreadsheet_id AND p.expense_id=r.expense_id AND p.state IN ('IN_FLIGHT','REVIEW')) THEN 'PRIOR_INTENT_UNRESOLVED' WHEN EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.sheet_name IN (?,?,?) AND (i.entity_key=r.expense_id OR substr(i.entity_key,1,length(r.expense_id)+1)=r.expense_id||'|')) THEN 'LEGACY_MAPPING_PRESENT' ELSE NULL END AS reason
      FROM expense_projection_source_revisions r LEFT JOIN expense_events e ON e.expense_id=r.expense_id LEFT JOIN expense_projection_admissions a ON a.expense_id=r.expense_id
      JOIN expense_projection_cutovers cut ON cut.spreadsheet_id=? AND cut.sheet_name=? AND cut.state='ACTIVE'
      UNION ALL
      SELECT e.expense_id,CASE WHEN typeof(e.version)='integer' AND e.version BETWEEN 1 AND 9007199254740991 THEN e.version ELSE 0 END,0,'REVISION_MISSING' FROM expense_events e WHERE NOT EXISTS(SELECT 1 FROM expense_projection_source_revisions r WHERE r.expense_id=e.expense_id)
      UNION ALL
      SELECT a.expense_id,0,0,'SOURCE_AND_REVISION_MISSING' FROM expense_projection_admissions a WHERE NOT EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=a.expense_id) AND NOT EXISTS(SELECT 1 FROM expense_projection_source_revisions r WHERE r.expense_id=a.expense_id)
    ) s
    WHERE c.spreadsheet_id=? AND c.sheet_name=? AND c.state='ACTIVE'
      AND NOT EXISTS(SELECT 1 FROM expense_projection_generation_observations o WHERE o.spreadsheet_id=c.spreadsheet_id AND o.cutover_generation=c.generation AND o.expense_id=s.expense_id AND o.source_version=s.source_version AND o.source_revision=s.source_revision)
    ORDER BY CASE WHEN s.expense_id>q.last_expense_id THEN 0 ELSE 1 END,s.expense_id LIMIT ?
    ON CONFLICT(spreadsheet_id,cutover_generation,expense_id,source_version,source_revision) DO NOTHING`).bind(env.GOOGLE_SPREADSHEET_ID,run,env.SHEET_EXPENSE_DAILY,env.SHEET_EXPENSE_RAW,env.SHEET_PURCHASE_DETAILS||'รายละเอียดการซื้อ',env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,env.GOOGLE_SPREADSHEET_ID,env.SHEET_EXPENSE_DAILY,limit);
  const advance=env.DB.prepare(`UPDATE expense_projection_discovery_cursors SET last_expense_id=(SELECT o.expense_id FROM expense_projection_generation_observations o WHERE o.spreadsheet_id=expense_projection_discovery_cursors.spreadsheet_id AND o.cutover_generation=expense_projection_discovery_cursors.cutover_generation AND o.discovery_run_id=? ORDER BY o.discovery_order DESC LIMIT 1)
    WHERE spreadsheet_id=? AND EXISTS(SELECT 1 FROM expense_projection_generation_observations o WHERE o.spreadsheet_id=expense_projection_discovery_cursors.spreadsheet_id AND o.cutover_generation=expense_projection_discovery_cursors.cutover_generation AND o.discovery_run_id=?)`).bind(run,env.GOOGLE_SPREADSHEET_ID,run);
  // D1 batch is one transaction: an interrupted scan cannot advance its
  // cursor without preserving its discoveries, or vice versa.
  const results=await env.DB.batch([init,insert,advance]);
  return Number(results[1]?.meta.changes||0);
}
