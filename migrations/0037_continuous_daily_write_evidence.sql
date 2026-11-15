-- Positive evidence for a daily insert. This records a digest, not source
-- cells or receipts, before any corresponding provider request is sent.
-- Its presence never proves an absent request is safe to send again.
CREATE TABLE IF NOT EXISTS continuous_daily_write_evidence (
 spreadsheet_id TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
 sheet_name TEXT NOT NULL CHECK(length(sheet_name)>0),
 source_version INTEGER NOT NULL CHECK(source_version>0),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
 operation_token TEXT NOT NULL,
 marker TEXT NOT NULL CHECK(length(marker)=39 AND substr(marker,1,7)='INSERT_' AND substr(marker,8) NOT GLOB '*[^0-9a-f]*'),
 target_row INTEGER NOT NULL CHECK(target_row>=5),
 before_rows INTEGER NOT NULL CHECK(before_rows>=5 AND before_rows<5000 AND target_row<=before_rows),
 before_columns INTEGER NOT NULL CHECK(before_columns>=29 AND before_columns<=100),
 before_digest TEXT NOT NULL CHECK(length(before_digest)=64 AND before_digest NOT GLOB '*[^0-9a-f]*'),
 payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(spreadsheet_id,entity_id)
);
CREATE TRIGGER IF NOT EXISTS continuous_daily_evidence_source BEFORE INSERT ON continuous_daily_write_evidence
WHEN NOT EXISTS(SELECT 1 FROM stable_projection_writes p JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.operation_token=p.operation_token WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=NEW.entity_id AND p.projection='DAILY' AND p.sheet_id=NEW.sheet_id AND p.sheet_name=NEW.sheet_name AND p.source_version=NEW.source_version AND p.source_digest=NEW.source_digest AND p.operation_token=NEW.operation_token AND p.state='IN_FLIGHT' AND m.marker=NEW.marker)
BEGIN SELECT RAISE(ABORT,'daily evidence requires exact intent'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_evidence_no_update BEFORE UPDATE ON continuous_daily_write_evidence
BEGIN SELECT RAISE(ABORT,'daily evidence immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_evidence_no_delete BEFORE DELETE ON continuous_daily_write_evidence
BEGIN SELECT RAISE(ABORT,'daily evidence retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_evidence_no_replace BEFORE INSERT ON continuous_daily_write_evidence
WHEN EXISTS(SELECT 1 FROM continuous_daily_write_evidence e WHERE e.rowid=NEW.rowid OR (e.spreadsheet_id=NEW.spreadsheet_id AND e.entity_id=NEW.entity_id))
BEGIN SELECT RAISE(ABORT,'daily evidence collision'); END;
