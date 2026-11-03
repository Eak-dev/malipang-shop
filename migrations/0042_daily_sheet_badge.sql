-- Existing, explicitly provisioned named ranges only. No row/column position
-- is persisted. Unknown writes are REVIEW and are never automatically replayed.
CREATE TABLE IF NOT EXISTS daily_sheet_badge_journal (
  spreadsheet_id TEXT NOT NULL,
  sheet_id INTEGER NOT NULL,
  state_range_id TEXT NOT NULL,
  time_range_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('READY','IN_FLIGHT','REVIEW','RESTORED')),
  preimage_json TEXT NOT NULL CHECK(length(preimage_json)<=32768),
  expected_values_json TEXT NOT NULL CHECK(length(expected_values_json)<=1024),
  operation_token TEXT,
  verified_operation_token TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_id),
  UNIQUE(spreadsheet_id),
  UNIQUE(spreadsheet_id,state_range_id),
  UNIQUE(spreadsheet_id,time_range_id),
  CHECK(state_range_id<>time_range_id),
  CHECK((state='IN_FLIGHT' AND operation_token IS NOT NULL) OR (state<>'IN_FLIGHT' AND operation_token IS NULL))
);

-- The window binding is written in the same guarded statement as NOTICE.
ALTER TABLE daily_edit_coordination ADD COLUMN badge_expense_id TEXT;
ALTER TABLE daily_edit_coordination ADD COLUMN badge_source_version INTEGER;
ALTER TABLE daily_edit_coordination ADD COLUMN badge_source_revision INTEGER;
ALTER TABLE daily_edit_coordination ADD COLUMN badge_watermark INTEGER;
ALTER TABLE daily_edit_coordination ADD COLUMN badge_outer_token TEXT;
ALTER TABLE daily_edit_coordination ADD COLUMN badge_sync_lease TEXT;
ALTER TABLE daily_edit_coordination ADD COLUMN badge_generation_lease TEXT;
ALTER TABLE daily_edit_coordination ADD COLUMN badge_notice_seconds INTEGER;

CREATE TABLE IF NOT EXISTS daily_sheet_notice_receipts (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  window_token TEXT NOT NULL,
  badge_operation_token TEXT NOT NULL,
  state_range_id TEXT NOT NULL,
  time_range_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  ready_after TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_name,window_token),
  UNIQUE(spreadsheet_id,badge_operation_token)
);

-- One row is both the consumption record and the write intent. An unknown
-- outcome stays IN_FLIGHT/REVIEW across windows; no timeout releases it.
CREATE TABLE IF NOT EXISTS daily_notice_dispatch_intents (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  window_token TEXT NOT NULL,
  operation_token TEXT NOT NULL UNIQUE,
  badge_operation_token TEXT NOT NULL,
  sheet_id INTEGER NOT NULL,
  state_range_id TEXT NOT NULL,
  time_range_id TEXT NOT NULL,
  preimage_json TEXT NOT NULL,
  expected_values_json TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  cutover_generation TEXT NOT NULL,
  outer_token TEXT NOT NULL,
  sync_lease TEXT NOT NULL,
  generation_lease TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','REVIEW')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_name,window_token)
);

CREATE TRIGGER daily_notice_receipt_no_replace BEFORE INSERT ON daily_sheet_notice_receipts
WHEN EXISTS(SELECT 1 FROM daily_sheet_notice_receipts r WHERE r.rowid=NEW.rowid OR (r.spreadsheet_id=NEW.spreadsheet_id AND ((r.sheet_name=NEW.sheet_name AND r.window_token=NEW.window_token) OR r.badge_operation_token=NEW.badge_operation_token)))
BEGIN SELECT RAISE(ABORT,'daily receipt collision'); END;
CREATE TRIGGER daily_notice_receipt_no_update BEFORE UPDATE ON daily_sheet_notice_receipts
BEGIN SELECT RAISE(ABORT,'daily receipt immutable'); END;
CREATE TRIGGER daily_notice_receipt_no_delete BEFORE DELETE ON daily_sheet_notice_receipts
BEGIN SELECT RAISE(ABORT,'daily receipt retained'); END;

CREATE TRIGGER daily_notice_intent_no_replace BEFORE INSERT ON daily_notice_dispatch_intents
WHEN EXISTS(SELECT 1 FROM daily_notice_dispatch_intents i WHERE i.rowid=NEW.rowid OR i.operation_token=NEW.operation_token OR (i.spreadsheet_id=NEW.spreadsheet_id AND i.sheet_name=NEW.sheet_name AND i.window_token=NEW.window_token))
BEGIN SELECT RAISE(ABORT,'daily intent collision'); END;
CREATE TRIGGER daily_notice_intent_transition BEFORE UPDATE ON daily_notice_dispatch_intents
WHEN NOT (OLD.state='IN_FLIGHT' AND NEW.state='REVIEW') OR OLD.rowid IS NOT NEW.rowid OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR OLD.window_token IS NOT NEW.window_token OR OLD.operation_token IS NOT NEW.operation_token OR OLD.badge_operation_token IS NOT NEW.badge_operation_token OR OLD.sheet_id IS NOT NEW.sheet_id OR OLD.state_range_id IS NOT NEW.state_range_id OR OLD.time_range_id IS NOT NEW.time_range_id OR OLD.preimage_json IS NOT NEW.preimage_json OR OLD.expected_values_json IS NOT NEW.expected_values_json OR OLD.expense_id IS NOT NEW.expense_id OR OLD.source_version IS NOT NEW.source_version OR OLD.source_revision IS NOT NEW.source_revision OR OLD.cutover_generation IS NOT NEW.cutover_generation OR OLD.outer_token IS NOT NEW.outer_token OR OLD.sync_lease IS NOT NEW.sync_lease OR OLD.generation_lease IS NOT NEW.generation_lease
BEGIN SELECT RAISE(ABORT,'daily intent immutable'); END;
CREATE TRIGGER daily_notice_intent_no_delete BEFORE DELETE ON daily_notice_dispatch_intents
BEGIN SELECT RAISE(ABORT,'daily intent retained'); END;

