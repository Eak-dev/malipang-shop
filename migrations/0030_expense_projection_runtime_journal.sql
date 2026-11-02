-- Candidate schema, not a release authorization. No Sheet row is stored.
CREATE TABLE IF NOT EXISTS expense_projection_cutovers (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','ACTIVE','HELD')),
  admission_watermark INTEGER CHECK(admission_watermark >= 0),
  activated_at TEXT,
  PRIMARY KEY(spreadsheet_id,sheet_name),
  CHECK(state <> 'ACTIVE' OR (admission_watermark IS NOT NULL AND activated_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS expense_projection_runtime_intents (
  spreadsheet_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version > 0),
  source_revision INTEGER NOT NULL CHECK(source_revision BETWEEN 1 AND 9007199254740991),
  projection TEXT NOT NULL CHECK(projection IN ('RAW','DAILY','DETAIL')),
  state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','VERIFIED','REVIEW')),
  operation_token TEXT NOT NULL,
  cutover_generation TEXT NOT NULL,
  admission_watermark INTEGER NOT NULL CHECK(admission_watermark >= 0),
  evidence_digest TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,expense_id,source_version,projection),
  CHECK(state <> 'VERIFIED' OR evidence_digest IS NOT NULL)
);
