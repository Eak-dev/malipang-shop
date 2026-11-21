-- Additive, inert cutover boundary. Migration alone does not change routing,
-- enable a writer, prove Sheets settlement or authorize a production switch.
CREATE TABLE IF NOT EXISTS continuous_daily_cutovers (
 spreadsheet_id TEXT PRIMARY KEY CHECK(length(spreadsheet_id)>0),
 legacy_sheet_id INTEGER NOT NULL CHECK(typeof(legacy_sheet_id)='integer' AND legacy_sheet_id>=0),
 legacy_sheet_name TEXT NOT NULL CHECK(length(legacy_sheet_name)>0),
 continuous_sheet_id INTEGER NOT NULL CHECK(typeof(continuous_sheet_id)='integer' AND continuous_sheet_id>=0 AND continuous_sheet_id<>legacy_sheet_id),
 continuous_sheet_name TEXT NOT NULL CHECK(length(continuous_sheet_name)>0 AND continuous_sheet_name<>legacy_sheet_name),
 raw_sheet_id INTEGER NOT NULL CHECK(typeof(raw_sheet_id)='integer' AND raw_sheet_id>=0 AND raw_sheet_id NOT IN (legacy_sheet_id,continuous_sheet_id)),
 raw_sheet_name TEXT NOT NULL CHECK(length(raw_sheet_name)>0 AND raw_sheet_name NOT IN (legacy_sheet_name,continuous_sheet_name)),
 detail_sheet_id INTEGER NOT NULL CHECK(typeof(detail_sheet_id)='integer' AND detail_sheet_id>=0 AND detail_sheet_id NOT IN (legacy_sheet_id,continuous_sheet_id,raw_sheet_id)),
 detail_sheet_name TEXT NOT NULL CHECK(length(detail_sheet_name)>0 AND detail_sheet_name NOT IN (legacy_sheet_name,continuous_sheet_name,raw_sheet_name)),
 claim_token TEXT NOT NULL CHECK(length(claim_token)>0),
 source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer' AND source_revision>=0),
 state TEXT NOT NULL CHECK(state IN ('PREPARED','ACTIVE')),
 prepared_at TEXT NOT NULL,
 activated_at TEXT,
 CHECK((state='PREPARED' AND activated_at IS NULL) OR (state='ACTIVE' AND activated_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS continuous_daily_pre_cutover_expenses (
 spreadsheet_id TEXT NOT NULL,
 expense_id TEXT NOT NULL CHECK(length(expense_id)>0),
 PRIMARY KEY(spreadsheet_id,expense_id),
 FOREIGN KEY(spreadsheet_id) REFERENCES continuous_daily_cutovers(spreadsheet_id)
);
-- Keep cancelled pre-cutover sources out of the retained snapshot. Only an
-- INSERT after activation proves a source is new; absence from the earlier
-- snapshot alone is never used as that proof.
CREATE TABLE IF NOT EXISTS continuous_daily_post_cutover_expenses (
 spreadsheet_id TEXT NOT NULL,
 expense_id TEXT NOT NULL CHECK(length(expense_id)>0),
 PRIMARY KEY(spreadsheet_id,expense_id),
 FOREIGN KEY(spreadsheet_id) REFERENCES continuous_daily_cutovers(spreadsheet_id)
);
CREATE TRIGGER IF NOT EXISTS continuous_daily_cutover_prepared BEFORE INSERT ON continuous_daily_cutovers
WHEN NEW.state<>'PREPARED' OR NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.operation_token=NEW.claim_token AND c.state='HELD')
 OR NOT EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=NEW.source_revision)
BEGIN SELECT RAISE(ABORT,'continuous daily cutover requires held claim and source revision'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_cutover_no_delete BEFORE DELETE ON continuous_daily_cutovers
BEGIN SELECT RAISE(ABORT,'continuous daily cutover retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_cutover_no_replace BEFORE INSERT ON continuous_daily_cutovers
WHEN EXISTS(SELECT 1 FROM continuous_daily_cutovers c WHERE c.spreadsheet_id=NEW.spreadsheet_id OR c.rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'continuous daily cutover already exists'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_cutover_transition BEFORE UPDATE ON continuous_daily_cutovers
WHEN OLD.rowid IS NOT NEW.rowid OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.legacy_sheet_id IS NOT NEW.legacy_sheet_id OR OLD.legacy_sheet_name IS NOT NEW.legacy_sheet_name
 OR OLD.continuous_sheet_id IS NOT NEW.continuous_sheet_id OR OLD.continuous_sheet_name IS NOT NEW.continuous_sheet_name
 OR OLD.raw_sheet_id IS NOT NEW.raw_sheet_id OR OLD.raw_sheet_name IS NOT NEW.raw_sheet_name OR OLD.detail_sheet_id IS NOT NEW.detail_sheet_id OR OLD.detail_sheet_name IS NOT NEW.detail_sheet_name
 OR OLD.claim_token IS NOT NEW.claim_token OR OLD.source_revision IS NOT NEW.source_revision OR OLD.prepared_at IS NOT NEW.prepared_at
 OR OLD.state<>'PREPARED' OR NEW.state<>'ACTIVE' OR NEW.activated_at IS NULL
 OR NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.operation_token=NEW.claim_token AND c.state='HELD')
 OR NOT EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=NEW.source_revision)
 OR EXISTS(SELECT 1 FROM expense_events e WHERE e.status<>'CANCELLED' AND NOT EXISTS(SELECT 1 FROM continuous_daily_pre_cutover_expenses p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.expense_id=e.expense_id))
 OR EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.state<>'VERIFIED')
 OR EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.state<>'VERIFIED')
 OR (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=NEW.spreadsheet_id AND a.stage IN ('VIEWS','DAILY_J','REPORTS') AND a.state='VERIFIED')<>3
 OR (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('continuous_report_attempt_insert','continuous_report_attempt_transition','continuous_report_attempt_no_delete','continuous_report_attempt_no_replace'))<>4