CREATE TRIGGER daily_badge_no_replace BEFORE INSERT ON daily_sheet_badge_journal
WHEN EXISTS(SELECT 1 FROM daily_sheet_badge_journal b WHERE b.rowid=NEW.rowid OR b.spreadsheet_id=NEW.spreadsheet_id)
BEGIN SELECT RAISE(ABORT,'daily badge collision'); END;
CREATE TRIGGER daily_badge_transition BEFORE UPDATE ON daily_sheet_badge_journal
WHEN OLD.rowid IS NOT NEW.rowid OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.sheet_id IS NOT NEW.sheet_id OR OLD.state_range_id IS NOT NEW.state_range_id OR OLD.time_range_id IS NOT NEW.time_range_id OR OLD.preimage_json IS NOT NEW.preimage_json OR NOT (
  (OLD.state='READY' AND NEW.state='IN_FLIGHT' AND NEW.operation_token IS NOT NULL AND NEW.verified_operation_token IS NULL AND OLD.expected_values_json IS NEW.expected_values_json) OR
  (OLD.state='READY' AND NEW.state='REVIEW' AND NEW.operation_token IS NULL AND OLD.verified_operation_token IS NEW.verified_operation_token AND OLD.expected_values_json IS NEW.expected_values_json) OR
  (OLD.state='IN_FLIGHT' AND NEW.state='REVIEW' AND NEW.operation_token IS NULL AND OLD.verified_operation_token IS NEW.verified_operation_token AND OLD.expected_values_json IS NEW.expected_values_json) OR
  (OLD.state='IN_FLIGHT' AND NEW.state IN ('READY','RESTORED') AND NEW.operation_token IS NULL AND NEW.verified_operation_token IS OLD.operation_token)
)
BEGIN SELECT RAISE(ABORT,'daily badge transition invalid'); END;
CREATE TRIGGER daily_badge_no_delete BEFORE DELETE ON daily_sheet_badge_journal
BEGIN SELECT RAISE(ABORT,'daily badge retained'); END;

CREATE TRIGGER daily_coordination_no_replace BEFORE INSERT ON daily_edit_coordination
WHEN EXISTS(SELECT 1 FROM daily_edit_coordination w WHERE w.rowid=NEW.rowid OR (w.spreadsheet_id=NEW.spreadsheet_id AND w.sheet_name=NEW.sheet_name))
BEGIN SELECT RAISE(ABORT,'daily coordination collision'); END;
CREATE TRIGGER daily_coordination_review_terminal BEFORE UPDATE ON daily_edit_coordination
WHEN OLD.state<>NEW.state AND NOT ((OLD.state='AVAILABLE' AND NEW.state IN ('NOTICE','REVIEW')) OR (OLD.state IN ('NOTICE','SYNCING') AND NEW.state='REVIEW'))
BEGIN SELECT RAISE(ABORT,'daily coordination review'); END;
CREATE TRIGGER daily_coordination_window_immutable BEFORE UPDATE ON daily_edit_coordination
WHEN OLD.rowid IS NOT NEW.rowid OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR (OLD.state<>'AVAILABLE' AND (OLD.window_token IS NOT NEW.window_token OR OLD.cutover_generation IS NOT NEW.cutover_generation OR OLD.notice_until IS NOT NEW.notice_until OR OLD.badge_expense_id IS NOT NEW.badge_expense_id OR OLD.badge_source_version IS NOT NEW.badge_source_version OR OLD.badge_source_revision IS NOT NEW.badge_source_revision OR OLD.badge_watermark IS NOT NEW.badge_watermark OR OLD.badge_outer_token IS NOT NEW.badge_outer_token OR OLD.badge_sync_lease IS NOT NEW.badge_sync_lease OR OLD.badge_generation_lease IS NOT NEW.badge_generation_lease OR OLD.badge_notice_seconds IS NOT NEW.badge_notice_seconds OR julianday(NEW.deadline) IS NULL OR julianday(NEW.deadline)>julianday(OLD.deadline)))
BEGIN SELECT RAISE(ABORT,'daily coordination window immutable'); END;
CREATE TRIGGER daily_coordination_no_delete BEFORE DELETE ON daily_edit_coordination
BEGIN SELECT RAISE(ABORT,'daily coordination retained'); END;
