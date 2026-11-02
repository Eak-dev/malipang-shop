-- Synthetic shadow prototype: no sheet row coordinates are stored.
CREATE TABLE IF NOT EXISTS synthetic_expense_projection_journal (
  spreadsheet_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  expense_version INTEGER NOT NULL CHECK(expense_version > 0),
  projection TEXT NOT NULL CHECK(projection IN ('RAW','DAILY','DETAIL')),
  state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','VERIFIED','REVIEW')),
  operation_token TEXT NOT NULL,
  source_snapshot TEXT NOT NULL,
  evidence_digest TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,expense_id,expense_version,projection),
  CHECK(state <> 'VERIFIED' OR evidence_digest IS NOT NULL)
);
