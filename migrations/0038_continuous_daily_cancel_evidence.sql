-- Positive-only evidence captured atomically with the cancellation intent.
-- A missing or mismatched tombstone never permits retry of a provider write.
CREATE TABLE IF NOT EXISTS continuous_daily_cancel_evidence (
 spreadsheet_id TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 cancellation_version INTEGER NOT NULL CHECK(cancellation_version>1),
 previous_version INTEGER NOT NULL CHECK(previous_version>0 AND cancellation_version>previous_version),
 operation_token TEXT NOT NULL,
 sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
 sheet_name TEXT NOT NULL CHECK(length(sheet_name)>0),
 target_row INTEGER NOT NULL CHECK(target_row>=4),
 row_count INTEGER NOT NULL CHECK(row_count>=4 AND row_count<=5000 AND target_row<=row_count),
 column_count INTEGER NOT NULL CHECK(column_count>=29 AND column_count<=100),
 posting_year INTEGER NOT NULL CHECK(posting_year BETWEEN 1900 AND 9999),
 posting_month INTEGER NOT NULL CHECK(posting_month BETWEEN 1 AND 12),
 source_revision INTEGER NOT NULL CHECK(source_revision>=0),
 source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
 original_digest TEXT NOT NULL CHECK(length(original_digest)=64 AND original_digest NOT GLOB '*[^0-9a-f]*'),
 masked_before_digest TEXT NOT NULL CHECK(length(masked_before_digest)=64 AND masked_before_digest NOT GLOB '*[^0-9a-f]*'),
 tombstone TEXT NOT NULL CHECK(length(tombstone)=79 AND substr(tombstone,1,15)='MPD1_CANCELLED_' AND substr(tombstone,16) NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(spreadsheet_id,entity_id,cancellation_version)
);
CREATE TRIGGER IF NOT EXISTS continuous_daily_cancel_evidence_source BEFORE INSERT ON continuous_daily_cancel_evidence
WHEN NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c JOIN stable_daily_cancellation_metadata m ON m.spreadsheet_id=c.spreadsheet_id AND m.entity_type=c.entity_type AND m.entity_id=c.entity_id AND m.projection=c.projection AND m.cancellation_version=c.cancellation_version AND m.operation_token=c.operation_token JOIN stable_source_revision r ON r.singleton=1 AND r.revision=NEW.source_revision JOIN expense_events e ON e.expense_id=c.entity_id AND e.version=c.cancellation_version AND e.status='CANCELLED' JOIN stable_workbook_claims claim ON claim.spreadsheet_id=c.spreadsheet_id AND claim.operation_token=c.operation_token AND claim.state='HELD' WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.entity_type='EXPENSE' AND c.entity_id=NEW.entity_id AND c.projection='DAILY' AND c.cancellation_version=NEW.cancellation_version AND c.previous_version=NEW.previous_version AND c.operation_token=NEW.operation_token AND c.preimage_digest=NEW.original_digest AND c.state='IN_FLIGHT' AND m.sheet_id=NEW.sheet_id AND m.sheet_name=NEW.sheet_name AND m.posting_year=NEW.posting_year AND m.posting_month=NEW.posting_month)
BEGIN SELECT RAISE(ABORT,'daily cancel evidence requires exact intent'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_cancel_evidence_no_update BEFORE UPDATE ON continuous_daily_cancel_evidence
BEGIN SELECT RAISE(ABORT,'daily cancel evidence immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_cancel_evidence_no_delete BEFORE DELETE ON continuous_daily_cancel_evidence
BEGIN SELECT RAISE(ABORT,'daily cancel evidence retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_cancel_evidence_no_replace BEFORE INSERT ON continuous_daily_cancel_evidence
WHEN EXISTS(SELECT 1 FROM continuous_daily_cancel_evidence e WHERE e.rowid=NEW.rowid OR (e.spreadsheet_id=NEW.spreadsheet_id AND e.entity_id=NEW.entity_id AND e.cancellation_version=NEW.cancellation_version))
BEGIN SELECT RAISE(ABORT,'daily cancel evidence collision'); END;
