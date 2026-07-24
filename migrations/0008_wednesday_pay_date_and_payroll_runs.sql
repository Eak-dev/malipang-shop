PRAGMA foreign_keys = ON;

ALTER TABLE payroll_weekly ADD COLUMN pay_date TEXT NOT NULL DEFAULT '';

UPDATE payroll_weekly
SET pay_date = date(week_start, '+9 days')
WHERE pay_date = '';

CREATE INDEX IF NOT EXISTS idx_payroll_weekly_pay_date
ON payroll_weekly(pay_date, employee_id);

CREATE TABLE IF NOT EXISTS payroll_runs(
  run_id TEXT PRIMARY KEY,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  pay_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PROCESSING','COMPLETED','FAILED')),
  row_count INTEGER NOT NULL DEFAULT 0,
  total_net_pay_satang INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payroll_runs_period
ON payroll_runs(period_start, period_end, status);
