PRAGMA foreign_keys = ON;

ALTER TABLE employee_shift_days
ADD COLUMN created_action_id TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS shift_schedule_audit(
  audit_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  work_date TEXT NOT NULL,
  previous_status TEXT CHECK(previous_status IS NULL OR previous_status IN ('EXPECTED','DAY_OFF','CANCELLED')),
  new_status TEXT NOT NULL CHECK(new_status IN ('EXPECTED','DAY_OFF','CANCELLED')),
  previous_scheduled_in TEXT,
  previous_scheduled_out TEXT,
  new_scheduled_in TEXT NOT NULL,
  new_scheduled_out TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL CHECK(action IN ('DEFAULT_GENERATION','SHEET_IMPORT','OWNER_OVERRIDE')),
  created_at TEXT NOT NULL,
  FOREIGN KEY(employee_id,work_date) REFERENCES employee_shift_days(employee_id,work_date)
);

CREATE INDEX IF NOT EXISTS idx_shift_schedule_audit_lookup
ON shift_schedule_audit(employee_id,work_date,created_at);

CREATE TRIGGER IF NOT EXISTS shift_schedule_audit_no_update
BEFORE UPDATE ON shift_schedule_audit
BEGIN
  SELECT RAISE(ABORT,'shift_schedule_audit is append-only');
END;

CREATE TRIGGER IF NOT EXISTS shift_schedule_audit_no_delete
BEFORE DELETE ON shift_schedule_audit
BEGIN
  SELECT RAISE(ABORT,'shift_schedule_audit is append-only');
END;
