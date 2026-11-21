-- Display-only incident journal. It never updates expense_events or a sync job.
-- Deploy only after a private baseline snapshot is backed up and verified.
CREATE TABLE IF NOT EXISTS monthly_report_runs (
 run_id TEXT PRIMARY KEY CHECK(length(run_id)=32),
 spreadsheet_id TEXT NOT NULL,
 sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
 sheet_name TEXT NOT NULL CHECK(sheet_name='รายวันต่อเนื่อง_แบบร่าง'),
 period TEXT NOT NULL CHECK(length(period)=7 AND substr(period,5,1)='-'),
 base_rows INTEGER NOT NULL CHECK(base_rows>=5 AND base_rows<=4998),
 base_columns INTEGER NOT NULL CHECK(base_columns>=29 AND base_columns<=100),
 base_digest TEXT NOT NULL CHECK(length(base_digest)=64),
 incident_fingerprint TEXT NOT NULL CHECK(length(incident_fingerprint)=64),
 worker_hash TEXT NOT NULL CHECK(length(worker_hash)=64),
 state TEXT NOT NULL CHECK(state IN ('OPEN','REVIEW','CLOSED')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS monthly_report_one_open_run ON monthly_report_runs(spreadsheet_id) WHERE state IN ('OPEN','REVIEW');
CREATE TRIGGER IF NOT EXISTS monthly_report_run_insert BEFORE INSERT ON monthly_report_runs
WHEN NEW.state<>'OPEN' OR EXISTS(SELECT 1 FROM monthly_report_runs WHERE run_id=NEW.run_id OR (spreadsheet_id=NEW.spreadsheet_id AND state IN ('OPEN','REVIEW')))
BEGIN SELECT RAISE(ABORT,'monthly report run rejected'); END;
CREATE TRIGGER IF NOT EXISTS monthly_report_run_transition BEFORE UPDATE ON monthly_report_runs
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.sheet_id IS NOT OLD.sheet_id OR NEW.sheet_name IS NOT OLD.sheet_name OR NEW.period IS NOT OLD.period OR NEW.base_rows IS NOT OLD.base_rows OR NEW.base_columns IS NOT OLD.base_columns OR NEW.base_digest IS NOT OLD.base_digest OR NEW.incident_fingerprint IS NOT OLD.incident_fingerprint OR NEW.worker_hash IS NOT OLD.worker_hash OR NEW.created_at IS NOT OLD.created_at OR NOT(OLD.state='OPEN' AND NEW.state IN ('REVIEW','CLOSED')) OR (NEW.state='CLOSED' AND EXISTS(SELECT 1 FROM monthly_report_intents i WHERE i.run_id=OLD.run_id AND i.state<>'VERIFIED'))
BEGIN SELECT RAISE(ABORT,'monthly report run transition rejected'); END;
CREATE TRIGGER IF NOT EXISTS monthly_report_run_no_delete BEFORE DELETE ON monthly_report_runs BEGIN SELECT RAISE(ABORT,'monthly report run retained'); END;
CREATE TRIGGER IF NOT EXISTS monthly_report_run_no_replace BEFORE INSERT ON monthly_report_runs WHEN EXISTS(SELECT 1 FROM monthly_report_runs WHERE run_id=NEW.run_id) BEGIN SELECT RAISE(ABORT,'monthly report run retained'); END;

CREATE TABLE IF NOT EXISTS monthly_report_intents (
 operation_id TEXT PRIMARY KEY CHECK(length(operation_id)=32),
 run_id TEXT NOT NULL REFERENCES monthly_report_runs(run_id),
 expense_id TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(source_version>0),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
 marker TEXT NOT NULL UNIQUE CHECK(length(marker)=37 AND substr(marker,1,5)='MRP1_'),
 before_rows INTEGER NOT NULL CHECK(before_rows>=5 AND before_rows<=4998),
 target_row INTEGER NOT NULL CHECK(target_row=before_rows+1),
 state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','RECEIPT_IN_FLIGHT','VERIFIED','REVIEW')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(run_id,expense_id,source_version)
);
-- An ambiguous provider request holds further dispatches. Bad input detected
-- before intent does not enter this index and can be skipped independently.
CREATE UNIQUE INDEX IF NOT EXISTS monthly_report_one_uncertain ON monthly_report_intents((1)) WHERE state IN ('IN_FLIGHT','RECEIPT_IN_FLIGHT','REVIEW');
CREATE TRIGGER IF NOT EXISTS monthly_report_intent_insert BEFORE INSERT ON monthly_report_intents
WHEN NEW.state<>'IN_FLIGHT' OR NOT EXISTS(SELECT 1 FROM monthly_report_runs r JOIN expense_events e ON e.expense_id=NEW.expense_id AND e.version=NEW.source_version AND e.status='CONFIRMED' AND substr(e.transaction_date,1,7)=r.period WHERE r.run_id=NEW.run_id AND r.state='OPEN' AND NEW.before_rows=r.base_rows+2*(SELECT count(*) FROM monthly_report_intents i WHERE i.run_id=r.run_id AND i.state='VERIFIED')) OR EXISTS(SELECT 1 FROM monthly_report_intents WHERE state IN ('IN_FLIGHT','RECEIPT_IN_FLIGHT','REVIEW'))
BEGIN SELECT RAISE(ABORT,'monthly report intent rejected'); END;
CREATE TRIGGER IF NOT EXISTS monthly_report_intent_transition BEFORE UPDATE ON monthly_report_intents
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.run_id IS NOT OLD.run_id OR NEW.expense_id IS NOT OLD.expense_id OR NEW.source_version IS NOT OLD.source_version OR NEW.source_digest IS NOT OLD.source_digest OR NEW.marker IS NOT OLD.marker OR NEW.before_rows IS NOT OLD.before_rows OR NEW.target_row IS NOT OLD.target_row OR NEW.created_at IS NOT OLD.created_at OR NOT(OLD.state='IN_FLIGHT' AND NEW.state IN ('RECEIPT_IN_FLIGHT','REVIEW') OR OLD.state='RECEIPT_IN_FLIGHT' AND NEW.state IN ('VERIFIED','REVIEW')) OR (NEW.state='VERIFIED' AND NOT EXISTS(SELECT 1 FROM monthly_report_receipts p WHERE p.operation_id=OLD.operation_id AND p.run_id=OLD.run_id AND p.marker=OLD.marker AND p.target_row=OLD.target_row))
BEGIN SELECT RAISE(ABORT,'monthly report intent transition rejected'); END;
CREATE TRIGGER IF NOT EXISTS monthly_report_intent_no_delete BEFORE DELETE ON monthly_report_intents BEGIN SELECT RAISE(ABORT,'monthly report intent retained'); END;
CREATE TRIGGER IF NOT EXISTS monthly_report_intent_no_replace BEFORE INSERT ON monthly_report_intents WHEN EXISTS(SELECT 1 FROM monthly_report_intents WHERE operation_id=NEW.operation_id OR marker=NEW.marker OR (run_id=NEW.run_id AND expense_id=NEW.expense_id AND source_version=NEW.source_version)) BEGIN SELECT RAISE(ABORT,'monthly report intent retained'); END;

CREATE TABLE IF NOT EXISTS monthly_report_receipts (
 operation_id TEXT PRIMARY KEY REFERENCES monthly_report_intents(operation_id),
 run_id TEXT NOT NULL REFERENCES monthly_report_runs(run_id),
 marker TEXT NOT NULL UNIQUE,
 target_row INTEGER NOT NULL,
 formula_digest TEXT NOT NULL CHECK(length(formula_digest)=64),
 effective_digest TEXT NOT NULL CHECK(length(effective_digest)=64),
 notes_digest TEXT NOT NULL CHECK(length(notes_digest)=64),
 format_digest TEXT NOT NULL CHECK(length(format_digest)=64),
 validation_digest TEXT NOT NULL CHECK(length(validation_digest)=64),
 extras_digest TEXT NOT NULL CHECK(length(extras_digest)=64),
 spare_formula_digest TEXT NOT NULL CHECK(length(spare_formula_digest)=64),
 spare_effective_digest TEXT NOT NULL CHECK(length(spare_effective_digest)=64),
 spare_notes_digest TEXT NOT NULL CHECK(length(spare_notes_digest)=64),
 spare_format_digest TEXT NOT NULL CHECK(length(spare_format_digest)=64),
 spare_validation_digest TEXT NOT NULL CHECK(length(spare_validation_digest)=64),
 spare_extras_digest TEXT NOT NULL CHECK(length(spare_extras_digest)=64),
 created_at TEXT NOT NULL,
 UNIQUE(run_id,target_row)
);
CREATE TRIGGER IF NOT EXISTS monthly_report_receipt_insert BEFORE INSERT ON monthly_report_receipts
WHEN NOT EXISTS(SELECT 1 FROM monthly_report_intents i JOIN monthly_report_runs r ON r.run_id=i.run_id JOIN expense_events e ON e.expense_id=i.expense_id AND e.version=i.source_version AND e.status='CONFIRMED' AND substr(e.transaction_date,1,7)=r.period WHERE i.operation_id=NEW.operation_id AND i.run_id=NEW.run_id AND i.marker=NEW.marker AND i.target_row=NEW.target_row AND i.state='RECEIPT_IN_FLIGHT' AND r.state='OPEN')
BEGIN SELECT RAISE(ABORT,'monthly report receipt rejected'); END;
CREATE TRIGGER IF NOT EXISTS monthly_report_receipt_no_update BEFORE UPDATE ON monthly_report_receipts BEGIN SELECT RAISE(ABORT,'monthly report receipt retained'); END;
CREATE TRIGGER IF NOT EXISTS monthly_report_receipt_no_delete BEFORE DELETE ON monthly_report_receipts BEGIN SELECT RAISE(ABORT,'monthly report receipt retained'); END;
CREATE TRIGGER IF NOT EXISTS monthly_report_receipt_no_replace BEFORE INSERT ON monthly_report_receipts WHEN EXISTS(SELECT 1 FROM monthly_report_receipts WHERE operation_id=NEW.operation_id OR marker=NEW.marker OR (run_id=NEW.run_id AND target_row=NEW.target_row)) BEGIN SELECT RAISE(ABORT,'monthly report receipt retained'); END;
