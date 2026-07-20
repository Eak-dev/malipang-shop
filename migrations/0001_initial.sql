PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS employees(
  employee_id TEXT PRIMARY KEY,
  staff_name TEXT NOT NULL,
  line_user_id TEXT NOT NULL UNIQUE,
  scheduled_in TEXT NOT NULL,
  scheduled_out TEXT NOT NULL,
  daily_wage_satang INTEGER NOT NULL DEFAULT 0 CHECK(daily_wage_satang >= 0),
  grace_min INTEGER NOT NULL DEFAULT 10 CHECK(grace_min >= 0),
  late_deduction_satang INTEGER NOT NULL DEFAULT 0 CHECK(late_deduction_satang >= 0),
  early_deduction_satang INTEGER NOT NULL DEFAULT 0 CHECK(early_deduction_satang >= 0),
  can_submit_expense INTEGER NOT NULL DEFAULT 0 CHECK(can_submit_expense IN (0,1)),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inbound_events(
  webhook_event_id TEXT PRIMARY KEY,
  message_id TEXT,
  line_user_id TEXT,
  message_type TEXT,
  route TEXT NOT NULL DEFAULT 'UNROUTED',
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  error TEXT NOT NULL DEFAULT '',
  trace_id TEXT,
  received_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbound_status ON inbound_events(status,last_attempt_at);

CREATE TABLE IF NOT EXISTS attendance_events(
  event_id TEXT PRIMARY KEY,
  webhook_event_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  employee_id TEXT NOT NULL,
  work_date TEXT NOT NULL,
  punch_type TEXT NOT NULL,
  official_time TEXT,
  status TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  line_time TEXT,
  line_diff_minutes INTEGER,
  image_key TEXT,
  note TEXT NOT NULL DEFAULT '',
  validation_code TEXT NOT NULL,
  trace_id TEXT,
  created_at TEXT NOT NULL,
  version INTEGER NOT NULL,
  FOREIGN KEY(employee_id) REFERENCES employees(employee_id)
);
CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance_events(employee_id,work_date);

CREATE TABLE IF NOT EXISTS attendance_daily(
  employee_id TEXT NOT NULL,
  work_date TEXT NOT NULL,
  scheduled_in TEXT NOT NULL,
  scheduled_out TEXT NOT NULL,
  grace_min INTEGER NOT NULL,
  late_deduction_satang INTEGER NOT NULL,
  early_deduction_satang INTEGER NOT NULL,
  time_in TEXT,
  time_out TEXT,
  work_minutes INTEGER NOT NULL DEFAULT 0,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  early_out_minutes INTEGER NOT NULL DEFAULT 0,
  daily_wage_satang INTEGER NOT NULL DEFAULT 0,
  confirmed_wage_satang INTEGER NOT NULL DEFAULT 0,
  pending_wage_satang INTEGER NOT NULL DEFAULT 0,
  pay_status TEXT NOT NULL,
  review_flag INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(employee_id,work_date),
  FOREIGN KEY(employee_id) REFERENCES employees(employee_id)
);

CREATE TABLE IF NOT EXISTS payroll_weekly(
  employee_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  pay_sunday TEXT NOT NULL,
  work_days INTEGER NOT NULL DEFAULT 0,
  confirmed_amount_satang INTEGER NOT NULL DEFAULT 0,
  pending_amount_satang INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(employee_id,week_start),
  FOREIGN KEY(employee_id) REFERENCES employees(employee_id)
);

CREATE TABLE IF NOT EXISTS expense_events(
  expense_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  line_user_id TEXT NOT NULL,
  description TEXT NOT NULL,
  amount_satang INTEGER NOT NULL CHECK(amount_satang > 0),
  payment_key TEXT NOT NULL,
  source_wallet TEXT NOT NULL,
  category TEXT NOT NULL,
  transaction_date TEXT NOT NULL,
  status TEXT NOT NULL,
  trace_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS expense_documents(
  document_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  line_user_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  image_key TEXT,
  status TEXT NOT NULL,
  ai_json TEXT,
  trace_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_jobs(
  job_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(entity_type,entity_key,entity_version)
);
CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_jobs(status,updated_at);

CREATE TABLE IF NOT EXISTS sheet_row_index(sheet_name TEXT NOT NULL,entity_key TEXT NOT NULL,row_number INTEGER NOT NULL,PRIMARY KEY(sheet_name,entity_key));
CREATE TABLE IF NOT EXISTS sheet_cursors(sheet_name TEXT PRIMARY KEY,next_row INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage_daily(day TEXT NOT NULL,metric TEXT NOT NULL,value INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(day,metric));
CREATE TABLE IF NOT EXISTS metrics(id INTEGER PRIMARY KEY AUTOINCREMENT,trace_id TEXT,name TEXT,value_ms INTEGER,labels_json TEXT,created_at TEXT);
CREATE INDEX IF NOT EXISTS idx_metrics_created ON metrics(created_at,name);

CREATE TABLE IF NOT EXISTS failed_jobs(
  id TEXT PRIMARY KEY,
  queue_name TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  error TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE(queue_name,trace_id)
);

CREATE TABLE IF NOT EXISTS admin_audit(
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);
