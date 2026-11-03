-- Candidate only. The immutable resolution records a reviewed postimage and
-- retains the notice and row evidence. It never sends a Google request.
CREATE TABLE daily_reviewed_resolutions (
 action_id TEXT PRIMARY KEY,spreadsheet_id TEXT NOT NULL,sheet_name TEXT NOT NULL,
 window_token TEXT NOT NULL,witness_action_id TEXT NOT NULL UNIQUE,expense_id TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(typeof(source_version)='integer' AND source_version BETWEEN 1 AND 9007199254740991),source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer' AND source_revision BETWEEN 1 AND 9007199254740991),metadata_id INTEGER NOT NULL CHECK(typeof(metadata_id)='integer' AND metadata_id BETWEEN 1 AND 2147483647),
 notice_token TEXT NOT NULL,mutation_token TEXT NOT NULL,outer_token TEXT NOT NULL,
 cutover_generation TEXT NOT NULL,evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
 editors_paused INTEGER NOT NULL CHECK(editors_paused=1),writers_drained INTEGER NOT NULL CHECK(writers_drained=1),
 principal TEXT NOT NULL CHECK(principal='ADMIN_TOKEN'),created_at TEXT NOT NULL,
 UNIQUE(spreadsheet_id,sheet_name,window_token)
);
CREATE TRIGGER daily_resolution_no_delete BEFORE DELETE ON daily_reviewed_resolutions BEGIN SELECT RAISE(ABORT,'daily resolution retained'); END;
CREATE TRIGGER daily_resolution_no_update BEFORE UPDATE ON daily_reviewed_resolutions BEGIN SELECT RAISE(ABORT,'daily resolution immutable'); END;
CREATE TRIGGER daily_resolution_no_replace BEFORE INSERT ON daily_reviewed_resolutions WHEN EXISTS(SELECT 1 FROM daily_reviewed_resolutions x WHERE x.rowid=NEW.rowid OR x.action_id=NEW.action_id OR x.witness_action_id=NEW.witness_action_id OR (x.spreadsheet_id=NEW.spreadsheet_id AND x.sheet_name=NEW.sheet_name AND x.window_token=NEW.window_token)) BEGIN SELECT RAISE(ABORT,'daily resolution collision'); END;
-- Only a resolution inserted in the same transaction may clear a window.
DROP TRIGGER daily_coordination_review_terminal;
CREATE TRIGGER daily_coordination_review_terminal BEFORE UPDATE ON daily_edit_coordination
WHEN OLD.state<>NEW.state AND NOT ((OLD.state='AVAILABLE' AND NEW.state IN ('NOTICE','REVIEW')) OR (OLD.state IN ('NOTICE','SYNCING') AND NEW.state='REVIEW') OR (OLD.state IN ('NOTICE','SYNCING','REVIEW') AND NEW.state='AVAILABLE' AND EXISTS(SELECT 1 FROM daily_reviewed_resolutions x WHERE x.spreadsheet_id=OLD.spreadsheet_id AND x.sheet_name=OLD.sheet_name AND x.window_token=OLD.window_token AND x.cutover_generation=OLD.cutover_generation)))
BEGIN SELECT RAISE(ABORT,'daily coordination review'); END;
DROP TRIGGER daily_coordination_window_immutable;
CREATE TRIGGER daily_coordination_window_immutable BEFORE UPDATE ON daily_edit_coordination
WHEN OLD.rowid IS NOT NEW.rowid OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR (OLD.state<>'AVAILABLE' AND NOT (NEW.state='AVAILABLE' AND EXISTS(SELECT 1 FROM daily_reviewed_resolutions x WHERE x.spreadsheet_id=OLD.spreadsheet_id AND x.sheet_name=OLD.sheet_name AND x.window_token=OLD.window_token AND x.cutover_generation=OLD.cutover_generation)) AND (OLD.window_token IS NOT NEW.window_token OR OLD.cutover_generation IS NOT NEW.cutover_generation OR OLD.notice_until IS NOT NEW.notice_until OR OLD.badge_expense_id IS NOT NEW.badge_expense_id OR OLD.badge_source_version IS NOT NEW.badge_source_version OR OLD.badge_source_revision IS NOT NEW.badge_source_revision OR OLD.badge_watermark IS NOT NEW.badge_watermark OR OLD.badge_outer_token IS NOT NEW.badge_outer_token OR OLD.badge_sync_lease IS NOT NEW.badge_sync_lease OR OLD.badge_generation_lease IS NOT NEW.badge_generation_lease OR OLD.badge_notice_seconds IS NOT NEW.badge_notice_seconds OR julianday(NEW.deadline) IS NULL OR julianday(NEW.deadline)>julianday(OLD.deadline)))
BEGIN SELECT RAISE(ABORT,'daily coordination window immutable'); END;
CREATE TRIGGER daily_resolution_validate BEFORE INSERT ON daily_reviewed_resolutions
WHEN NOT EXISTS(
 SELECT 1 FROM daily_witness_recovery_actions a
 JOIN daily_row_mutation_evidence d ON d.spreadsheet_id=a.spreadsheet_id AND d.sheet_name=a.sheet_name AND d.window_token=a.window_token AND d.expense_id=a.expense_id AND d.source_version=a.source_version AND d.source_revision=a.source_revision AND d.metadata_id=a.metadata_id AND d.notice_operation_token=a.notice_token AND d.mutation_operation_token=a.mutation_token AND d.state='REVIEW'
 JOIN daily_notice_dispatch_intents n ON n.spreadsheet_id=d.spreadsheet_id AND n.sheet_name=d.sheet_name AND n.window_token=d.window_token AND n.operation_token=d.notice_operation_token AND n.outer_token=a.outer_token AND n.state='REVIEW'
 JOIN daily_sheet_notice_receipts receipt ON receipt.spreadsheet_id=n.spreadsheet_id AND receipt.sheet_name=n.sheet_name AND receipt.window_token=n.window_token AND receipt.badge_operation_token=n.badge_operation_token
 JOIN daily_sheet_badge_journal b ON b.spreadsheet_id=n.spreadsheet_id AND b.sheet_id=n.sheet_id AND b.state_range_id=n.state_range_id AND b.time_range_id=n.time_range_id AND b.verified_operation_token=n.badge_operation_token AND b.preimage_json=n.preimage_json AND b.expected_values_json=n.expected_values_json AND b.state='READY'
 JOIN daily_edit_coordination c ON c.spreadsheet_id=n.spreadsheet_id AND c.sheet_name=n.sheet_name AND c.window_token=n.window_token AND c.cutover_generation=n.cutover_generation AND c.badge_expense_id=n.expense_id AND c.badge_source_version=n.source_version AND c.badge_source_revision=n.source_revision AND c.badge_outer_token=n.outer_token AND c.badge_sync_lease=n.sync_lease AND c.badge_generation_lease=n.generation_lease AND c.state IN ('NOTICE','SYNCING','REVIEW')
 JOIN daily_legacy_writer_gates gate ON gate.spreadsheet_id=n.spreadsheet_id AND gate.sheet_name=n.sheet_name AND gate.generation=n.cutover_generation AND gate.state='HOLD'
 JOIN expense_projection_cutovers cutover ON cutover.spreadsheet_id=gate.spreadsheet_id AND cutover.sheet_name=gate.sheet_name AND cutover.generation=gate.generation AND cutover.state='ACTIVE'
 JOIN expense_projection_runtime_intents p ON p.spreadsheet_id=d.spreadsheet_id AND p.expense_id=d.expense_id AND p.source_version=d.source_version AND p.source_revision=d.source_revision AND p.projection='DAILY' AND p.operation_token=n.outer_token AND p.cutover_generation=n.cutover_generation AND p.admission_watermark=cutover.admission_watermark AND c.badge_watermark=p.admission_watermark AND p.state='REVIEW'
 JOIN expense_events e ON e.expense_id=d.expense_id AND e.version=d.source_version AND e.status='CONFIRMED'
 JOIN expense_projection_source_revisions r ON r.expense_id=e.expense_id AND r.revision=d.source_revision AND r.state='TRACKED'
 JOIN daily_stable_row_intents i ON i.spreadsheet_id=d.spreadsheet_id AND i.sheet_name=d.sheet_name AND i.expense_id=d.expense_id AND i.metadata_id=d.metadata_id AND i.projected_version=d.source_version AND i.projected_revision=d.source_revision AND i.state='VERIFIED'
 JOIN daily_recovery_identity_witnesses w ON w.spreadsheet_id=i.spreadsheet_id AND w.sheet_name=i.sheet_name AND w.expense_id=i.expense_id AND w.metadata_id=i.metadata_id AND w.projected_version=i.projected_version AND w.projected_revision=i.projected_revision AND w.baseline_sha256=a.baseline_sha256 AND w.provenance='PRODUCTION_VERIFIED_WRITER'
 JOIN sheet_metadata_identity_registry g ON g.spreadsheet_id=i.spreadsheet_id AND g.sheet_name=i.sheet_name AND g.metadata_id=i.metadata_id AND g.entity_kind='EXPENSE' AND g.entity_id=i.expense_id
 WHERE a.action_id=NEW.witness_action_id AND a.spreadsheet_id=NEW.spreadsheet_id AND a.sheet_name=NEW.sheet_name AND a.window_token=NEW.window_token AND a.expense_id=NEW.expense_id AND a.metadata_id=NEW.metadata_id AND a.source_version=NEW.source_version AND a.source_revision=NEW.source_revision AND a.notice_token=NEW.notice_token AND a.mutation_token=NEW.mutation_token AND a.outer_token=NEW.outer_token AND n.cutover_generation=NEW.cutover_generation
 AND c.badge_notice_seconds BETWEEN 15 AND 60 AND julianday(receipt.observed_at) IS NOT NULL AND julianday(receipt.ready_after)>=julianday(receipt.observed_at,'+'||c.badge_notice_seconds||' seconds') AND julianday(receipt.ready_after)<=julianday('now') AND json_valid(n.expected_values_json) AND json_extract(n.expected_values_json,'$[0]')='พัก'
 AND NOT EXISTS(SELECT 1 FROM sync_jobs j WHERE j.status='PROCESSING')
 AND NOT EXISTS(SELECT 1 FROM expense_projection_generation_jobs j WHERE j.spreadsheet_id=NEW.spreadsheet_id AND j.state='IN_FLIGHT')
 AND NOT EXISTS(SELECT 1 FROM personal_projection_generation_jobs j WHERE j.spreadsheet_id=NEW.spreadsheet_id AND j.state='IN_FLIGHT')
 AND NOT EXISTS(SELECT 1 FROM expense_projection_runtime_intents q WHERE q.spreadsheet_id=NEW.spreadsheet_id AND q.state='IN_FLIGHT')
 AND NOT EXISTS(SELECT 1 FROM personal_projection_runtime_intents q WHERE q.spreadsheet_id=NEW.spreadsheet_id AND q.state='IN_FLIGHT')
 AND NOT EXISTS(SELECT 1 FROM expense_projection_generation_observations seen WHERE seen.spreadsheet_id=NEW.spreadsheet_id AND seen.expense_id=NEW.expense_id AND seen.source_revision>NEW.source_revision)
 AND NOT EXISTS(SELECT 1 FROM expense_projection_generation_jobs seen WHERE seen.spreadsheet_id=NEW.spreadsheet_id AND seen.expense_id=NEW.expense_id AND seen.source_revision>NEW.source_revision)
 AND NOT EXISTS(SELECT 1 FROM daily_notice_dispatch_intents other WHERE other.spreadsheet_id=NEW.spreadsheet_id AND other.sheet_name=NEW.sheet_name AND other.window_token<>NEW.window_token AND other.state IN ('IN_FLIGHT','REVIEW') AND NOT EXISTS(SELECT 1 FROM daily_reviewed_resolutions done WHERE done.spreadsheet_id=other.spreadsheet_id AND done.sheet_name=other.sheet_name AND done.window_token=other.window_token AND done.notice_token=other.operation_token))
 AND NOT EXISTS(SELECT 1 FROM daily_row_mutation_evidence other WHERE other.spreadsheet_id=NEW.spreadsheet_id AND other.sheet_name=NEW.sheet_name AND other.window_token<>NEW.window_token AND other.state IN ('PREPARED','IN_FLIGHT','REVIEW') AND NOT EXISTS(SELECT 1 FROM daily_reviewed_resolutions done WHERE done.spreadsheet_id=other.spreadsheet_id AND done.sheet_name=other.sheet_name AND done.window_token=other.window_token AND done.mutation_token=other.mutation_operation_token))
 AND NOT EXISTS(SELECT 1 FROM expense_projection_runtime_intents other WHERE other.spreadsheet_id=NEW.spreadsheet_id AND other.projection='DAILY' AND other.state='REVIEW' AND other.operation_token<>NEW.outer_token)
)
BEGIN SELECT RAISE(ABORT,'daily resolution evidence changed'); END;
CREATE TRIGGER daily_resolution_apply AFTER INSERT ON daily_reviewed_resolutions
BEGIN
 UPDATE expense_projection_runtime_intents SET state='VERIFIED',evidence_digest=NEW.evidence_digest,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=NEW.spreadsheet_id AND expense_id=NEW.expense_id AND source_version=NEW.source_version AND source_revision=NEW.source_revision AND projection='DAILY' AND operation_token=NEW.outer_token AND cutover_generation=NEW.cutover_generation AND state='REVIEW';
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'daily resolution projection changed') END;
 UPDATE daily_edit_coordination SET state='AVAILABLE',window_token=NULL,cutover_generation=NULL,notice_until=NULL,deadline=NULL,badge_expense_id=NULL,badge_source_version=NULL,badge_source_revision=NULL,badge_watermark=NULL,badge_outer_token=NULL,badge_sync_lease=NULL,badge_generation_lease=NULL,badge_notice_seconds=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=NEW.spreadsheet_id AND sheet_name=NEW.sheet_name AND window_token=NEW.window_token AND cutover_generation=NEW.cutover_generation AND state IN ('NOTICE','SYNCING','REVIEW');
 SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'daily resolution window changed') END;
END;
