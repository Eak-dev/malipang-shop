-- Human resolution is separate from immutable image extraction. No backfill
-- or automatic promotion of historical evidence is performed.
CREATE TABLE IF NOT EXISTS expense_document_reviews(
  document_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
  phase TEXT NOT NULL DEFAULT 'HELD' CHECK(phase IN ('HELD','DRAFTED')),
  owner_facts_json TEXT NOT NULL DEFAULT '{}',
  extraction_attempts_json TEXT NOT NULL DEFAULT '[]',
  reason_codes_json TEXT NOT NULL DEFAULT '[]',
  expense_id TEXT,
  updated_by_employee_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(document_id) REFERENCES expense_documents(document_id),
  FOREIGN KEY(expense_id) REFERENCES expense_events(expense_id),
  FOREIGN KEY(updated_by_employee_id) REFERENCES employees(employee_id)
);
CREATE INDEX IF NOT EXISTS idx_expense_document_reviews_phase
ON expense_document_reviews(phase,updated_at);

-- One explicitly targeted input per verified owner. Switching cases replaces
-- the input target, never the facts or evidence of the previous case.
CREATE TABLE IF NOT EXISTS expense_document_review_inputs(
  owner_employee_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK(field IN ('amount','date')),
  review_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(owner_employee_id) REFERENCES employees(employee_id),
  FOREIGN KEY(document_id) REFERENCES expense_documents(document_id)
);
CREATE INDEX IF NOT EXISTS idx_expense_document_review_inputs_expiry
ON expense_document_review_inputs(expires_at);
