PRAGMA foreign_keys = ON;

ALTER TABLE attendance_events ADD COLUMN evidence_deleted_at TEXT;
ALTER TABLE expense_documents ADD COLUMN evidence_deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_attendance_evidence_retention
ON attendance_events(evidence_deleted_at, created_at);

CREATE INDEX IF NOT EXISTS idx_expense_document_evidence_retention
ON expense_documents(evidence_deleted_at, status, created_at, updated_at);
