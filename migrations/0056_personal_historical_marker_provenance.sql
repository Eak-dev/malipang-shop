-- Candidate only. A durable pre-send search and a validated Google ACK are
-- distinct evidence. Neither replaces writer drainage or Google CAS.
CREATE TABLE personal_historical_marker_provenance (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  personal_use_id TEXT NOT NULL,
  metadata_id INTEGER NOT NULL CHECK(metadata_id BETWEEN 1 AND 2147483647),
  source_version INTEGER NOT NULL CHECK(source_version>0),
  source_revision INTEGER NOT NULL CHECK(source_revision>0),
  source_fingerprint TEXT NOT NULL CHECK(length(source_fingerprint)=64 AND source_fingerprint NOT GLOB '*[^0-9a-f]*'),
  cutover_generation TEXT NOT NULL,
  operation_token TEXT NOT NULL,
  outer_token TEXT NOT NULL,
  pre_search_digest TEXT NOT NULL CHECK(length(pre_search_digest)=64 AND pre_search_digest NOT GLOB '*[^0-9a-f]*'),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','ACKNOWLEDGED')),
  ack_digest TEXT,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  PRIMARY KEY(spreadsheet_id,sheet_name,personal_use_id),
  UNIQUE(spreadsheet_id,metadata_id),
  CHECK((state='PREPARED' AND ack_digest IS NULL AND acknowledged_at IS NULL) OR (state='ACKNOWLEDGED' AND ack_digest IS NOT NULL AND length(ack_digest)=64 AND ack_digest NOT GLOB '*[^0-9a-f]*' AND acknowledged_at IS NOT NULL))
);
CREATE TRIGGER historical_provenance_validate BEFORE INSERT ON personal_historical_marker_provenance
WHEN NEW.state<>'PREPARED' OR NOT EXISTS(SELECT 1 FROM personal_historical_enrollment_intents i JOIN personal_raw_enrollment_locks l ON l.spreadsheet_id=i.spreadsheet_id AND l.sheet_name=i.sheet_name AND l.personal_use_id=i.personal_use_id AND l.metadata_id=i.metadata_id AND l.operation_token=i.operation_token AND l.outer_token=i.outer_token AND l.cutover_generation=i.cutover_generation AND l.state='HELD' JOIN sheet_metadata_identity_registry m ON m.spreadsheet_id=i.spreadsheet_id AND m.metadata_id=i.metadata_id AND m.sheet_name=i.sheet_name AND m.entity_kind='PERSONAL_USE' AND m.entity_id=i.personal_use_id WHERE i.spreadsheet_id=NEW.spreadsheet_id AND i.sheet_name=NEW.sheet_name AND i.personal_use_id=NEW.personal_use_id AND i.metadata_id=NEW.metadata_id AND i.source_version=NEW.source_version AND i.source_revision=NEW.source_revision AND i.source_fingerprint=NEW.source_fingerprint AND i.cutover_generation=NEW.cutover_generation AND i.operation_token=NEW.operation_token AND i.outer_token=NEW.outer_token AND i.state='IN_FLIGHT')
BEGIN SELECT RAISE(ABORT,'HISTORICAL_PROVENANCE_INVALID'); END;
CREATE TRIGGER historical_provenance_no_delete BEFORE DELETE ON personal_historical_marker_provenance BEGIN SELECT RAISE(ABORT,'HISTORICAL_PROVENANCE_IMMUTABLE'); END;
CREATE TRIGGER historical_provenance_no_replace BEFORE INSERT ON personal_historical_marker_provenance WHEN EXISTS(SELECT 1 FROM personal_historical_marker_provenance p WHERE p.rowid=NEW.rowid OR (p.spreadsheet_id=NEW.spreadsheet_id AND (p.metadata_id=NEW.metadata_id OR (p.sheet_name=NEW.sheet_name AND p.personal_use_id=NEW.personal_use_id)))) BEGIN SELECT RAISE(ABORT,'HISTORICAL_PROVENANCE_IMMUTABLE'); END;
CREATE TRIGGER historical_provenance_no_rowid_replace BEFORE UPDATE ON personal_historical_marker_provenance WHEN EXISTS(SELECT 1 FROM personal_historical_marker_provenance p WHERE p.rowid=NEW.rowid AND p.rowid<>OLD.rowid) BEGIN SELECT RAISE(ABORT,'HISTORICAL_PROVENANCE_IMMUTABLE'); END;
CREATE TRIGGER historical_provenance_immutable BEFORE UPDATE OF spreadsheet_id,sheet_name,personal_use_id,metadata_id,source_version,source_revision,source_fingerprint,cutover_generation,operation_token,outer_token,pre_search_digest,created_at ON personal_historical_marker_provenance BEGIN SELECT RAISE(ABORT,'HISTORICAL_PROVENANCE_IMMUTABLE'); END;
CREATE TRIGGER historical_provenance_transition BEFORE UPDATE OF state,ack_digest,acknowledged_at ON personal_historical_marker_provenance
WHEN NOT (OLD.state='PREPARED' AND NEW.state='ACKNOWLEDGED' AND OLD.ack_digest IS NULL AND OLD.acknowledged_at IS NULL AND NEW.ack_digest IS NOT NULL AND length(NEW.acknowledged_at)=24 AND strftime('%Y-%m-%dT%H:%M:%fZ',NEW.acknowledged_at) IS NEW.acknowledged_at AND abs((julianday(NEW.acknowledged_at)-julianday('now'))*86400)<=60 AND EXISTS(SELECT 1 FROM personal_historical_enrollment_intents i JOIN personal_raw_enrollment_locks l ON l.spreadsheet_id=i.spreadsheet_id AND l.sheet_name=i.sheet_name AND l.personal_use_id=i.personal_use_id AND l.metadata_id=i.metadata_id AND l.operation_token=i.operation_token AND l.outer_token=i.outer_token AND l.cutover_generation=i.cutover_generation AND l.state='HELD' JOIN owner_personal_transactions p ON p.personal_use_id=i.personal_use_id AND p.version=i.source_version AND p.status='CONFIRMED' JOIN personal_projection_source_revisions r ON r.personal_use_id=p.personal_use_id AND r.state='TRACKED' AND r.revision=i.source_revision WHERE i.spreadsheet_id=OLD.spreadsheet_id AND i.sheet_name=OLD.sheet_name AND i.personal_use_id=OLD.personal_use_id AND i.metadata_id=OLD.metadata_id AND i.source_version=OLD.source_version AND i.source_revision=OLD.source_revision AND i.source_fingerprint=OLD.source_fingerprint AND i.cutover_generation=OLD.cutover_generation AND i.operation_token=OLD.operation_token AND i.outer_token=OLD.outer_token AND i.state='IN_FLIGHT'))
BEGIN SELECT RAISE(ABORT,'HISTORICAL_PROVENANCE_INVALID'); END;
