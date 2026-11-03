-- Candidate only: existing D1, no row numbers. No API here activates a
-- cutover, enrolls history, verifies a Sheet write, or releases REVIEW.
CREATE TABLE IF NOT EXISTS personal_projection_cutovers (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','ACTIVE','HELD')),
  admission_watermark INTEGER CHECK(admission_watermark>=0),
  activated_at TEXT,
  PRIMARY KEY(spreadsheet_id,sheet_name),
  CHECK(state<>'ACTIVE' OR (admission_watermark IS NOT NULL AND activated_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS personal_legacy_writer_gates (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('OPEN','HOLD')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_name)
);
CREATE TABLE IF NOT EXISTS personal_projection_runtime_intents (
  spreadsheet_id TEXT NOT NULL,
  personal_use_id TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version>0),
  source_revision INTEGER NOT NULL CHECK(source_revision>0),
  state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','REVIEW','VERIFIED')),
  operation_token TEXT NOT NULL,
  cutover_generation TEXT NOT NULL,
  admission_watermark INTEGER NOT NULL CHECK(admission_watermark>=0),
  evidence_digest TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,personal_use_id,source_version,source_revision),
  CHECK(state<>'VERIFIED' OR evidence_digest IS NOT NULL)
);
