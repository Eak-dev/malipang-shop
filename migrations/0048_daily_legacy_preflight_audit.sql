-- Historical preflight evidence only: it never grants mutation authority and
-- intentionally contains no physical Sheet row number.
CREATE TABLE IF NOT EXISTS daily_legacy_preflight_audit (
 action_id TEXT PRIMARY KEY,spreadsheet_id TEXT NOT NULL,sheet_name TEXT NOT NULL,
 posting_year INTEGER NOT NULL,posting_month INTEGER NOT NULL,
 expense_id TEXT NOT NULL,source_version INTEGER NOT NULL,source_revision INTEGER NOT NULL,
 source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64),
 source_inventory_digest TEXT NOT NULL CHECK(length(source_inventory_digest)=64),
 daily_inventory_digest TEXT NOT NULL CHECK(length(daily_inventory_digest)=64),
 raw_inventory_digest TEXT NOT NULL CHECK(length(raw_inventory_digest)=64),
 candidate_digest TEXT NOT NULL CHECK(length(candidate_digest)=64),
 decision TEXT NOT NULL CHECK(decision='PREFLIGHT_ONLY'),created_at TEXT NOT NULL,
 UNIQUE(spreadsheet_id,sheet_name,posting_year,posting_month,expense_id,source_version,source_revision,source_inventory_digest,daily_inventory_digest,raw_inventory_digest,candidate_digest)
);
CREATE TRIGGER daily_legacy_preflight_audit_no_delete BEFORE DELETE ON daily_legacy_preflight_audit BEGIN SELECT RAISE(ABORT,'daily preflight audit retained'); END;
CREATE TRIGGER daily_legacy_preflight_audit_no_update BEFORE UPDATE ON daily_legacy_preflight_audit BEGIN SELECT RAISE(ABORT,'daily preflight audit immutable'); END;
CREATE TRIGGER daily_legacy_preflight_audit_no_replace BEFORE INSERT ON daily_legacy_preflight_audit
WHEN EXISTS(SELECT 1 FROM daily_legacy_preflight_audit a WHERE a.rowid=NEW.rowid OR a.action_id=NEW.action_id OR (a.spreadsheet_id=NEW.spreadsheet_id AND a.sheet_name=NEW.sheet_name AND a.posting_year=NEW.posting_year AND a.posting_month=NEW.posting_month AND a.expense_id=NEW.expense_id AND a.source_version=NEW.source_version AND a.source_revision=NEW.source_revision AND a.source_inventory_digest=NEW.source_inventory_digest AND a.daily_inventory_digest=NEW.daily_inventory_digest AND a.raw_inventory_digest=NEW.raw_inventory_digest AND a.candidate_digest=NEW.candidate_digest))
BEGIN SELECT RAISE(ABORT,'daily preflight audit collision'); END;
