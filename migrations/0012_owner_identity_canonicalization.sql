PRAGMA foreign_keys = ON;

-- Issue #100: canonical owner identities.  This is an identity-preserving
-- primary-key rename, never a delete/re-create.  The alias table is only for
-- resolving immutable historical literals; aliases are not operational staff
-- IDs and are deliberately absent from `employees`.
CREATE TABLE IF NOT EXISTS staff_identity_aliases(
  legacy_employee_id TEXT PRIMARY KEY,
  canonical_employee_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(canonical_employee_id) REFERENCES employees(employee_id),
  CHECK(legacy_employee_id <> canonical_employee_id)
);
CREATE INDEX IF NOT EXISTS idx_staff_identity_aliases_canonical
ON staff_identity_aliases(canonical_employee_id);

-- D1 migrations execute atomically but prohibit SQL BEGIN/COMMIT.  Therefore
-- make a canonical parent row first, re-key all mutable children, then remove
-- the legacy parent only after it has no relational references.  This is the
-- smallest D1-compatible identity-preserving replacement operation.
INSERT INTO employees(
  employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,
  daily_wage_satang,grace_min,late_deduction_satang,early_deduction_satang,
  can_submit_expense,status,updated_at
)
SELECT
  'OWN001',staff_name,'PENDING_OWN001_MIGRATION',scheduled_in,scheduled_out,
  daily_wage_satang,grace_min,late_deduction_satang,early_deduction_satang,
  can_submit_expense,status,updated_at
FROM employees
WHERE employee_id='EMP_TEST'
  AND NOT EXISTS(SELECT 1 FROM employees WHERE employee_id='OWN001');

UPDATE attendance_events SET employee_id='OWN001' WHERE employee_id='EMP_TEST';
UPDATE attendance_daily SET employee_id='OWN001' WHERE employee_id='EMP_TEST';
UPDATE payroll_weekly SET employee_id='OWN001' WHERE employee_id='EMP_TEST';
UPDATE employee_wage_history SET employee_id='OWN001' WHERE employee_id='EMP_TEST';
DROP TRIGGER IF EXISTS shift_schedule_audit_no_update;
-- The shift audit has a composite foreign key to employee_shift_days.  Copy
-- its new parent first, re-key the audit, then remove only the old cache row.
INSERT OR IGNORE INTO employee_shift_days(
  employee_id,work_date,scheduled_in,scheduled_out,daily_wage_snapshot_satang,
  wage_source_id,status,note,version,created_at,updated_at,created_action_id
)
SELECT
  'OWN001',work_date,scheduled_in,scheduled_out,daily_wage_snapshot_satang,
  wage_source_id,status,note,version,created_at,updated_at,created_action_id
FROM employee_shift_days
WHERE employee_id='EMP_TEST';
UPDATE shift_schedule_audit SET employee_id='OWN001' WHERE employee_id='EMP_TEST';
DELETE FROM employee_shift_days WHERE employee_id='EMP_TEST';
UPDATE ot_requests SET employee_id='OWN001' WHERE employee_id='EMP_TEST';
UPDATE staff_roles SET employee_id='OWN001' WHERE employee_id='EMP_TEST';
UPDATE staff_roles SET assigned_by='OWN001' WHERE assigned_by='EMP_TEST';
UPDATE line_identity_bindings SET employee_id='OWN001' WHERE employee_id='EMP_TEST';
UPDATE line_identity_bindings SET verified_by='OWN001' WHERE verified_by='EMP_TEST';
UPDATE line_identity_bindings SET revoked_by='OWN001' WHERE revoked_by='EMP_TEST';
UPDATE identity_link_requests SET requested_staff_id='OWN001' WHERE requested_staff_id='EMP_TEST';
UPDATE identity_link_requests SET reviewed_by='OWN001' WHERE reviewed_by='EMP_TEST';
UPDATE employee_change_requests SET employee_id='OWN001' WHERE employee_id='EMP_TEST';
UPDATE employee_change_requests SET reviewed_by='OWN001' WHERE reviewed_by='EMP_TEST';
UPDATE ot_requests SET requested_by='OWN001' WHERE requested_by='EMP_TEST';
UPDATE payroll_runs SET requested_by='OWN001' WHERE requested_by='EMP_TEST';
UPDATE shift_schedule_audit SET changed_by='OWN001' WHERE changed_by='EMP_TEST';
CREATE TRIGGER IF NOT EXISTS shift_schedule_audit_no_update
BEFORE UPDATE ON shift_schedule_audit
BEGIN
  SELECT RAISE(ABORT,'shift_schedule_audit is append-only');
END;

-- access_audit_log is append-only at runtime.  Its relational actor/target
-- columns must follow the canonical key, while before/after JSON is immutable
-- evidence and therefore retains any historical EMP_TEST literal.
DROP TRIGGER IF EXISTS access_audit_log_no_update;
UPDATE access_audit_log SET target_employee_id='OWN001' WHERE target_employee_id='EMP_TEST';
UPDATE access_audit_log SET actor_id='OWN001' WHERE actor_type='STAFF' AND actor_id='EMP_TEST';
CREATE TRIGGER IF NOT EXISTS access_audit_log_no_update
BEFORE UPDATE ON access_audit_log
BEGIN
  SELECT RAISE(ABORT,'access_audit_log is append-only');
