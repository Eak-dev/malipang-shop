-- Default-off D1 work queue. No Google Sheets row position is stored.
-- REVIEW and expired IN_FLIGHT work require reconciliation, never blind retry.
CREATE TABLE IF NOT EXISTS expense_projection_generation_jobs (
  spreadsheet_id TEXT NOT NULL,
  cutover_generation TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  source_version INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PENDING','IN_FLIGHT','REVIEW','SUPERSEDED')),
  reason TEXT,
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,cutover_generation,expense_id,source_version,source_revision),
  CHECK((state='IN_FLIGHT' AND lease_token IS NOT NULL AND lease_until IS NOT NULL) OR (state<>'IN_FLIGHT' AND lease_token IS NULL AND lease_until IS NULL)),
  CHECK(state<>'REVIEW' OR reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_expense_projection_generation_jobs_state ON expense_projection_generation_jobs(state,updated_at);
