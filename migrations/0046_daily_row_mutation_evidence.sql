-- Existing enrolled-row updates only. Never stores a physical row number.
-- PREPARED/IN_FLIGHT/REVIEW are deliberately unresolved; no timeout releases.
CREATE TABLE IF NOT EXISTS daily_row_mutation_evidence (
 spreadsheet_id TEXT NOT NULL,sheet_name TEXT NOT NULL,window_token TEXT NOT NULL,
 notice_operation_token TEXT NOT NULL,mutation_operation_token TEXT NOT NULL UNIQUE,
 expense_id TEXT NOT NULL,source_version INTEGER NOT NULL,source_revision INTEGER NOT NULL,
 source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64),metadata_id INTEGER NOT NULL,
 baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),baseline_revision INTEGER NOT NULL CHECK(baseline_revision>0),preimage_digest TEXT NOT NULL CHECK(length(preimage_digest)=64),
 postimage_digest TEXT NOT NULL CHECK(length(postimage_digest)=64),posting_year INTEGER NOT NULL,
 posting_month INTEGER NOT NULL,posting_day INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('PREPARED','IN_FLIGHT','REVIEW')),
 updated_at TEXT NOT NULL,PRIMARY KEY(spreadsheet_id,sheet_name,window_token)
);
CREATE TRIGGER daily_row_evidence_no_delete BEFORE DELETE ON daily_row_mutation_evidence BEGIN SELECT RAISE(ABORT,'daily row evidence retained'); END;
CREATE TRIGGER daily_row_evidence_no_replace BEFORE INSERT ON daily_row_mutation_evidence
WHEN EXISTS(SELECT 1 FROM daily_row_mutation_evidence e WHERE e.rowid=NEW.rowid OR e.mutation_operation_token=NEW.mutation_operation_token OR (e.spreadsheet_id=NEW.spreadsheet_id AND e.sheet_name=NEW.sheet_name AND e.window_token=NEW.window_token))
BEGIN SELECT RAISE(ABORT,'daily row evidence collision'); END;
CREATE TRIGGER daily_row_evidence_transition BEFORE UPDATE ON daily_row_mutation_evidence
WHEN OLD.rowid IS NOT NEW.rowid OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR OLD.window_token IS NOT NEW.window_token OR OLD.notice_operation_token IS NOT NEW.notice_operation_token OR OLD.mutation_operation_token IS NOT NEW.mutation_operation_token OR OLD.expense_id IS NOT NEW.expense_id OR OLD.source_version IS NOT NEW.source_version OR OLD.source_revision IS NOT NEW.source_revision OR OLD.source_fingerprint IS NOT NEW.source_fingerprint OR OLD.metadata_id IS NOT NEW.metadata_id OR OLD.baseline_sha256 IS NOT NEW.baseline_sha256 OR OLD.baseline_revision IS NOT NEW.baseline_revision OR OLD.preimage_digest IS NOT NEW.preimage_digest OR OLD.postimage_digest IS NOT NEW.postimage_digest OR OLD.posting_year IS NOT NEW.posting_year OR OLD.posting_month IS NOT NEW.posting_month OR OLD.posting_day IS NOT NEW.posting_day OR NOT ((OLD.state='PREPARED' AND NEW.state IN ('IN_FLIGHT','REVIEW')) OR (OLD.state='IN_FLIGHT' AND NEW.state='REVIEW'))
BEGIN SELECT RAISE(ABORT,'daily row evidence transition invalid'); END;
