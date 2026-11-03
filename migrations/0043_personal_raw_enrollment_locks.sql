-- Candidate only: hold across provider send/readback. Never expires or releases
-- automatically. No physical row address and no production route.
CREATE TABLE personal_raw_enrollment_locks (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  personal_use_id TEXT NOT NULL,
  metadata_id INTEGER NOT NULL CHECK(metadata_id BETWEEN 1 AND 2147483647),
  state TEXT NOT NULL CHECK(state IN ('HELD','REVIEW')),
  operation_token TEXT NOT NULL,
  outer_token TEXT NOT NULL,
  cutover_generation TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_name),
  UNIQUE(spreadsheet_id,metadata_id)
);
CREATE TRIGGER personal_enrollment_lock_no_delete BEFORE DELETE ON personal_raw_enrollment_locks WHEN NOT EXISTS(SELECT 1 FROM personal_enrollment_recovery_actions a JOIN personal_raw_identity_intents i ON i.spreadsheet_id=a.spreadsheet_id AND i.sheet_name=a.sheet_name AND i.personal_use_id=a.personal_use_id AND i.metadata_id=a.metadata_id AND i.state='VERIFIED' AND i.verified_outer_token=a.outer_token AND i.verified_generation=a.cutover_generation AND i.verified_evidence_digest=a.evidence_digest JOIN personal_projection_runtime_intents o ON o.spreadsheet_id=a.spreadsheet_id AND o.personal_use_id=a.personal_use_id AND o.source_version=a.source_version AND o.source_revision=a.source_revision AND o.operation_token=a.outer_token AND o.cutover_generation=a.cutover_generation AND o.state='VERIFIED' AND o.evidence_digest=a.evidence_digest WHERE a.spreadsheet_id=OLD.spreadsheet_id AND a.sheet_name=OLD.sheet_name AND a.personal_use_id=OLD.personal_use_id AND a.metadata_id=OLD.metadata_id AND a.operation_token=OLD.operation_token AND a.outer_token=OLD.outer_token AND a.cutover_generation=OLD.cutover_generation AND a.state='APPROVED' AND a.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM owner_personal_transactions p JOIN personal_projection_source_revisions r ON r.personal_use_id=p.personal_use_id AND r.state='TRACKED' AND r.revision=a.source_revision WHERE p.personal_use_id=a.personal_use_id AND p.version=a.source_version AND p.status='CONFIRMED') AND EXISTS(SELECT 1 FROM sync_jobs s WHERE s.entity_type='PERSONAL_USE' AND s.entity_key=a.personal_use_id AND s.entity_version=a.source_version AND s.status='COMPLETED') AND EXISTS(SELECT 1 FROM personal_projection_generation_jobs q WHERE q.spreadsheet_id=a.spreadsheet_id AND q.cutover_generation=a.cutover_generation AND q.personal_use_id=a.personal_use_id AND q.source_version=a.source_version AND q.source_revision=a.source_revision AND q.state='COMPLETED')) BEGIN SELECT RAISE(ABORT,'PERSONAL_ENROLLMENT_REVIEW_REQUIRED'); END;
CREATE TRIGGER personal_enrollment_lock_no_release BEFORE UPDATE OF state ON personal_raw_enrollment_locks WHEN OLD.state='REVIEW' AND NEW.state<>'REVIEW' BEGIN SELECT RAISE(ABORT,'PERSONAL_ENROLLMENT_REVIEW_REQUIRED'); END;
CREATE TRIGGER personal_enrollment_lock_immutable BEFORE UPDATE OF spreadsheet_id,sheet_name,personal_use_id,metadata_id,operation_token,outer_token,cutover_generation ON personal_raw_enrollment_locks
WHEN OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR OLD.personal_use_id IS NOT NEW.personal_use_id OR OLD.metadata_id IS NOT NEW.metadata_id OR OLD.operation_token IS NOT NEW.operation_token OR OLD.outer_token IS NOT NEW.outer_token OR OLD.cutover_generation IS NOT NEW.cutover_generation
BEGIN SELECT RAISE(ABORT,'PERSONAL_ENROLLMENT_REVIEW_REQUIRED'); END;
CREATE TRIGGER personal_enrollment_lock_no_replace BEFORE INSERT ON personal_raw_enrollment_locks
WHEN EXISTS(SELECT 1 FROM personal_raw_enrollment_locks l WHERE l.rowid=NEW.rowid OR (l.spreadsheet_id=NEW.spreadsheet_id AND (l.sheet_name=NEW.sheet_name OR l.metadata_id=NEW.metadata_id)))
BEGIN SELECT RAISE(ABORT,'PERSONAL_ENROLLMENT_REVIEW_REQUIRED'); END;
CREATE TRIGGER personal_enrollment_lock_rowid_no_replace BEFORE UPDATE ON personal_raw_enrollment_locks
WHEN EXISTS(SELECT 1 FROM personal_raw_enrollment_locks l WHERE l.rowid=NEW.rowid AND l.rowid<>OLD.rowid)
BEGIN SELECT RAISE(ABORT,'PERSONAL_ENROLLMENT_REVIEW_REQUIRED'); END;
