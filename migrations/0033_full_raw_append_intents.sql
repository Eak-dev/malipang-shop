-- Candidate in the existing D1 database. A sheet lock never expires or
-- auto-releases: an uncertain write requires reviewed recovery. No row number
-- is recorded. No production route applies or uses this migration yet.
CREATE TABLE IF NOT EXISTS full_raw_sheet_locks (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('HELD','REVIEW')),
  expense_id TEXT NOT NULL,
  operation_token TEXT NOT NULL,
  outer_token TEXT NOT NULL,
  cutover_generation TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_name)
);
CREATE TABLE IF NOT EXISTS full_raw_append_intents (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  metadata_id INTEGER NOT NULL CHECK(metadata_id BETWEEN 1 AND 2147483647),
  state TEXT NOT NULL CHECK(state IN ('RESERVED','IN_FLIGHT','REVIEW')),
  source_version INTEGER NOT NULL CHECK(source_version>0),
  source_revision INTEGER NOT NULL CHECK(source_revision>0),
  source_fingerprint TEXT NOT NULL,
  operation_token TEXT NOT NULL,
  outer_token TEXT NOT NULL,
  cutover_generation TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_name,expense_id),
  UNIQUE(spreadsheet_id,metadata_id)
);
