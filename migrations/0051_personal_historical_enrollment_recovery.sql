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
CREATE UNIQUE INDEX personal_historical_one_approval ON personal_historical_recovery_actions(spreadsheet_id,sheet_name,personal_use_id) WHERE state='APPROVED';
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
CREATE TRIGGER personal_historical_review_time_guard BEFORE UPDATE OF state,updated_at ON personal_historical_enrollment_intents
WHEN (OLD.state='REVIEW' AND (julianday(NEW.updated_at) IS NULL OR julianday(OLD.updated_at) IS NULL OR julianday(NEW.updated_at)<julianday(OLD.updated_at))) OR (OLD.state='IN_FLIGHT' AND NEW.state='REVIEW' AND (length(NEW.updated_at)<>24 OR NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' OR julianday(NEW.updated_at) IS NULL OR abs((julianday(NEW.updated_at)-julianday('now'))*86400)>60))
BEGIN SELECT RAISE(ABORT,'HISTORICAL_REVIEW_TIME_INVALID'); END;
CREATE TRIGGER personal_historical_lock_review_time_guard BEFORE UPDATE OF state,updated_at ON personal_raw_enrollment_locks
WHEN EXISTS(SELECT 1 FROM personal_historical_enrollment_intents i WHERE i.spreadsheet_id=OLD.spreadsheet_id AND i.sheet_name=OLD.sheet_name AND i.personal_use_id=OLD.personal_use_id AND i.metadata_id=OLD.metadata_id AND i.operation_token=OLD.operation_token AND i.outer_token=OLD.outer_token) AND ((OLD.state='REVIEW' AND (julianday(NEW.updated_at) IS NULL OR julianday(OLD.updated_at) IS NULL OR julianday(NEW.updated_at)<julianday(OLD.updated_at))) OR (OLD.state='HELD' AND NEW.state='REVIEW' AND (length(NEW.updated_at)<>24 OR NEW.updated_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' OR julianday(NEW.updated_at) IS NULL OR abs((julianday(NEW.updated_at)-julianday('now'))*86400)>60)))
BEGIN SELECT RAISE(ABORT,'HISTORICAL_REVIEW_TIME_INVALID'); END;
CREATE TRIGGER personal_historical_identity_transition BEFORE UPDATE OF state ON personal_historical_enrollment_intents
WHEN OLD.state IS NOT NEW.state AND NOT (OLD.state='IN_FLIGHT' AND NEW.state='REVIEW') AND NOT (OLD.state='REVIEW' AND NEW.state='VERIFIED' AND EXISTS(
 SELECT 1 FROM personal_historical_recovery_actions a JOIN personal_raw_enrollment_locks l ON l.spreadsheet_id=a.spreadsheet_id AND l.sheet_name=a.sheet_name AND l.personal_use_id=a.personal_use_id AND l.metadata_id=a.metadata_id AND l.operation_token=a.operation_token AND l.outer_token=a.outer_token AND l.state='REVIEW'
 JOIN owner_personal_transactions p ON p.personal_use_id=a.personal_use_id AND p.version=a.source_version AND p.status='CONFIRMED'
 JOIN personal_projection_source_revisions r ON r.personal_use_id=p.personal_use_id AND r.revision=a.source_revision AND r.state='TRACKED'
 JOIN personal_projection_cutovers c ON c.spreadsheet_id=a.spreadsheet_id AND c.sheet_name=a.sheet_name AND c.generation=a.cutover_generation AND c.state='ACTIVE'
 JOIN personal_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.generation=c.generation AND g.state='HOLD'
 WHERE a.spreadsheet_id=OLD.spreadsheet_id AND a.sheet_name=OLD.sheet_name AND a.personal_use_id=OLD.personal_use_id AND a.metadata_id=OLD.metadata_id AND a.source_version=OLD.source_version AND a.source_revision=OLD.source_revision AND a.source_fingerprint=OLD.source_fingerprint AND a.cutover_generation=OLD.cutover_generation AND a.operation_token=OLD.operation_token AND a.outer_token=OLD.outer_token AND a.state='APPROVED' AND a.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM personal_historical_atomic_assertions x WHERE x.assertion_id=a.action_id AND x.ok=1) AND EXISTS(SELECT 1 FROM admin_audit audit WHERE audit.action='HISTORICAL_RECOVERY_APPLIED' AND audit.entity_key=a.personal_use_id AND CASE WHEN json_valid(audit.after_json) THEN json_extract(audit.after_json,'$.actionId')=a.action_id ELSE 0 END)
)) BEGIN SELECT RAISE(ABORT,'HISTORICAL_RECOVERY_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_no_delete BEFORE DELETE ON personal_historical_recovery_actions BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_initial_state BEFORE INSERT ON personal_historical_recovery_actions WHEN NEW.state<>'APPROVED' BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_no_replace BEFORE INSERT ON personal_historical_recovery_actions WHEN EXISTS(SELECT 1 FROM personal_historical_recovery_actions a WHERE a.rowid=NEW.rowid OR a.action_id=NEW.action_id) BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_no_rowid_replace BEFORE UPDATE ON personal_historical_recovery_actions WHEN EXISTS(SELECT 1 FROM personal_historical_recovery_actions a WHERE a.rowid=NEW.rowid AND a.rowid<>OLD.rowid) BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_immutable BEFORE UPDATE OF action_id,spreadsheet_id,sheet_name,personal_use_id,metadata_id,source_version,source_revision,source_fingerprint,cutover_generation,operation_token,outer_token,evidence_digest,principal,reason,created_at,expires_at ON personal_historical_recovery_actions BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;
CREATE TRIGGER personal_historical_action_transition BEFORE UPDATE OF state ON personal_historical_recovery_actions WHEN OLD.state IS NOT NEW.state AND NOT (OLD.state='APPROVED' AND (NEW.state='CANCELLED' OR (NEW.state='APPLIED' AND OLD.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM personal_historical_atomic_assertions x WHERE x.assertion_id=OLD.action_id AND x.ok=1) AND EXISTS(SELECT 1 FROM admin_audit audit WHERE audit.action='HISTORICAL_RECOVERY_APPLIED' AND audit.entity_key=OLD.personal_use_id AND CASE WHEN json_valid(audit.after_json) THEN json_extract(audit.after_json,'$.actionId')=OLD.action_id ELSE 0 END) AND EXISTS(SELECT 1 FROM personal_historical_enrollment_intents i WHERE i.spreadsheet_id=OLD.spreadsheet_id AND i.sheet_name=OLD.sheet_name AND i.personal_use_id=OLD.personal_use_id AND i.metadata_id=OLD.metadata_id AND i.source_version=OLD.source_version AND i.source_revision=OLD.source_revision AND i.source_fingerprint=OLD.source_fingerprint AND i.cutover_generation=OLD.cutover_generation AND i.operation_token=OLD.operation_token AND i.outer_token=OLD.outer_token AND i.state='VERIFIED') AND NOT EXISTS(SELECT 1 FROM personal_raw_enrollment_locks l WHERE l.spreadsheet_id=OLD.spreadsheet_id AND l.sheet_name=OLD.sheet_name)))) BEGIN SELECT RAISE(ABORT,'HISTORICAL_AUDIT_REQUIRED'); END;

-- Preserve the original post-cutover release condition and add only the
-- separately approved historical matched-evidence recovery condition.
DROP TRIGGER personal_enrollment_lock_no_delete;
CREATE TRIGGER personal_enrollment_lock_no_delete BEFORE DELETE ON personal_raw_enrollment_locks WHEN NOT EXISTS(SELECT 1 FROM personal_historical_recovery_actions a JOIN personal_historical_enrollment_intents i ON i.spreadsheet_id=a.spreadsheet_id AND i.sheet_name=a.sheet_name AND i.personal_use_id=a.personal_use_id AND i.metadata_id=a.metadata_id AND i.source_version=a.source_version AND i.source_revision=a.source_revision AND i.source_fingerprint=a.source_fingerprint AND i.cutover_generation=a.cutover_generation AND i.operation_token=a.operation_token AND i.outer_token=a.outer_token AND i.state='VERIFIED' JOIN owner_personal_transactions p ON p.personal_use_id=i.personal_use_id AND p.version=i.source_version AND p.status='CONFIRMED' JOIN personal_projection_source_revisions r ON r.personal_use_id=p.personal_use_id AND r.state='TRACKED' AND r.revision=i.source_revision JOIN personal_projection_admissions d ON d.personal_use_id=i.personal_use_id AND d.sequence=i.admission_sequence JOIN personal_projection_cutovers c ON c.spreadsheet_id=i.spreadsheet_id AND c.sheet_name=i.sheet_name AND c.generation=i.cutover_generation AND c.admission_watermark=i.admission_watermark AND c.state='ACTIVE' JOIN personal_legacy_writer_gates g ON g.spreadsheet_id=c.spreadsheet_id AND g.sheet_name=c.sheet_name AND g.generation=c.generation AND g.state='HOLD' JOIN sheet_metadata_identity_registry m ON m.spreadsheet_id=i.spreadsheet_id AND m.sheet_name=i.sheet_name AND m.metadata_id=i.metadata_id AND m.entity_kind='PERSONAL_USE' AND m.entity_id=i.personal_use_id WHERE OLD.state='REVIEW' AND a.spreadsheet_id=OLD.spreadsheet_id AND a.sheet_name=OLD.sheet_name AND a.personal_use_id=OLD.personal_use_id AND a.metadata_id=OLD.metadata_id AND a.operation_token=OLD.operation_token AND a.outer_token=OLD.outer_token AND a.cutover_generation=OLD.cutover_generation AND a.state='APPROVED' AND a.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM personal_historical_atomic_assertions x WHERE x.assertion_id=a.action_id AND x.ok=1) AND EXISTS(SELECT 1 FROM admin_audit audit WHERE audit.action='HISTORICAL_RECOVERY_APPLIED' AND audit.entity_key=a.personal_use_id AND CASE WHEN json_valid(audit.after_json) THEN json_extract(audit.after_json,'$.actionId')=a.action_id ELSE 0 END)) AND NOT EXISTS(SELECT 1 FROM personal_enrollment_recovery_actions a JOIN personal_raw_identity_intents i ON i.spreadsheet_id=a.spreadsheet_id AND i.sheet_name=a.sheet_name AND i.personal_use_id=a.personal_use_id AND i.metadata_id=a.metadata_id AND i.state='VERIFIED' AND i.verified_outer_token=a.outer_token AND i.verified_generation=a.cutover_generation AND i.verified_evidence_digest=a.evidence_digest JOIN personal_projection_runtime_intents o ON o.spreadsheet_id=a.spreadsheet_id AND o.personal_use_id=a.personal_use_id AND o.source_version=a.source_version AND o.source_revision=a.source_revision AND o.operation_token=a.outer_token AND o.cutover_generation=a.cutover_generation AND o.state='VERIFIED' AND o.evidence_digest=a.evidence_digest WHERE a.spreadsheet_id=OLD.spreadsheet_id AND a.sheet_name=OLD.sheet_name AND a.personal_use_id=OLD.personal_use_id AND a.metadata_id=OLD.metadata_id AND a.operation_token=OLD.operation_token AND a.outer_token=OLD.outer_token AND a.cutover_generation=OLD.cutover_generation AND a.state='APPROVED' AND a.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM owner_personal_transactions p JOIN personal_projection_source_revisions r ON r.personal_use_id=p.personal_use_id AND r.state='TRACKED' AND r.revision=a.source_revision WHERE p.personal_use_id=a.personal_use_id AND p.version=a.source_version AND p.status='CONFIRMED') AND EXISTS(SELECT 1 FROM sync_jobs s WHERE s.entity_type='PERSONAL_USE' AND s.entity_key=a.personal_use_id AND s.entity_version=a.source_version AND s.status='COMPLETED') AND EXISTS(SELECT 1 FROM personal_projection_generation_jobs q WHERE q.spreadsheet_id=a.spreadsheet_id AND q.cutover_generation=a.cutover_generation AND q.personal_use_id=a.personal_use_id AND q.source_version=a.source_version AND q.source_revision=a.source_revision AND q.state='COMPLETED')) BEGIN SELECT RAISE(ABORT,'PERSONAL_ENROLLMENT_REVIEW_REQUIRED'); END;
