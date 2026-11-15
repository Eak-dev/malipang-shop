-- One dedicated operator-owned claim, or the specifically fingerprinted
-- prewrite REVIEW after separately verified runtime/provider reconciliation.
-- A missing acknowledgement retains the intent and blocks automatic retry.
CREATE TABLE IF NOT EXISTS continuous_cutover_operator (
 spreadsheet_id TEXT PRIMARY KEY,
 operation_token TEXT NOT NULL UNIQUE,
 origin TEXT NOT NULL CHECK(origin IN ('NEW','PREWRITE_REVIEW')),
 original_fingerprint TEXT CHECK(original_fingerprint IS NULL OR length(original_fingerprint)=64 AND original_fingerprint NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('STARTING','HELD','VIEWS','DAILY_J','REPORTS','ACTIVATING','RELEASING','REVIEW','COMPLETE')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK((origin='NEW' AND original_fingerprint IS NULL) OR (origin='PREWRITE_REVIEW' AND original_fingerprint IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS continuous_operator_insert BEFORE INSERT ON continuous_cutover_operator
WHEN NEW.state<>'STARTING' OR NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.operation_token=NEW.operation_token AND (
 NEW.origin='NEW' AND c.state='HELD' AND c.notice_stamp IS NULL AND c.notice_identity IS NULL OR
 NEW.origin='PREWRITE_REVIEW' AND c.state='REVIEW' AND c.phase='OPERATION' AND c.review_reason='STABLE_DAILY_REVIEW' AND c.notice_stamp IS NOT NULL AND c.notice_identity IS NOT NULL
 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.operation_token=c.operation_token)
 AND NOT EXISTS(SELECT 1 FROM stable_recovery_operations o WHERE o.operation_token=c.operation_token)))
BEGIN SELECT RAISE(ABORT,'continuous operator claim missing'); END;
CREATE TRIGGER IF NOT EXISTS continuous_operator_update BEFORE UPDATE ON continuous_cutover_operator
WHEN NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.operation_token IS NOT OLD.operation_token OR NEW.origin IS NOT OLD.origin OR NEW.original_fingerprint IS NOT OLD.original_fingerprint OR NEW.created_at IS NOT OLD.created_at
 OR NOT (OLD.state='STARTING' AND NEW.state IN ('HELD','REVIEW') OR OLD.state='HELD' AND NEW.state IN ('VIEWS','DAILY_J','REPORTS','ACTIVATING','RELEASING','REVIEW') OR OLD.state IN ('VIEWS','DAILY_J','REPORTS','ACTIVATING') AND NEW.state IN ('HELD','REVIEW') OR OLD.state='RELEASING' AND NEW.state IN ('COMPLETE','REVIEW'))
BEGIN SELECT RAISE(ABORT,'continuous operator transition rejected'); END;
CREATE TRIGGER IF NOT EXISTS continuous_operator_no_delete BEFORE DELETE ON continuous_cutover_operator
BEGIN SELECT RAISE(ABORT,'continuous operator history retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_operator_no_replace BEFORE INSERT ON continuous_cutover_operator
WHEN EXISTS(SELECT 1 FROM continuous_cutover_operator o WHERE o.spreadsheet_id=NEW.spreadsheet_id OR o.operation_token=NEW.operation_token OR o.rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'continuous operator already exists'); END;

-- One exact compare-and-swap for the two visible notice cells. A lost
-- acknowledgement remains IN_FLIGHT and cannot be automatically retried.
CREATE TABLE IF NOT EXISTS continuous_cutover_notice_release (
 spreadsheet_id TEXT PRIMARY KEY,
 operation_token TEXT NOT NULL,
 sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
 paused_stamp TEXT NOT NULL,
 ready_stamp TEXT NOT NULL,
 ready_status TEXT NOT NULL CHECK(ready_status IN ('พร้อมแก้ไข','พร้อมแก้ไข • มีรายการรอตรวจ')),
 style_digest TEXT NOT NULL CHECK(length(style_digest)=64 AND style_digest NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','VERIFIED')),
 created_at TEXT NOT NULL,
 verified_at TEXT,
 CHECK((state='IN_FLIGHT' AND verified_at IS NULL) OR (state='VERIFIED' AND verified_at IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS continuous_notice_insert BEFORE INSERT ON continuous_cutover_notice_release
WHEN NEW.state<>'IN_FLIGHT' OR NOT EXISTS(SELECT 1 FROM continuous_cutover_operator o JOIN stable_workbook_claims c ON c.spreadsheet_id=o.spreadsheet_id AND c.operation_token=o.operation_token WHERE o.spreadsheet_id=NEW.spreadsheet_id AND o.operation_token=NEW.operation_token AND o.state='RELEASING' AND c.state='HELD' AND c.notice_stamp=NEW.paused_stamp)
BEGIN SELECT RAISE(ABORT,'continuous notice intent rejected'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_transition BEFORE UPDATE ON continuous_cutover_notice_release
WHEN OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.operation_token IS NOT NEW.operation_token OR OLD.sheet_id IS NOT NEW.sheet_id OR OLD.paused_stamp IS NOT NEW.paused_stamp OR OLD.ready_stamp IS NOT NEW.ready_stamp OR OLD.ready_status IS NOT NEW.ready_status OR OLD.style_digest IS NOT NEW.style_digest OR OLD.created_at IS NOT NEW.created_at OR OLD.state<>'IN_FLIGHT' OR NEW.state<>'VERIFIED' OR NEW.verified_at IS NULL
 OR NOT EXISTS(SELECT 1 FROM continuous_cutover_operator o JOIN stable_workbook_claims c ON c.spreadsheet_id=o.spreadsheet_id AND c.operation_token=o.operation_token WHERE o.spreadsheet_id=NEW.spreadsheet_id AND o.operation_token=NEW.operation_token AND o.state='RELEASING' AND c.state='HELD')
BEGIN SELECT RAISE(ABORT,'continuous notice transition rejected'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_no_delete BEFORE DELETE ON continuous_cutover_notice_release
BEGIN SELECT RAISE(ABORT,'continuous notice intent retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_no_replace BEFORE INSERT ON continuous_cutover_notice_release
WHEN EXISTS(SELECT 1 FROM continuous_cutover_notice_release r WHERE r.spreadsheet_id=NEW.spreadsheet_id OR r.rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'continuous notice intent already exists'); END;
