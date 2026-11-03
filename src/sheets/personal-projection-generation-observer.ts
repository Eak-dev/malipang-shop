import type {Env} from '../types';

/** Unwired, default-off discovery only. This does not lease work, create an
 * intent, enqueue a job or establish permission to mutate Google Sheets.
 * Dispatch requires its own generation-scoped journal, exclusive fencing,
 * source recheck, trusted provider evidence and reviewed recovery workflow. */
export async function discoverPersonalProjectionGenerations(env:Env,limit:number):Promise<number>{
  if(env.RUNTIME_MODE!=='production'||env.PERSONAL_STABLE_PROJECTION_ENABLED!=='true'||!env.GOOGLE_SPREADSHEET_ID||!Number.isInteger(limit)||limit<1||limit>200)throw new Error('PERSONAL_GENERATION_DISCOVERY_DISABLED');
  const run=crypto.randomUUID();
  const init=env.DB.prepare(`INSERT INTO personal_projection_discovery_cursors(spreadsheet_id,cutover_generation,last_personal_use_id)
    SELECT c.spreadsheet_id,c.generation,'' FROM personal_projection_cutovers c JOIN personal_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.state='HOLD' AND g.generation=c.generation
    WHERE c.spreadsheet_id=? AND c.sheet_name=? AND c.state='ACTIVE' ON CONFLICT(spreadsheet_id,cutover_generation) DO NOTHING`).bind(env.GOOGLE_SPREADSHEET_ID,(env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW'));
  const insert=env.DB.prepare(`INSERT INTO personal_projection_generation_observations(spreadsheet_id,cutover_generation,personal_use_id,source_version,source_revision,state,reason,discovery_run_id,discovery_order,discovered_at)
    SELECT ?,c.generation,s.personal_use_id,s.source_version,s.source_revision,
      CASE WHEN s.reason IS NULL THEN 'PENDING' ELSE 'REVIEW' END,s.reason,?,ROW_NUMBER() OVER (ORDER BY CASE WHEN s.personal_use_id>q.last_personal_use_id THEN 0 ELSE 1 END,s.personal_use_id),strftime('%Y-%m-%dT%H:%M:%fZ','now')
    FROM personal_projection_cutovers c JOIN personal_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.state='HOLD' AND g.generation=c.generation
    JOIN personal_projection_discovery_cursors q ON q.spreadsheet_id=c.spreadsheet_id AND q.cutover_generation=c.generation
    JOIN (
      SELECT r.personal_use_id,CASE WHEN typeof(e.version)='integer' AND e.version BETWEEN 1 AND 9007199254740991 THEN e.version ELSE 0 END AS source_version,CASE WHEN typeof(r.revision)='integer' AND r.revision BETWEEN 1 AND 9007199254740991 THEN r.revision ELSE 0 END AS source_revision,
        CASE WHEN typeof(r.revision)<>'integer' OR r.revision NOT BETWEEN 1 AND 9007199254740991 THEN 'SOURCE_REVISION_INVALID' WHEN r.state<>'TRACKED' THEN 'SOURCE_REVIEW' WHEN e.personal_use_id IS NULL THEN 'SOURCE_MISSING' WHEN typeof(e.version)<>'integer' OR e.version NOT BETWEEN 1 AND 9007199254740991 THEN 'SOURCE_VERSION_INVALID' WHEN e.status='CANCELLED' THEN 'CANCELLATION_REQUIRES_IDENTITY_REVIEW' WHEN e.status='WAITING_CONFIRM' AND NOT EXISTS(SELECT 1 FROM personal_projection_runtime_intents p WHERE p.spreadsheet_id=cut.spreadsheet_id AND p.personal_use_id=r.personal_use_id) AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.sheet_name=cut.sheet_name AND i.entity_key=r.personal_use_id) AND NOT EXISTS(SELECT 1 FROM personal_projection_generation_observations o WHERE o.spreadsheet_id=cut.spreadsheet_id AND o.personal_use_id=r.personal_use_id) AND NOT EXISTS(SELECT 1 FROM personal_projection_generation_jobs q WHERE q.spreadsheet_id=cut.spreadsheet_id AND q.personal_use_id=r.personal_use_id) THEN 'WAITING_WITHOUT_PROJECTION' WHEN e.status<>'CONFIRMED' THEN 'SOURCE_NOT_CONFIRMED' WHEN a.personal_use_id IS NULL THEN 'ADMISSION_MISSING' WHEN a.sequence<=cut.admission_watermark THEN 'HISTORICAL_IDENTITY_UNVERIFIED' WHEN EXISTS(SELECT 1 FROM personal_projection_runtime_intents p WHERE p.spreadsheet_id=cut.spreadsheet_id AND p.personal_use_id=r.personal_use_id AND p.state IN ('IN_FLIGHT','REVIEW')) THEN 'PRIOR_INTENT_UNRESOLVED' WHEN EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.sheet_name=? AND i.entity_key=r.personal_use_id) THEN 'LEGACY_MAPPING_PRESENT' ELSE NULL END AS reason
      FROM personal_projection_source_revisions r LEFT JOIN owner_personal_transactions e ON e.personal_use_id=r.personal_use_id LEFT JOIN personal_projection_admissions a ON a.personal_use_id=r.personal_use_id
      JOIN personal_projection_cutovers cut ON cut.spreadsheet_id=? AND cut.sheet_name=? AND cut.state='ACTIVE'
      UNION ALL
      SELECT e.personal_use_id,CASE WHEN typeof(e.version)='integer' AND e.version BETWEEN 1 AND 9007199254740991 THEN e.version ELSE 0 END,0,'REVISION_MISSING' FROM owner_personal_transactions e WHERE NOT EXISTS(SELECT 1 FROM personal_projection_source_revisions r WHERE r.personal_use_id=e.personal_use_id)
      UNION ALL
      SELECT a.personal_use_id,0,0,'SOURCE_AND_REVISION_MISSING' FROM personal_projection_admissions a WHERE NOT EXISTS(SELECT 1 FROM owner_personal_transactions e WHERE e.personal_use_id=a.personal_use_id) AND NOT EXISTS(SELECT 1 FROM personal_projection_source_revisions r WHERE r.personal_use_id=a.personal_use_id)
    ) s
    WHERE c.spreadsheet_id=? AND c.sheet_name=? AND c.state='ACTIVE'
      AND (s.reason IS NULL OR s.reason<>'WAITING_WITHOUT_PROJECTION')
      AND NOT EXISTS(SELECT 1 FROM personal_projection_generation_observations o WHERE o.spreadsheet_id=c.spreadsheet_id AND o.cutover_generation=c.generation AND o.personal_use_id=s.personal_use_id AND o.source_version=s.source_version AND o.source_revision=s.source_revision)
    ORDER BY CASE WHEN s.personal_use_id>q.last_personal_use_id THEN 0 ELSE 1 END,s.personal_use_id LIMIT ?
    ON CONFLICT(spreadsheet_id,cutover_generation,personal_use_id,source_version,source_revision) DO NOTHING`).bind(env.GOOGLE_SPREADSHEET_ID,run,(env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW'),env.GOOGLE_SPREADSHEET_ID,(env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW'),env.GOOGLE_SPREADSHEET_ID,(env.SHEET_PERSONAL_USE_RAW||'V52_PERSONAL_USE_RAW'),limit);
  const advance=env.DB.prepare(`UPDATE personal_projection_discovery_cursors SET last_personal_use_id=(SELECT o.personal_use_id FROM personal_projection_generation_observations o WHERE o.spreadsheet_id=personal_projection_discovery_cursors.spreadsheet_id AND o.cutover_generation=personal_projection_discovery_cursors.cutover_generation AND o.discovery_run_id=? ORDER BY o.discovery_order DESC LIMIT 1)
    WHERE spreadsheet_id=? AND EXISTS(SELECT 1 FROM personal_projection_generation_observations o WHERE o.spreadsheet_id=personal_projection_discovery_cursors.spreadsheet_id AND o.cutover_generation=personal_projection_discovery_cursors.cutover_generation AND o.discovery_run_id=?)`).bind(run,env.GOOGLE_SPREADSHEET_ID,run);
  // D1 batch is one transaction: an interrupted scan cannot advance its
  // cursor without preserving its discoveries, or vice versa.
  const results=await env.DB.batch([init,insert,advance]);
  return Number(results[1]?.meta.changes||0);
}
