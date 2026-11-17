-- One explicitly marked synthetic test per workbook. Never stores receipts,
-- account credentials, or real customer identities.
CREATE TABLE IF NOT EXISTS continuous_canary_operator (
 spreadsheet_id TEXT PRIMARY KEY,
 expense_id TEXT NOT NULL UNIQUE,
 document_id TEXT NOT NULL UNIQUE,
 item_id TEXT NOT NULL UNIQUE,
 line_user_id TEXT NOT NULL,
 transaction_date TEXT NOT NULL,
 trace_id TEXT NOT NULL,
 duplicate_epoch_id TEXT UNIQUE,
 state TEXT NOT NULL CHECK(state IN ('DRAFT','CONFIRMING','CONFIRMED','ARMED_CONFIRM','DUPLICATE_ARMED','DUPLICATE_SEEN','DUPLICATE_VERIFIED','UNDOING','UNDONE','ARMED_UNDO','VERIFIED','ABORTED')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK(state NOT IN ('DUPLICATE_ARMED','DUPLICATE_SEEN','DUPLICATE_VERIFIED','UNDOING','UNDONE','ARMED_UNDO','VERIFIED') OR duplicate_epoch_id IS NOT NULL)
);
CREATE TRIGGER IF NOT EXISTS continuous_canary_no_delete BEFORE DELETE ON continuous_canary_operator BEGIN SELECT RAISE(ABORT,'canary history retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_canary_no_replace BEFORE INSERT ON continuous_canary_operator WHEN NEW.state<>'DRAFT' OR NEW.duplicate_epoch_id IS NOT NULL OR NEW.expense_id NOT GLOB 'exp_canary_*' OR NEW.document_id NOT GLOB 'doc_canary_*' OR NEW.item_id NOT GLOB 'item_canary_*' OR NEW.line_user_id NOT GLOB 'CANARY_NO_LINE_*' OR NEW.trace_id NOT GLOB 'trace_canary_*' OR EXISTS(SELECT 1 FROM continuous_canary_operator WHERE spreadsheet_id=NEW.spreadsheet_id OR expense_id=NEW.expense_id OR document_id=NEW.document_id OR item_id=NEW.item_id) BEGIN SELECT RAISE(ABORT,'canary identity or state invalid'); END;
CREATE TRIGGER IF NOT EXISTS continuous_canary_transition BEFORE UPDATE ON continuous_canary_operator
 WHEN NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.expense_id IS NOT OLD.expense_id OR NEW.document_id IS NOT OLD.document_id OR NEW.item_id IS NOT OLD.item_id OR NEW.line_user_id IS NOT OLD.line_user_id OR NEW.transaction_date IS NOT OLD.transaction_date OR NEW.trace_id IS NOT OLD.trace_id OR NEW.created_at IS NOT OLD.created_at OR (NEW.duplicate_epoch_id IS NOT OLD.duplicate_epoch_id AND NOT (OLD.state='ARMED_CONFIRM' AND NEW.state='DUPLICATE_ARMED' AND OLD.duplicate_epoch_id IS NULL AND length(NEW.duplicate_epoch_id)>=8)) OR NOT ((OLD.state='DRAFT' AND NEW.state='CONFIRMING') OR (OLD.state='CONFIRMING' AND NEW.state IN ('DRAFT','CONFIRMED','ABORTED')) OR (OLD.state='CONFIRMED' AND NEW.state IN ('ARMED_CONFIRM','ABORTED')) OR (OLD.state='ARMED_CONFIRM' AND NEW.state IN ('DUPLICATE_ARMED','ABORTED')) OR (OLD.state='DUPLICATE_ARMED' AND NEW.state IN ('DUPLICATE_SEEN','ABORTED')) OR (OLD.state='DUPLICATE_SEEN' AND NEW.state IN ('DUPLICATE_VERIFIED','ABORTED')) OR (OLD.state='DUPLICATE_VERIFIED' AND NEW.state IN ('UNDOING','ABORTED')) OR (OLD.state='UNDOING' AND NEW.state='UNDONE') OR (OLD.state='UNDONE' AND NEW.state='ARMED_UNDO') OR (OLD.state='ARMED_UNDO' AND NEW.state='VERIFIED'))
 BEGIN SELECT RAISE(ABORT,'invalid canary transition'); END;
