-- Drafts carry immutable before/after snapshots; creating one cannot post money.
CREATE TABLE IF NOT EXISTS expense_owner_corrections(
  correction_id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES expense_events(expense_id),
  owner_employee_id TEXT NOT NULL REFERENCES employees(employee_id),
  field TEXT NOT NULL CHECK(field IN ('description','category','amountSatang','transactionDate','payment')),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('DRAFT','APPLIED','CANCELLED','STALE')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_corrections_owner ON expense_owner_corrections(owner_employee_id,status,created_at);
