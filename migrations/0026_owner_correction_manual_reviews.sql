-- A held owner request is durable and visible, but never changes an expense.
CREATE TABLE IF NOT EXISTS expense_owner_correction_manual_reviews(
  correction_id TEXT PRIMARY KEY REFERENCES expense_owner_corrections(correction_id),
  expense_id TEXT NOT NULL REFERENCES expense_events(expense_id),
  owner_employee_id TEXT NOT NULL REFERENCES employees(employee_id),
  reason_code TEXT NOT NULL CHECK(reason_code IN ('CROSS_MONTH','LEGACY_BANK','RECEIPT_ALLOCATION','REPORT_DUPLICATE','SHEET_CHECK','PERIOD_UNCONFIRMED')),
  status TEXT NOT NULL CHECK(status IN ('OPEN','CANCELLED','RESOLVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_owner_correction_manual_review_owner ON expense_owner_correction_manual_reviews(owner_employee_id,status,created_at);
