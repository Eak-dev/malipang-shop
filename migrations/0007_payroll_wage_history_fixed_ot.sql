PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employee_wage_history(
  wage_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  daily_wage_satang INTEGER NOT NULL CHECK(daily_wage_satang >= 0),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  source TEXT NOT NULL DEFAULT 'OWNER',
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(employee_id,effective_from),
  FOREIGN KEY(employee_id) REFERENCES employees(employee_id)
);
CREATE INDEX IF NOT EXISTS idx_wage_history_lookup ON employee_wage_history(employee_id,effective_from,effective_to);

INSERT OR IGNORE INTO employee_wage_history(
  wage_id,employee_id,daily_wage_satang,effective_from,effective_to,source,note,version,created_at,updated_at
)
SELECT
  'wage_'||employee_id||'_baseline',employee_id,daily_wage_satang,'1970-01-01',NULL,
  'MIGRATION_BASELINE','Backfilled from employees.daily_wage_satang',1,updated_at,updated_at
FROM employees;

CREATE TABLE IF NOT EXISTS employee_shift_days(
  employee_id TEXT NOT NULL,
  work_date TEXT NOT NULL,
  scheduled_in TEXT NOT NULL,
  scheduled_out TEXT NOT NULL,
  daily_wage_snapshot_satang INTEGER NOT NULL CHECK(daily_wage_snapshot_satang >= 0),
  wage_source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'EXPECTED' CHECK(status IN ('EXPECTED','DAY_OFF','CANCELLED')),
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(employee_id,work_date),
  FOREIGN KEY(employee_id) REFERENCES employees(employee_id)
);
CREATE INDEX IF NOT EXISTS idx_shift_days_date_status ON employee_shift_days(work_date,status);

CREATE TABLE IF NOT EXISTS ot_requests(
  ot_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  work_date TEXT NOT NULL,
  reason TEXT NOT NULL,
  planned_start TEXT,
  planned_end TEXT,
  fixed_amount_satang INTEGER NOT NULL CHECK(fixed_amount_satang > 0),
  requested_by TEXT NOT NULL,
  owner_preapproved_at TEXT NOT NULL,
  employee_confirm_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(employee_confirm_status IN ('PENDING','ACCEPTED','DECLINED')),
  employee_confirmed_at TEXT,
  owner_final_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(owner_final_status IN ('PENDING','APPROVED','REJECTED')),
  owner_final_amount_satang INTEGER NOT NULL DEFAULT 0 CHECK(owner_final_amount_satang >= 0),
  owner_final_at TEXT,
  actual_ot_minutes INTEGER NOT NULL DEFAULT 0 CHECK(actual_ot_minutes >= 0),
  status TEXT NOT NULL DEFAULT 'PENDING_EMPLOYEE' CHECK(status IN ('PENDING_EMPLOYEE','EMPLOYEE_ACCEPTED','EMPLOYEE_DECLINED','APPROVED','REJECTED','CANCELLED')),
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(employee_id) REFERENCES employees(employee_id)
);
CREATE INDEX IF NOT EXISTS idx_ot_employee_date ON ot_requests(employee_id,work_date,status);

ALTER TABLE attendance_daily ADD COLUMN wage_source_id TEXT NOT NULL DEFAULT '';
ALTER TABLE attendance_daily ADD COLUMN daily_wage_snapshot_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attendance_daily ADD COLUMN late_deduction_applied_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attendance_daily ADD COLUMN missing_punch_type TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE attendance_daily ADD COLUMN missing_punch_deduction_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attendance_daily ADD COLUMN ot_approved_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attendance_daily ADD COLUMN other_adjustment_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attendance_daily ADD COLUMN net_pay_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attendance_daily ADD COLUMN payroll_policy_code TEXT NOT NULL DEFAULT 'LATE_V1_FIXED_OT_V1';
ALTER TABLE attendance_daily ADD COLUMN finalized_at TEXT;

UPDATE attendance_daily
SET daily_wage_snapshot_satang=daily_wage_satang,
    net_pay_satang=confirmed_wage_satang,
    wage_source_id=CASE WHEN wage_source_id='' THEN 'LEGACY_SNAPSHOT' ELSE wage_source_id END
WHERE daily_wage_snapshot_satang=0;

ALTER TABLE payroll_weekly ADD COLUMN base_wage_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_weekly ADD COLUMN late_deduction_total_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_weekly ADD COLUMN missing_punch_deduction_total_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_weekly ADD COLUMN ot_total_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_weekly ADD COLUMN other_adjustment_total_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_weekly ADD COLUMN net_pay_satang INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payroll_weekly ADD COLUMN pending_review_count INTEGER NOT NULL DEFAULT 0;

UPDATE payroll_weekly
SET base_wage_satang=confirmed_amount_satang+pending_amount_satang,
    net_pay_satang=confirmed_amount_satang,
    pending_review_count=CASE WHEN pending_amount_satang>0 THEN 1 ELSE 0 END
WHERE base_wage_satang=0 AND net_pay_satang=0;
