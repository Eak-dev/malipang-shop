-- Each synthetic confirmation reserves its exact document snapshot before
-- invoking the real business transaction. Unknown acknowledgements cannot
-- be retried until the old snapshot is atomically invalidated.
CREATE TABLE IF NOT EXISTS continuous_canary_confirm_attempts (
 attempt_id TEXT PRIMARY KEY,
 spreadsheet_id TEXT NOT NULL,
 expense_id TEXT NOT NULL,
 document_id TEXT NOT NULL,
 snapshot_updated_at TEXT NOT NULL,
 snapshot_normalized_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('STARTED','CONFIRMED','INVALIDATED')),
 recovered_updated_at TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(spreadsheet_id) REFERENCES continuous_canary_operator(spreadsheet_id),
 CHECK((state='INVALIDATED' AND recovered_updated_at IS NOT NULL AND recovered_updated_at<>snapshot_updated_at) OR (state<>'INVALIDATED' AND recovered_updated_at IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS continuous_canary_one_open_confirm_attempt ON continuous_canary_confirm_attempts(spreadsheet_id) WHERE state='STARTED';
CREATE TRIGGER IF NOT EXISTS continuous_canary_confirm_insert BEFORE INSERT ON continuous_canary_confirm_attempts
WHEN NEW.state<>'STARTED' OR NEW.recovered_updated_at IS NOT NULL OR NOT EXISTS(SELECT 1 FROM continuous_canary_operator c JOIN expense_events e ON e.expense_id=c.expense_id JOIN expense_documents d ON d.document_id=c.document_id AND d.expense_id=e.expense_id WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.expense_id=NEW.expense_id AND c.document_id=NEW.document_id AND c.state='DRAFT' AND e.status='WAITING_CONFIRM' AND e.version=1 AND d.status='WAITING_CONFIRM' AND d.updated_at=NEW.snapshot_updated_at AND d.normalized_json=NEW.snapshot_normalized_json)
BEGIN SELECT RAISE(ABORT,'invalid canary confirm attempt'); END;
CREATE TRIGGER IF NOT EXISTS continuous_canary_confirm_no_delete BEFORE DELETE ON continuous_canary_confirm_attempts BEGIN SELECT RAISE(ABORT,'canary confirm retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_canary_confirm_no_replace BEFORE INSERT ON continuous_canary_confirm_attempts WHEN EXISTS(SELECT 1 FROM continuous_canary_confirm_attempts a WHERE a.attempt_id=NEW.attempt_id OR a.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'canary confirm collision'); END;
CREATE TRIGGER IF NOT EXISTS continuous_canary_confirm_transition BEFORE UPDATE ON continuous_canary_confirm_attempts
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.expense_id IS NOT OLD.expense_id OR NEW.document_id IS NOT OLD.document_id OR NEW.snapshot_updated_at IS NOT OLD.snapshot_updated_at OR NEW.snapshot_normalized_json IS NOT OLD.snapshot_normalized_json OR NEW.created_at IS NOT OLD.created_at OR OLD.state<>'STARTED' OR NEW.state NOT IN ('CONFIRMED','INVALIDATED')
BEGIN SELECT RAISE(ABORT,'invalid canary confirm transition'); END;
CREATE TRIGGER IF NOT EXISTS continuous_canary_confirm_recovery_fenced BEFORE UPDATE OF state ON continuous_canary_operator
WHEN OLD.state='CONFIRMING' AND NEW.state='DRAFT' AND (EXISTS(SELECT 1 FROM continuous_canary_confirm_attempts a WHERE a.spreadsheet_id=OLD.spreadsheet_id AND a.expense_id=OLD.expense_id AND a.state='STARTED') OR NOT EXISTS(SELECT 1 FROM continuous_canary_confirm_attempts a JOIN expense_documents d ON d.document_id=a.document_id AND d.expense_id=a.expense_id WHERE a.spreadsheet_id=OLD.spreadsheet_id AND a.expense_id=OLD.expense_id AND a.state='INVALIDATED' AND d.status='WAITING_CONFIRM' AND d.updated_at=a.recovered_updated_at AND d.updated_at<>a.snapshot_updated_at))
BEGIN SELECT RAISE(ABORT,'canary confirmation not invalidated'); END;