END;

-- sheet_row_index is a mutable reporting cache, not immutable history.  A
-- conflict is intentionally left untouched for manual reconciliation instead
-- of deleting either mapping.
UPDATE sheet_row_index
SET entity_key='OWN001'||substr(entity_key,length('EMP_TEST')+1)
WHERE entity_key LIKE 'EMP_TEST|%'
  AND NOT EXISTS(
    SELECT 1 FROM sheet_row_index target
    WHERE target.sheet_name=sheet_row_index.sheet_name
      AND target.entity_key='OWN001'||substr(sheet_row_index.entity_key,length('EMP_TEST')+1)
  );

INSERT OR IGNORE INTO staff_identity_aliases(
  legacy_employee_id,canonical_employee_id,reason,created_at
)
SELECT 'EMP_TEST','OWN001','Issue #100 canonical Eak owner ID',datetime('now')
WHERE EXISTS(SELECT 1 FROM employees WHERE employee_id='OWN001');

-- All mutable relational links now use OWN001, so EMP_TEST is no longer an
-- operational staff record.  Immutable JSON payloads intentionally remain.
DELETE FROM employees
WHERE employee_id='EMP_TEST'
  AND EXISTS(SELECT 1 FROM employees WHERE employee_id='OWN001');
UPDATE employees
SET line_user_id=COALESCE((
  SELECT external_user_id FROM line_identity_bindings
  WHERE provider='LINE' AND employee_id='OWN001' AND status='VERIFIED'
  LIMIT 1
),line_user_id),updated_at=datetime('now')
WHERE employee_id='OWN001';

-- Provision Nea as a staff identity only.  The LINE account remains unbound
-- until the ordinary HR registration and verified Owner approval flow runs.
INSERT OR IGNORE INTO employees(
  employee_id,staff_name,line_user_id,scheduled_in,scheduled_out,
  daily_wage_satang,grace_min,late_deduction_satang,early_deduction_satang,
  can_submit_expense,status,updated_at
) VALUES(
  'OWN002','Nea','PENDING_OWN002','04:00','16:00',0,10,0,0,1,'ACTIVE',datetime('now')
);
INSERT OR IGNORE INTO employee_wage_history(
  wage_id,employee_id,daily_wage_satang,effective_from,effective_to,source,
  note,version,created_at,updated_at
) VALUES(
  'wage_OWN002_baseline','OWN002',0,'1970-01-01',NULL,'IDENTITY_MIGRATION',
  'Issue #100 owner provisioning baseline',1,datetime('now'),datetime('now')
);
INSERT INTO staff_roles(
  role_assignment_id,employee_id,role,scope,branch_id,status,effective_from,
  effective_to,assigned_by,reason,created_at,updated_at
)
SELECT
  'role_baseline_OWN002','OWN002','OWNER','ORGANIZATION',NULL,'ACTIVE',
  '1970-01-01',NULL,'MIGRATION_0012','Issue #100 owner provisioning',datetime('now'),datetime('now')
WHERE NOT EXISTS(
  SELECT 1 FROM staff_roles WHERE employee_id='OWN002' AND status='ACTIVE'
);

INSERT INTO access_audit_log(
  audit_id,actor_type,actor_id,action,target_employee_id,branch_id,reason,
  before_json,after_json,created_at
)
SELECT
  'audit_issue100_eak_canonicalization','MIGRATION','MIGRATION_0012',
  'STAFF_ID_CANONICALIZED','OWN001',NULL,'Issue #100 canonical owner identity',
  '{"employeeId":"EMP_TEST"}','{"employeeId":"OWN001","role":"OWNER","scope":"ORGANIZATION"}',datetime('now')
WHERE EXISTS(SELECT 1 FROM employees WHERE employee_id='OWN001')
  AND NOT EXISTS(SELECT 1 FROM access_audit_log WHERE audit_id='audit_issue100_eak_canonicalization');
INSERT INTO access_audit_log(
  audit_id,actor_type,actor_id,action,target_employee_id,branch_id,reason,
  before_json,after_json,created_at
)
SELECT
  'audit_issue100_nea_provisioned','MIGRATION','MIGRATION_0012',
  'STAFF_OWNER_PROVISIONED','OWN002',NULL,'Issue #100 owner provisioning',
  NULL,'{"role":"OWNER","scope":"ORGANIZATION","line":"PENDING_HR_REGISTRATION"}',datetime('now')
WHERE EXISTS(SELECT 1 FROM employees WHERE employee_id='OWN002')
  AND NOT EXISTS(SELECT 1 FROM access_audit_log WHERE audit_id='audit_issue100_nea_provisioned');
