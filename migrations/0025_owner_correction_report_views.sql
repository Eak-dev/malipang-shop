-- One private, protected report view per correction and accounting month.
-- IDs are persisted before Google requests so interrupted creates and cleanup
-- can be inspected without changing the owner's visible report selection.
CREATE TABLE IF NOT EXISTS expense_owner_correction_report_views(
  correction_id TEXT NOT NULL REFERENCES expense_owner_corrections(correction_id),
  expense_id TEXT NOT NULL REFERENCES expense_events(expense_id),
  expense_version INTEGER NOT NULL CHECK(expense_version>0),
  period TEXT NOT NULL CHECK(period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND CAST(substr(period,6,2) AS INTEGER) BETWEEN 1 AND 12),
  sheet_id INTEGER NOT NULL UNIQUE CHECK(sheet_id>=0),
  sheet_title TEXT NOT NULL UNIQUE,
  metadata_id INTEGER NOT NULL UNIQUE CHECK(metadata_id>0),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','IN_FLIGHT','ACTIVE','REMOVING','REMOVED','REVIEW')),
  dispatch_token TEXT,
  not_before TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(correction_id,period)
);
CREATE INDEX IF NOT EXISTS idx_owner_correction_report_views_cleanup ON expense_owner_correction_report_views(state,updated_at);
