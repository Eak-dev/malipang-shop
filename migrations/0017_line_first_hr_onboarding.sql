PRAGMA foreign_keys = ON;

-- LINE-first onboarding keeps the employee's first action intentionally tiny:
-- send `HR` once, then let a verified Owner provision or explicitly link the
-- identity.  This table is separate from the legacy Staff-ID registration
-- requests so the old flow remains available during the transition.
CREATE TABLE IF NOT EXISTS hr_onboarding_requests(
  request_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'LINE' CHECK(provider='LINE'),
  external_user_id TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  picture_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('PENDING_OWNER_SETUP','APPROVED','REJECTED','CANCELLED')),
  employee_id TEXT,
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  rejection_reason TEXT NOT NULL DEFAULT '',
  claimed_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(employee_id) REFERENCES employees(employee_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hr_onboarding_one_pending_line
ON hr_onboarding_requests(provider,external_user_id)
WHERE status='PENDING_OWNER_SETUP';
CREATE INDEX IF NOT EXISTS idx_hr_onboarding_owner_queue
ON hr_onboarding_requests(status,requested_at);

-- Atomic Staff-ID reservation.  Gaps are acceptable after a failed downstream
-- provision; collisions are not.  Existing canonical EMPxxx IDs seed the next
-- number at migration time, and runtime allocation also skips any later
-- collision defensively.
CREATE TABLE IF NOT EXISTS staff_id_sequences(
  prefix TEXT PRIMARY KEY,
  next_number INTEGER NOT NULL CHECK(next_number >= 1),
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO staff_id_sequences(prefix,next_number,updated_at)
SELECT
  'EMP',
  COALESCE(MAX(CASE
    WHEN employee_id GLOB 'EMP[0-9]*' THEN CAST(SUBSTR(employee_id,4) AS INTEGER)
    ELSE NULL
  END),0)+1,
  datetime('now')
FROM employees;

-- Durable outbox for D1 -> HR_STAFF_CONFIG mirroring.  Employee provisioning
-- is successful once D1 commits; a transient Google Sheets outage never rolls
-- the employee back.  Queue/scheduled workers can retry this idempotently.
CREATE TABLE IF NOT EXISTS staff_config_sync_outbox(
  employee_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  trace_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','PROCESSING','FAILED','COMPLETED')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(employee_id,version),
  FOREIGN KEY(employee_id) REFERENCES employees(employee_id)
);
CREATE INDEX IF NOT EXISTS idx_staff_config_sync_recovery
ON staff_config_sync_outbox(status,next_attempt_at,updated_at);