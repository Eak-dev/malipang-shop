-- V1 closeout: preserve original failed-job payload/error while recording an
-- explicit, append-only reconciliation result.  Historical inbound work is
-- never replayed generically because that could create a duplicate business
-- transaction after a prior commit.
CREATE TABLE IF NOT EXISTS failed_job_reconciliations(
  reconciliation_id TEXT PRIMARY KEY,
  failed_job_id TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK(outcome IN (
    'ATTENDANCE_COMMITTED',
    'EXPENSE_COMMITTED',
    'EXPENSE_DOCUMENT_COMMITTED',
    'TEXT_NO_BUSINESS_TRANSACTION',
    'IMAGE_RESUBMISSION_REQUIRED',
    'SMOKE_NOTIFICATION_EXHAUSTED',
    'NOTIFICATION_REVIEW_REQUIRED',
    'UNSUPPORTED_REVIEW_REQUIRED'
  )),
  reason TEXT NOT NULL,
  reconciled_by TEXT NOT NULL,
  reconciled_at TEXT NOT NULL,
  FOREIGN KEY(failed_job_id) REFERENCES failed_jobs(id)
);
CREATE INDEX IF NOT EXISTS idx_failed_job_reconciliations_outcome
ON failed_job_reconciliations(outcome,reconciled_at);
