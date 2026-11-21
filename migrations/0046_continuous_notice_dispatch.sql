-- Durable one-phase dispatches. RUNNING is never stolen on a timeout.
CREATE TABLE IF NOT EXISTS continuous_notice_dispatches (
 dispatch_id TEXT PRIMARY KEY,
 spreadsheet_id TEXT NOT NULL,
 operation_token TEXT NOT NULL,
 expense_id TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(source_version>0),
 sequence INTEGER NOT NULL CHECK(sequence>=0),
 safe_retry INTEGER NOT NULL CHECK(safe_retry BETWEEN 0 AND 2),
 state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','DONE','HELD')),
 outcome TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(spreadsheet_id,operation_token,sequence),
 CHECK((state IN ('PENDING','RUNNING') AND outcome IS NULL) OR (state IN ('DONE','HELD') AND outcome IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS continuous_notice_one_live_dispatch ON continuous_notice_dispatches(spreadsheet_id,operation_token) WHERE state IN ('PENDING','RUNNING');
CREATE TRIGGER IF NOT EXISTS continuous_notice_dispatch_insert BEFORE INSERT ON continuous_notice_dispatches
WHEN NEW.state<>'PENDING' OR NEW.outcome IS NOT NULL OR NOT EXISTS(SELECT 1 FROM continuous_normal_notice_handoffs h JOIN stable_workbook_claims c ON c.spreadsheet_id=h.spreadsheet_id AND c.operation_token=h.operation_token WHERE h.spreadsheet_id=NEW.spreadsheet_id AND h.operation_token=NEW.operation_token AND h.expense_id=NEW.expense_id AND h.source_version=NEW.source_version AND c.state='HELD' AND c.phase='END_NOTICE_PENDING') OR (NEW.sequence=0 AND NEW.safe_retry<>0) OR (NEW.sequence>0 AND NOT EXISTS(SELECT 1 FROM continuous_notice_dispatches p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.operation_token=NEW.operation_token AND p.expense_id=NEW.expense_id AND p.source_version=NEW.source_version AND p.sequence=NEW.sequence-1 AND p.state='DONE' AND ((p.outcome='IN_PROGRESS' AND NEW.safe_retry=0) OR (p.outcome='SAFE_RETRY' AND NEW.safe_retry=p.safe_retry+1))))
BEGIN SELECT RAISE(ABORT,'notice dispatch requires exact pending phase'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_dispatch_transition BEFORE UPDATE ON continuous_notice_dispatches
WHEN NEW.dispatch_id IS NOT OLD.dispatch_id OR NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.operation_token IS NOT OLD.operation_token OR NEW.expense_id IS NOT OLD.expense_id OR NEW.source_version IS NOT OLD.source_version OR NEW.sequence IS NOT OLD.sequence OR NEW.safe_retry IS NOT OLD.safe_retry OR NEW.created_at IS NOT OLD.created_at OR NOT ((OLD.state='PENDING' AND NEW.state='RUNNING' AND NEW.outcome IS NULL) OR (OLD.state='RUNNING' AND NEW.state='DONE' AND NEW.outcome IN ('IN_PROGRESS','SAFE_RETRY','RESUMED','ALREADY_COMPLETED')) OR (OLD.state='RUNNING' AND NEW.state='HELD' AND NEW.outcome IN ('OUTCOME_UNKNOWN','RETRY_EXHAUSTED','RUNNER_CRASH')))
BEGIN SELECT RAISE(ABORT,'notice dispatch transition invalid'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_dispatch_no_delete BEFORE DELETE ON continuous_notice_dispatches BEGIN SELECT RAISE(ABORT,'notice dispatch retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_dispatch_no_replace BEFORE INSERT ON continuous_notice_dispatches WHEN EXISTS(SELECT 1 FROM continuous_notice_dispatches d WHERE d.dispatch_id=NEW.dispatch_id OR d.rowid=NEW.rowid OR (d.spreadsheet_id=NEW.spreadsheet_id AND d.operation_token=NEW.operation_token AND d.sequence=NEW.sequence)) BEGIN SELECT RAISE(ABORT,'notice dispatch already exists'); END;
