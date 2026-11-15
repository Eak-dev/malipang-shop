-- Explicit, irreversible runtime guard. No row is created by this migration.
-- An older deployment cannot be fenced by a D1 table it never reads.
CREATE TABLE IF NOT EXISTS continuous_notice_activation (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 spreadsheet_id TEXT NOT NULL,
 legacy_sheet_name TEXT NOT NULL,
 daily_sheet_name TEXT NOT NULL,
 daily_sheet_id INTEGER NOT NULL,
 raw_sheet_name TEXT NOT NULL,
 raw_sheet_id INTEGER NOT NULL,
 detail_sheet_name TEXT NOT NULL,
 detail_sheet_id INTEGER NOT NULL,
 publication_sheet_name TEXT NOT NULL,
 publication_sheet_id INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state='ACTIVE'),
 activated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS continuous_notice_activation_insert BEFORE INSERT ON continuous_notice_activation
WHEN NEW.state<>'ACTIVE' OR NOT EXISTS(SELECT 1 FROM continuous_daily_cutovers c JOIN continuous_publication_targets p ON p.spreadsheet_id=c.spreadsheet_id WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.state='ACTIVE' AND c.legacy_sheet_name=NEW.legacy_sheet_name AND c.continuous_sheet_name=NEW.daily_sheet_name AND c.continuous_sheet_id=NEW.daily_sheet_id AND c.raw_sheet_name=NEW.raw_sheet_name AND c.raw_sheet_id=NEW.raw_sheet_id AND c.detail_sheet_name=NEW.detail_sheet_name AND c.detail_sheet_id=NEW.detail_sheet_id AND p.sheet_name=NEW.publication_sheet_name AND p.sheet_id=NEW.publication_sheet_id) OR (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name='continuous_notice_dispatches' AND name IN ('continuous_notice_dispatch_owner_insert','continuous_notice_dispatch_owner_update'))<>2
BEGIN SELECT RAISE(ABORT,'notice activation requires exact active targets'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_activation_no_update BEFORE UPDATE ON continuous_notice_activation BEGIN SELECT RAISE(ABORT,'notice activation immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_activation_no_delete BEFORE DELETE ON continuous_notice_activation BEGIN SELECT RAISE(ABORT,'notice activation retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_activation_no_replace BEFORE INSERT ON continuous_notice_activation WHEN EXISTS(SELECT 1 FROM continuous_notice_activation WHERE singleton=NEW.singleton OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'notice activation exists'); END;
