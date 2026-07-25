PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS evidence_objects(
  object_key TEXT PRIMARY KEY,
  evidence_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING_UPLOAD','STORED','UPLOAD_FAILED','RETENTION_ELIGIBLE')),
  created_at TEXT NOT NULL,
  retention_eligible_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_objects_retention
ON evidence_objects(status, evidence_type, created_at);
