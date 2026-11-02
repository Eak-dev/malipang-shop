-- Persist stable metadata IDs before the first Sheets request. If its response
-- is lost, every retry uses the same spreadsheet-unique IDs instead of
-- creating a second association for the same financial row.
CREATE TABLE IF NOT EXISTS expense_owner_correction_bootstrap(
  expense_id TEXT NOT NULL REFERENCES expense_events(expense_id),
  expense_version INTEGER NOT NULL CHECK(expense_version>0),
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  targets_json TEXT NOT NULL CHECK(json_valid(targets_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(expense_id,expense_version)
);
