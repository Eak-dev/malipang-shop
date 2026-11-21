-- Additive journal for exact-cell report migrations. It records hashes, not
-- report formulas or business payloads. An uncertain dispatch is never retried.
CREATE TABLE IF NOT EXISTS continuous_report_cutover_attempts (
 spreadsheet_id TEXT NOT NULL,
 stage TEXT NOT NULL CHECK(stage IN ('VIEWS','REPORTS','DAILY_J')),
 operation_token TEXT NOT NULL CHECK(length(operation_token)>0),
 manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
 manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json) AND json_type(manifest_json)='array'),
 cell_count INTEGER NOT NULL CHECK(typeof(cell_count)='integer' AND cell_count BETWEEN 1 AND 1000),
 state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','VERIFIED','REVIEW')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(spreadsheet_id,stage)
);
CREATE TRIGGER IF NOT EXISTS continuous_report_attempt_insert BEFORE INSERT ON continuous_report_cutover_attempts
WHEN NEW.state<>'IN_FLIGHT' OR json_array_length(NEW.manifest_json)<>NEW.cell_count
 OR NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.operation_token=NEW.operation_token AND c.state='HELD')
 OR (NEW.stage='REPORTS' AND NOT EXISTS(SELECT 1 FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=NEW.spreadsheet_id AND a.stage='DAILY_J' AND a.state='VERIFIED'))
 OR (NEW.stage='REPORTS' AND NOT EXISTS(SELECT 1 FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=NEW.spreadsheet_id AND a.stage='VIEWS' AND a.state='VERIFIED'))
 OR EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.state<>'VERIFIED')
 OR EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.state<>'VERIFIED')
 OR EXISTS(SELECT 1 FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=NEW.spreadsheet_id AND a.state<>'VERIFIED')
BEGIN SELECT RAISE(ABORT,'report cutover admission rejected'); END;
CREATE TRIGGER IF NOT EXISTS continuous_report_attempt_transition BEFORE UPDATE ON continuous_report_cutover_attempts
WHEN OLD.rowid IS NOT NEW.rowid OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.stage IS NOT NEW.stage
 OR OLD.operation_token IS NOT NEW.operation_token OR OLD.manifest_digest IS NOT NEW.manifest_digest
 OR OLD.manifest_json IS NOT NEW.manifest_json OR OLD.cell_count IS NOT NEW.cell_count OR OLD.created_at IS NOT NEW.created_at
 OR OLD.state<>'IN_FLIGHT' OR NEW.state NOT IN ('VERIFIED','REVIEW')
BEGIN SELECT RAISE(ABORT,'report cutover transition rejected'); END;
CREATE TRIGGER IF NOT EXISTS continuous_report_attempt_no_delete BEFORE DELETE ON continuous_report_cutover_attempts
BEGIN SELECT RAISE(ABORT,'report cutover history retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_report_attempt_no_replace BEFORE INSERT ON continuous_report_cutover_attempts
WHEN EXISTS(SELECT 1 FROM continuous_report_cutover_attempts a WHERE a.rowid=NEW.rowid OR (a.spreadsheet_id=NEW.spreadsheet_id AND a.stage=NEW.stage))
BEGIN SELECT RAISE(ABORT,'report cutover attempt already exists'); END;