BEGIN SELECT RAISE(ABORT,'continuous daily cutover activation rejected'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_snapshot_prepared BEFORE INSERT ON continuous_daily_pre_cutover_expenses
WHEN NOT EXISTS(SELECT 1 FROM continuous_daily_cutovers c WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.state='PREPARED')
 OR NOT EXISTS(SELECT 1 FROM expense_events e WHERE e.expense_id=NEW.expense_id AND e.status<>'CANCELLED')
BEGIN SELECT RAISE(ABORT,'continuous daily snapshot insert rejected'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_snapshot_no_delete BEFORE DELETE ON continuous_daily_pre_cutover_expenses
BEGIN SELECT RAISE(ABORT,'continuous daily snapshot retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_snapshot_no_update BEFORE UPDATE ON continuous_daily_pre_cutover_expenses
BEGIN SELECT RAISE(ABORT,'continuous daily snapshot immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_snapshot_no_replace BEFORE INSERT ON continuous_daily_pre_cutover_expenses
WHEN EXISTS(SELECT 1 FROM continuous_daily_pre_cutover_expenses p WHERE p.rowid=NEW.rowid OR (p.spreadsheet_id=NEW.spreadsheet_id AND p.expense_id=NEW.expense_id))
BEGIN SELECT RAISE(ABORT,'continuous daily snapshot already exists'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_record_post_cutover AFTER INSERT ON expense_events
BEGIN INSERT INTO continuous_daily_post_cutover_expenses(spreadsheet_id,expense_id) SELECT spreadsheet_id,NEW.expense_id FROM continuous_daily_cutovers WHERE state='ACTIVE'; END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_post_no_delete BEFORE DELETE ON continuous_daily_post_cutover_expenses
BEGIN SELECT RAISE(ABORT,'continuous daily post-cutover proof retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_post_no_update BEFORE UPDATE ON continuous_daily_post_cutover_expenses
BEGIN SELECT RAISE(ABORT,'continuous daily post-cutover proof immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_post_no_replace BEFORE INSERT ON continuous_daily_post_cutover_expenses
WHEN EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses p WHERE p.rowid=NEW.rowid OR (p.spreadsheet_id=NEW.spreadsheet_id AND p.expense_id=NEW.expense_id))
BEGIN SELECT RAISE(ABORT,'continuous daily post-cutover proof already exists'); END;
