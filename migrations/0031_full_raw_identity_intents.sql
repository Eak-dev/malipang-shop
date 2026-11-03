-- Default-off source scaffolding for the existing D1 database. This stores no
-- physical row number. There is intentionally no enrollment or auto-release.
-- Do not apply until migrations 0029/0030 and the full cutover are reviewed.
CREATE TABLE IF NOT EXISTS full_raw_identity_intents (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  metadata_id INTEGER NOT NULL CHECK(metadata_id BETWEEN 1 AND 2147483647),
  state TEXT NOT NULL CHECK(state IN ('VERIFIED','IN_FLIGHT','REVIEW')),
  projected_version INTEGER NOT NULL CHECK(projected_version > 0),
  projected_revision INTEGER NOT NULL CHECK(projected_revision BETWEEN 1 AND 9007199254740991),
  baseline_json TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version > 0),
  source_revision INTEGER NOT NULL CHECK(source_revision > 0),
  source_fingerprint TEXT,
  operation_token TEXT,
  outer_token TEXT,
  cutover_generation TEXT,
  verified_evidence_digest TEXT,
  verified_outer_token TEXT,
  verified_generation TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_name,expense_id),
  UNIQUE(spreadsheet_id,metadata_id),
  CHECK(state <> 'IN_FLIGHT' OR (operation_token IS NOT NULL AND outer_token IS NOT NULL AND cutover_generation IS NOT NULL AND source_fingerprint IS NOT NULL)),
  CHECK(state <> 'VERIFIED' OR (operation_token IS NULL AND outer_token IS NULL))
);
