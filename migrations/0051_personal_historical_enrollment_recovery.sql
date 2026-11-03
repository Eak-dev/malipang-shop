-- Candidate only. Historical identity admission shares the sheet-wide lock
-- with the post-cutover writer. A matching provider readback and an audited
-- decision are required before REVIEW can become VERIFIED. No physical row
-- position is stored here.
CREATE TABLE personal_historical_enrollment_intents (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  personal_use_id TEXT NOT NULL,
  sheet_id INTEGER NOT NULL CHECK(sheet_id BETWEEN 0 AND 2147483647),
  metadata_id INTEGER NOT NULL CHECK(metadata_id BETWEEN 1 AND 2147483647),
  source_version INTEGER NOT NULL CHECK(source_version>0),
  source_revision INTEGER NOT NULL CHECK(source_revision>0),
  source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  cutover_generation TEXT NOT NULL,
  admission_watermark INTEGER NOT NULL CHECK(admission_watermark>=0),
  admission_sequence INTEGER NOT NULL CHECK(admission_sequence>0 AND admission_sequence<=admission_watermark),
  month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-10'),
  operation_token TEXT NOT NULL,
  outer_token TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','REVIEW','VERIFIED')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_name,personal_use_id),
  UNIQUE(spreadsheet_id,metadata_id)
);
CREATE TABLE personal_historical_recovery_actions (
  action_id TEXT PRIMARY KEY,
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  personal_use_id TEXT NOT NULL,
  metadata_id INTEGER NOT NULL,
  source_version INTEGER NOT NULL,
  source_revision INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL,
  cutover_generation TEXT NOT NULL,
  operation_token TEXT NOT NULL,
  outer_token TEXT NOT NULL,
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^0-9a-f]*'),
  principal TEXT NOT NULL CHECK(principal='ADMIN_TOKEN'),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 5 AND 200),
  state TEXT NOT NULL CHECK(state IN ('APPROVED','APPLIED','CANCELLED')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at>created_at)
);
CREATE TABLE personal_historical_atomic_assertions(assertion_id TEXT PRIMARY KEY,ok INTEGER NOT NULL CHECK(ok=1));
CREATE TRIGGER personal_historical_identity_require_lock BEFORE INSERT ON personal_historical_enrollment_intents
WHEN NEW.state<>'IN_FLIGHT' OR NOT EXISTS(SELECT 1 FROM personal_raw_enrollment_locks l WHERE l.spreadsheet_id=NEW.spreadsheet_id AND l.sheet_name=NEW.sheet_name AND l.personal_use_id=NEW.personal_use_id AND l.metadata_id=NEW.metadata_id AND l.operation_token=NEW.operation_token AND l.outer_token=NEW.outer_token AND l.cutover_generation=NEW.cutover_generation AND l.state='HELD')
BEGIN SELECT RAISE(ABORT,'HISTORICAL_LOCK_REQUIRED'); END;
CREATE TRIGGER personal_historical_identity_validate BEFORE INSERT ON personal_historical_enrollment_intents
WHEN EXISTS(SELECT 1 FROM sheet_metadata_identity_registry r WHERE r.spreadsheet_id=NEW.spreadsheet_id AND (r.metadata_id=NEW.metadata_id OR (r.sheet_name=NEW.sheet_name AND r.entity_kind='PERSONAL_USE' AND r.entity_id=NEW.personal_use_id)) AND (r.metadata_id<>NEW.metadata_id OR r.sheet_name<>NEW.sheet_name OR r.entity_kind<>'PERSONAL_USE' OR r.entity_id<>NEW.personal_use_id))
BEGIN SELECT RAISE(ABORT,'HISTORICAL_METADATA_OWNER_CONFLICT'); END;
CREATE TRIGGER personal_historical_identity_register AFTER INSERT ON personal_historical_enrollment_intents
BEGIN INSERT INTO sheet_metadata_identity_registry(spreadsheet_id,metadata_id,sheet_name,entity_kind,entity_id) SELECT NEW.spreadsheet_id,NEW.metadata_id,NEW.sheet_name,'PERSONAL_USE',NEW.personal_use_id WHERE NOT EXISTS(SELECT 1 FROM sheet_metadata_identity_registry r WHERE r.spreadsheet_id=NEW.spreadsheet_id AND r.metadata_id=NEW.metadata_id); END;
CREATE TRIGGER personal_historical_identity_no_replace BEFORE INSERT ON personal_historical_enrollment_intents
WHEN EXISTS(SELECT 1 FROM personal_historical_enrollment_intents i WHERE i.rowid=NEW.rowid OR (i.spreadsheet_id=NEW.spreadsheet_id AND (i.metadata_id=NEW.metadata_id OR (i.sheet_name=NEW.sheet_name AND i.personal_use_id=NEW.personal_use_id))))
BEGIN SELECT RAISE(ABORT,'HISTORICAL_INTENT_ALREADY_EXISTS'); END;
CREATE TRIGGER personal_historical_identity_no_delete BEFORE DELETE ON personal_historical_enrollment_intents BEGIN SELECT RAISE(ABORT,'HISTORICAL_INTENT_IMMUTABLE'); END;
CREATE TRIGGER personal_historical_identity_immutable BEFORE UPDATE OF spreadsheet_id,sheet_name,personal_use_id,sheet_id,metadata_id,source_version,source_revision,source_fingerprint,cutover_generation,admission_watermark,admission_sequence,month,operation_token,outer_token,baseline_json ON personal_historical_enrollment_intents BEGIN SELECT RAISE(ABORT,'HISTORICAL_INTENT_IMMUTABLE'); END;
CREATE TRIGGER personal_historical_identity_no_rowid_replace BEFORE UPDATE ON personal_historical_enrollment_intents WHEN EXISTS(SELECT 1 FROM personal_historical_enrollment_intents i WHERE i.rowid=NEW.rowid AND i.rowid<>OLD.rowid) BEGIN SELECT RAISE(ABORT,'HISTORICAL_INTENT_IMMUTABLE'); END;
-- This conservative first phase permits quarantine only. A separately
-- reviewed recovery migration must add audited VERIFIED/lock-release rules.
CREATE TRIGGER personal_historical_identity_transition BEFORE UPDATE OF state ON personal_historical_enrollment_intents WHEN OLD.state IS NOT NEW.state AND NOT (OLD.state='IN_FLIGHT' AND NEW.state='REVIEW') BEGIN SELECT RAISE(ABORT,'HISTORICAL_RECOVERY_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_no_delete BEFORE DELETE ON personal_historical_recovery_actions BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_initial_state BEFORE INSERT ON personal_historical_recovery_actions WHEN NEW.state<>'APPROVED' BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_no_replace BEFORE INSERT ON personal_historical_recovery_actions WHEN EXISTS(SELECT 1 FROM personal_historical_recovery_actions a WHERE a.rowid=NEW.rowid OR a.action_id=NEW.action_id) BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_no_rowid_replace BEFORE UPDATE ON personal_historical_recovery_actions WHEN EXISTS(SELECT 1 FROM personal_historical_recovery_actions a WHERE a.rowid=NEW.rowid AND a.rowid<>OLD.rowid) BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_immutable BEFORE UPDATE OF action_id,spreadsheet_id,sheet_name,personal_use_id,metadata_id,source_version,source_revision,source_fingerprint,cutover_generation,operation_token,outer_token,evidence_digest,principal,reason,created_at,expires_at ON personal_historical_recovery_actions BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_transition BEFORE UPDATE OF state ON personal_historical_recovery_actions WHEN OLD.state IS NOT NEW.state AND NOT (OLD.state='APPROVED' AND NEW.state='CANCELLED') BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;
