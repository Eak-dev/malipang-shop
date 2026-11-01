-- An editor's Sheet change is a request, not approval of a business change.
CREATE TABLE IF NOT EXISTS daily_category_baselines(
  expense_id TEXT PRIMARY KEY REFERENCES expense_events(expense_id),
  row_number INTEGER NOT NULL CHECK(row_number > 0),
  metadata_id INTEGER NOT NULL UNIQUE CHECK(metadata_id > 0),
  category TEXT NOT NULL,
  expense_version INTEGER NOT NULL CHECK(expense_version > 0),
  fingerprint TEXT NOT NULL CHECK(fingerprint <> ''),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_category_requests(
  request_id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES expense_events(expense_id),
  row_number INTEGER NOT NULL CHECK(row_number > 0),
  metadata_id INTEGER NOT NULL CHECK(metadata_id > 0),
  from_category TEXT NOT NULL,
  to_category TEXT NOT NULL CHECK(to_category <> from_category),
  expense_version INTEGER NOT NULL CHECK(expense_version > 0),
  fingerprint TEXT NOT NULL CHECK(fingerprint <> ''),
  status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','STALE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_by_employee_id TEXT REFERENCES employees(employee_id),
  reviewed_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_category_pending_per_expense
  ON daily_category_requests(expense_id) WHERE status='PENDING';
CREATE INDEX IF NOT EXISTS idx_daily_category_pending_order
  ON daily_category_requests(status,created_at,request_id);

CREATE TABLE IF NOT EXISTS daily_category_rejections(
  expense_id TEXT PRIMARY KEY REFERENCES expense_events(expense_id),
  rejected_category TEXT NOT NULL,
  expense_version INTEGER NOT NULL CHECK(expense_version > 0),
  request_id TEXT NOT NULL REFERENCES daily_category_requests(request_id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_category_projection_targets(
  expense_id TEXT NOT NULL REFERENCES expense_events(expense_id),
  target_type TEXT NOT NULL CHECK(target_type IN ('RAW','ITEM')),
  item_id TEXT NOT NULL DEFAULT '',
  metadata_id INTEGER NOT NULL UNIQUE CHECK(metadata_id > 0),
  CHECK((target_type='RAW' AND item_id='') OR (target_type='ITEM' AND item_id<>'')),
  PRIMARY KEY(expense_id,target_type,item_id)
);
