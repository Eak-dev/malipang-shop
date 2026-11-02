-- Shadow prototype only. The row number is intentionally not stored.
CREATE TABLE IF NOT EXISTS daily_stable_row_intents (
  spreadsheet_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  metadata_id INTEGER NOT NULL CHECK(metadata_id BETWEEN 1 AND 2147483647),
  state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','VERIFIED')),
  expense_version INTEGER NOT NULL CHECK(expense_version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (spreadsheet_id,expense_id),
  UNIQUE (spreadsheet_id,metadata_id)
);
