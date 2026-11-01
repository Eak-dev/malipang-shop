-- Drafts carry immutable before/after snapshots; creating one cannot post money.
CREATE TABLE IF NOT EXISTS expense_owner_corrections(
  correction_id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL REFERENCES expense_events(expense_id),
  owner_employee_id TEXT NOT NULL REFERENCES employees(employee_id),
  input_id TEXT UNIQUE,
  field TEXT NOT NULL CHECK(field IN ('description','category','amountSatang','transactionDate','payment')),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('DRAFT','APPLIED','CANCELLED','STALE')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  applied_at TEXT,
  reconciled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_owner_corrections_owner ON expense_owner_corrections(owner_employee_id,status,created_at);

-- One explicitly selected input per owner; inbound text is never guessed.
CREATE TABLE IF NOT EXISTS expense_owner_correction_inputs(
  owner_employee_id TEXT PRIMARY KEY REFERENCES employees(employee_id),
  input_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK(mode IN ('SEARCH','VALUE')),
  expense_id TEXT REFERENCES expense_events(expense_id),
  field TEXT CHECK(field IS NULL OR field IN ('description','amountSatang','transactionDate')),
  snapshot_json TEXT,
  search_query TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK((mode='SEARCH' AND expense_id IS NULL AND field IS NULL AND snapshot_json IS NULL) OR
        (mode='VALUE' AND expense_id IS NOT NULL AND field IS NOT NULL AND snapshot_json IS NOT NULL))
);
