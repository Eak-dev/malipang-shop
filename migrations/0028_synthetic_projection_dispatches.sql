-- Synthetic QA only: dispatch cadence, not a sheet row or a business record.
CREATE TABLE IF NOT EXISTS synthetic_projection_dispatches (
  expense_id TEXT NOT NULL,
  expense_version INTEGER NOT NULL CHECK(expense_version > 0),
  cutover_generation TEXT NOT NULL,
  next_attempt_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(expense_id,expense_version,cutover_generation)
);
-- One explicit probe per actual Worker version. PENDING is never retried
-- automatically: a misbound producer may have sent it to another queue.
CREATE TABLE IF NOT EXISTS synthetic_projection_queue_probes (
  worker_version_id TEXT PRIMARY KEY,
  probe_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('PENDING','VERIFIED','REVIEW')),
  updated_at TEXT NOT NULL
);
