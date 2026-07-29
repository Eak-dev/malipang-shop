PRAGMA foreign_keys = ON;

-- V1.1 is deliberately additive.  `employees` remains the operational staff
-- record used by the existing attendance/payroll data; these tables add the
-- authoritative business role, scope and LINE identity layers around it.
CREATE TABLE IF NOT EXISTS branches(
  branch_id TEXT PRIMARY KEY,
  branch_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_roles(
  role_assignment_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('OWNER','BRANCH_MANAGER','ASSISTANT_MANAGER','EMPLOYEE')),
  scope TEXT NOT NULL CHECK(scope IN ('ORGANIZATION','BRANCH')),
  branch_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','INACTIVE')),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  assigned_by TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(employee_id) REFERENCES employees(employee_id),
  FOREIGN KEY(branch_id) REFERENCES branches(branch_id),
  CHECK((scope='ORGANIZATION' AND branch_id IS NULL) OR (scope='BRANCH' AND branch_id IS NOT NULL)),
  CHECK((role='OWNER' AND scope='ORGANIZATION') OR (role<>'OWNER' AND scope='BRANCH'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_roles_one_active_role
ON staff_roles(employee_id) WHERE status='ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_roles_one_active_manager
ON staff_roles(branch_id) WHERE status='ACTIVE' AND role='BRANCH_MANAGER';
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_roles_one_active_assistant_manager
ON staff_roles(branch_id) WHERE status='ACTIVE' AND role='ASSISTANT_MANAGER';
CREATE INDEX IF NOT EXISTS idx_staff_roles_scope
ON staff_roles(branch_id,role,status);

CREATE TABLE IF NOT EXISTS line_identity_bindings(
  binding_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider='LINE'),
  external_user_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('VERIFIED','REVOKED')),
  verified_at TEXT,
  verified_by TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(employee_id) REFERENCES employees(employee_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_line_identity_one_active_external
ON line_identity_bindings(provider,external_user_id) WHERE status='VERIFIED';
CREATE UNIQUE INDEX IF NOT EXISTS idx_line_identity_one_active_staff
ON line_identity_bindings(provider,employee_id) WHERE status='VERIFIED';
CREATE INDEX IF NOT EXISTS idx_line_identity_employee
ON line_identity_bindings(employee_id,status);

CREATE TABLE IF NOT EXISTS identity_link_requests(
  request_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider='LINE'),
  external_user_id TEXT NOT NULL,
  requested_staff_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('PENDING_STAFF_ID','PENDING_OWNER_APPROVAL','APPROVED','REJECTED','CANCELLED')),
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  rejection_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(requested_staff_id) REFERENCES employees(employee_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_request_one_pending_line
ON identity_link_requests(provider,external_user_id)
WHERE status IN ('PENDING_STAFF_ID','PENDING_OWNER_APPROVAL');
CREATE INDEX IF NOT EXISTS idx_identity_request_review
ON identity_link_requests(status,requested_at);

CREATE TABLE IF NOT EXISTS access_audit_log(
  audit_id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('STAFF','SYSTEM','MIGRATION')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target_employee_id TEXT,
  branch_id TEXT,
  reason TEXT NOT NULL DEFAULT '',
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(target_employee_id) REFERENCES employees(employee_id),
  FOREIGN KEY(branch_id) REFERENCES branches(branch_id)
);
CREATE INDEX IF NOT EXISTS idx_access_audit_target
ON access_audit_log(target_employee_id,created_at);

CREATE TRIGGER IF NOT EXISTS access_audit_log_no_update
BEFORE UPDATE ON access_audit_log
BEGIN
  SELECT RAISE(ABORT,'access_audit_log is append-only');
END;
CREATE TRIGGER IF NOT EXISTS access_audit_log_no_delete
BEFORE DELETE ON access_audit_log
BEGIN
  SELECT RAISE(ABORT,'access_audit_log is append-only');
END;

CREATE TABLE IF NOT EXISTS employee_change_requests(
  change_request_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  request_type TEXT NOT NULL CHECK(request_type IN ('ATTENDANCE_CORRECTION','PROFILE_CORRECTION')),
  work_date TEXT,
  field_name TEXT,
  proposed_value TEXT,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(employee_id) REFERENCES employees(employee_id)
);
CREATE INDEX IF NOT EXISTS idx_employee_change_requests_review
ON employee_change_requests(employee_id,status,created_at);

INSERT OR IGNORE INTO branches(branch_id,branch_name,status,created_at,updated_at)
VALUES('B001','Yingcharoen','ACTIVE',datetime('now'),datetime('now'));

-- Existing staff stay on their current identity and payroll records.  The
-- confirmed production owner is Eak (EMP_TEST); all other existing staff are
-- branch employees until an Owner changes their role through the audited flow.
INSERT OR IGNORE INTO staff_roles(
  role_assignment_id,employee_id,role,scope,branch_id,status,effective_from,
  effective_to,assigned_by,reason,created_at,updated_at
)
SELECT
  'role_baseline_'||employee_id,
  employee_id,
  CASE WHEN employee_id='EMP_TEST' THEN 'OWNER' ELSE 'EMPLOYEE' END,
  CASE WHEN employee_id='EMP_TEST' THEN 'ORGANIZATION' ELSE 'BRANCH' END,
  CASE WHEN employee_id='EMP_TEST' THEN NULL ELSE 'B001' END,
  CASE WHEN status='ACTIVE' THEN 'ACTIVE' ELSE 'INACTIVE' END,
  '1970-01-01',NULL,'MIGRATION_BASELINE','V1.1 additive baseline',updated_at,updated_at
FROM employees;

-- Backfill only structurally valid LINE user IDs.  No display-name inference
-- is used and the legacy employees.line_user_id value is retained unchanged.
INSERT OR IGNORE INTO line_identity_bindings(
  binding_id,provider,external_user_id,employee_id,status,verified_at,
  verified_by,revoked_at,revoked_by,reason,created_at,updated_at
)
SELECT
  'line_baseline_'||employee_id,'LINE',line_user_id,employee_id,'VERIFIED',
  updated_at,'MIGRATION_BASELINE',NULL,NULL,'Backfilled from existing employee LINE binding',updated_at,updated_at
FROM employees
WHERE line_user_id GLOB 'U*' AND length(line_user_id)>=21;
