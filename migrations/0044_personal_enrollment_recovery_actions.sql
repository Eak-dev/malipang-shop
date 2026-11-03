-- Audited, expiring admin decisions. Applying a decision never sends a Sheets
-- mutation and requires a fresh provider/source re-read plus coordination.
CREATE TABLE personal_enrollment_recovery_actions (
  action_id TEXT PRIMARY KEY,
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  personal_use_id TEXT NOT NULL,
  metadata_id INTEGER NOT NULL,
  source_version INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL,
  operation_token TEXT NOT NULL,
  outer_token TEXT NOT NULL,
  cutover_generation TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  principal TEXT NOT NULL CHECK(principal='ADMIN_TOKEN'),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 5 AND 200),
  state TEXT NOT NULL CHECK(state IN ('APPROVED','APPLIED','CANCELLED')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK(expires_at>created_at)
);
CREATE INDEX personal_recovery_actions_case ON personal_enrollment_recovery_actions(spreadsheet_id,personal_use_id,metadata_id,source_revision,operation_token,state,expires_at);
CREATE TRIGGER personal_recovery_actions_no_delete BEFORE DELETE ON personal_enrollment_recovery_actions BEGIN SELECT RAISE(ABORT,'PERSONAL_RECOVERY_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_recovery_actions_no_replace BEFORE INSERT ON personal_enrollment_recovery_actions WHEN EXISTS(SELECT 1 FROM personal_enrollment_recovery_actions a WHERE a.rowid=NEW.rowid OR a.action_id=NEW.action_id) BEGIN SELECT RAISE(ABORT,'PERSONAL_RECOVERY_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_recovery_actions_rowid_no_replace BEFORE UPDATE ON personal_enrollment_recovery_actions WHEN EXISTS(SELECT 1 FROM personal_enrollment_recovery_actions a WHERE a.rowid=NEW.rowid AND a.rowid<>OLD.rowid) BEGIN SELECT RAISE(ABORT,'PERSONAL_RECOVERY_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_recovery_actions_immutable BEFORE UPDATE OF action_id,spreadsheet_id,sheet_name,personal_use_id,metadata_id,source_version,source_revision,source_fingerprint,operation_token,outer_token,cutover_generation,evidence_digest,principal,reason,created_at,expires_at ON personal_enrollment_recovery_actions BEGIN SELECT RAISE(ABORT,'PERSONAL_RECOVERY_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_recovery_actions_no_transition BEFORE UPDATE OF state ON personal_enrollment_recovery_actions WHEN OLD.state IS NOT NEW.state AND NOT (OLD.state='APPROVED' AND (NEW.state='CANCELLED' OR (NEW.state='APPLIED' AND OLD.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NOT EXISTS(SELECT 1 FROM personal_raw_enrollment_locks l WHERE l.spreadsheet_id=OLD.spreadsheet_id AND l.sheet_name=OLD.sheet_name)))) BEGIN SELECT RAISE(ABORT,'PERSONAL_RECOVERY_INVALID_TRANSITION'); END;
CREATE TABLE personal_recovery_atomic_assertions (assertion_id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1));
