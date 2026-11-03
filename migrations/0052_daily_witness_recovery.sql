-- Append-only audit for a verified DAILY postimage. This migration does not
-- release any REVIEW/IN_FLIGHT operation or change a Google Sheet.
CREATE TABLE daily_witness_recovery_actions (
 action_id TEXT PRIMARY KEY,spreadsheet_id TEXT NOT NULL,sheet_name TEXT NOT NULL,
 window_token TEXT NOT NULL,expense_id TEXT NOT NULL,metadata_id INTEGER NOT NULL CHECK(typeof(metadata_id)='integer' AND metadata_id BETWEEN 1 AND 2147483647),
 source_version INTEGER NOT NULL CHECK(typeof(source_version)='integer' AND source_version BETWEEN 1 AND 9007199254740991),source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer' AND source_revision BETWEEN 1 AND 9007199254740991),
 notice_token TEXT NOT NULL,mutation_token TEXT NOT NULL,outer_token TEXT NOT NULL,
 evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64 AND baseline_sha256 NOT GLOB '*[^0-9a-f]*'),
 editors_paused INTEGER NOT NULL CHECK(editors_paused=1),writers_drained INTEGER NOT NULL CHECK(writers_drained=1),
 principal TEXT NOT NULL CHECK(principal='ADMIN_TOKEN'),
 created_at TEXT NOT NULL,UNIQUE(spreadsheet_id,sheet_name,window_token)
);
CREATE TABLE daily_witness_recovery_assertions (assertion_id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));
CREATE TRIGGER daily_witness_recovery_no_delete BEFORE DELETE ON daily_witness_recovery_actions BEGIN SELECT RAISE(ABORT,'daily witness recovery retained'); END;
CREATE TRIGGER daily_witness_recovery_no_update BEFORE UPDATE ON daily_witness_recovery_actions BEGIN SELECT RAISE(ABORT,'daily witness recovery immutable'); END;
CREATE TRIGGER daily_witness_recovery_no_replace BEFORE INSERT ON daily_witness_recovery_actions
WHEN EXISTS(SELECT 1 FROM daily_witness_recovery_actions a WHERE a.rowid=NEW.rowid OR a.action_id=NEW.action_id OR (a.spreadsheet_id=NEW.spreadsheet_id AND a.sheet_name=NEW.sheet_name AND a.window_token=NEW.window_token))
BEGIN SELECT RAISE(ABORT,'daily witness recovery collision'); END;
