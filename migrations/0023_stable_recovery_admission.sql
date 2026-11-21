-- 0023: Local DEV_OWNED only. No remote migration or production action is authorized.
-- One exact-target recovery epoch per workbook, immutable history across epochs.
CREATE TABLE IF NOT EXISTS stable_recovery_epochs (
  epoch_id TEXT PRIMARY KEY CHECK(length(epoch_id) BETWEEN 8 AND 128),
  spreadsheet_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ARMED','COMPLETE','REVIEW','CLOSED')),
  target_type TEXT NOT NULL CHECK(target_type IN
    ('EXPENSE','PERSONAL_USE','ATTENDANCE_EVENT','DAILY_PAYROLL','WEEKLY_PAYROLL','SHIFT_SCHEDULE','WAGE_HISTORY','OT_REQUEST','SYSTEM_LOG','STAFF_CONFIG_SYNC')),
  target_key TEXT NOT NULL CHECK(length(target_key) BETWEEN 1 AND 256),
  target_version INTEGER NOT NULL CHECK(target_version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(state!='ARMED' OR target_version >= 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS stable_recovery_one_active_epoch
 ON stable_recovery_epochs(spreadsheet_id) WHERE state IN ('ARMED','REVIEW');
CREATE TRIGGER IF NOT EXISTS stable_recovery_epoch_no_delete
 BEFORE DELETE ON stable_recovery_epochs BEGIN SELECT RAISE(ABORT,'recovery epoch retained'); END;
CREATE TRIGGER IF NOT EXISTS stable_recovery_epoch_transition
 BEFORE UPDATE ON stable_recovery_epochs
 WHEN NEW.epoch_id IS NOT OLD.epoch_id
   OR NEW.spreadsheet_id IS NOT OLD.spreadsheet_id
   OR NEW.target_type IS NOT OLD.target_type
   OR NEW.target_key IS NOT OLD.target_key
   OR NEW.target_version IS NOT OLD.target_version
   OR NEW.created_at IS NOT OLD.created_at
   OR NOT ((OLD.state='ARMED' AND NEW.state IN ('COMPLETE','REVIEW'))
         OR (OLD.state IN ('COMPLETE','REVIEW') AND NEW.state='CLOSED'))
 BEGIN SELECT RAISE(ABORT,'recovery epoch immutable or invalid transition'); END;

-- One new operation per verified stage; ambiguous stages retain ADMITTED
-- forever until a separately approved, audited recovery is performed.
CREATE TABLE IF NOT EXISTS stable_recovery_operations (
  operation_token TEXT PRIMARY KEY CHECK(length(operation_token) >= 8),
  epoch_id TEXT NOT NULL REFERENCES stable_recovery_epochs(epoch_id),
  state TEXT NOT NULL CHECK(state IN ('ADMITTED','VERIFIED')),
  admitted_at TEXT NOT NULL,
  verified_at TEXT,
  CHECK((state='ADMITTED' AND verified_at IS NULL) OR
        (state='VERIFIED' AND verified_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS stable_recovery_ops_epoch
 ON stable_recovery_operations(epoch_id,state);
CREATE UNIQUE INDEX IF NOT EXISTS stable_recovery_one_unverified_operation
 ON stable_recovery_operations(epoch_id) WHERE state='ADMITTED';
CREATE TRIGGER IF NOT EXISTS stable_recovery_operation_no_delete
 BEFORE DELETE ON stable_recovery_operations BEGIN SELECT RAISE(ABORT,'recovery admission history retained'); END;
CREATE TRIGGER IF NOT EXISTS stable_recovery_operation_transition
 BEFORE UPDATE ON stable_recovery_operations
 WHEN NEW.operation_token IS NOT OLD.operation_token
   OR NEW.epoch_id IS NOT OLD.epoch_id
   OR NEW.admitted_at IS NOT OLD.admitted_at
   OR OLD.state != 'ADMITTED' OR NEW.state != 'VERIFIED' OR NEW.verified_at IS NULL
 BEGIN SELECT RAISE(ABORT,'recovery operation transition invalid'); END;

-- Shared fixed-window pacing counter for SHEETS projections only.
-- No wall-clock lease permits another write: this is throughput accounting,
-- not a substitute for stable_workbook_claims or operation readback.
CREATE TABLE IF NOT EXISTS stable_sheet_pacing (
  spreadsheet_id TEXT PRIMARY KEY,
  window_minute INTEGER NOT NULL DEFAULT 0 CHECK(window_minute>=0),
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK(reserved_units>=0 AND reserved_units<=60),
  last_admission_ms INTEGER NOT NULL DEFAULT 0 CHECK(last_admission_ms>=0),
  total_admissions INTEGER NOT NULL DEFAULT 0 CHECK(total_admissions>=0)
);

-- Retry pacing is operational bookkeeping, not a business record.
CREATE TABLE IF NOT EXISTS stable_sheet_busy_backoffs (
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL CHECK(attempt_count>=1 AND attempt_count<=7),
  last_busy_ms INTEGER NOT NULL CHECK(last_busy_ms>=0),
  PRIMARY KEY(entity_type,entity_key,entity_version)
);
