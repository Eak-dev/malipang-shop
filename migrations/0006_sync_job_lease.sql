ALTER TABLE sync_jobs ADD COLUMN next_attempt_at TEXT;
ALTER TABLE sync_jobs ADD COLUMN lease_until TEXT;
ALTER TABLE sync_jobs ADD COLUMN lease_token TEXT;

UPDATE sync_jobs
SET next_attempt_at=updated_at
WHERE status IN ('PENDING','FAILED');

UPDATE sync_jobs
SET lease_until=updated_at
WHERE status='PROCESSING';

CREATE INDEX IF NOT EXISTS idx_sync_recovery
ON sync_jobs(status,updated_at,next_attempt_at,lease_until);
