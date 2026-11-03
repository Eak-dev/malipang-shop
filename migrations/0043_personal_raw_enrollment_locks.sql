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
CREATE TRIGGER personal_enrollment_lock_no_delete BEFORE DELETE ON personal_raw_enrollment_locks BEGIN SELECT RAISE(ABORT,'PERSONAL_ENROLLMENT_REVIEW_REQUIRED'); END;
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
