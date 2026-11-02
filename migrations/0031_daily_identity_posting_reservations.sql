-- Inert until used by a future identity-protected posting workflow.
-- The numeric row is an initial candidate only; after a marker is created,
-- the metadata identity must be re-read before any external value write.
CREATE TABLE IF NOT EXISTS daily_identity_posting_reservations(
  expense_id TEXT NOT NULL REFERENCES expense_events(expense_id),
  expense_version INTEGER NOT NULL CHECK(expense_version>0),
  sheet_name TEXT NOT NULL,
  sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
  row_number INTEGER NOT NULL CHECK(row_number>0),
  metadata_id INTEGER NOT NULL UNIQUE CHECK(metadata_id BETWEEN 1 AND 2147483647),
  snapshot_json TEXT NOT NULL,
  header_digest TEXT NOT NULL,
  creation_nonce TEXT NOT NULL UNIQUE,
  dispatch_id TEXT UNIQUE,
  fence_token TEXT,
  not_before TEXT,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','IN_FLIGHT','VERIFIED','REVIEW')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(expense_id,expense_version),
  UNIQUE(sheet_name,row_number)
);
