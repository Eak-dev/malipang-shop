PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS evidence_objects(
  object_key TEXT PRIMARY KEY,
  evidence_type TEXT NOT NULL CHECK(evidence_type IN ('attendance','expense')),
  status TEXT NOT NULL CHECK(status IN ('STORED','RETENTION_ELIGIBLE')),
  created_at TEXT NOT NULL,
  retention_eligible_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_objects_retention
ON evidence_objects(status, evidence_type, created_at);

CREATE TABLE IF NOT EXISTS evidence_scan_state(
  prefix TEXT PRIMARY KEY,
  cursor TEXT,
  updated_at TEXT NOT NULL
);
