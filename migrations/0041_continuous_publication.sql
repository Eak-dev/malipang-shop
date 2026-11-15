-- Draft-only infrastructure. A marker is a single Google Sheets cell. A
-- missing/mismatched response does not authorize replay or publication.
-- This binds configuration only; activation additionally requires a
-- separately journaled provider bootstrap and formula/cutover verification.
CREATE TABLE IF NOT EXISTS continuous_publication_targets (
 spreadsheet_id TEXT PRIMARY KEY,
 sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
 sheet_name TEXT NOT NULL CHECK(length(sheet_name)>0),
 row_count INTEGER NOT NULL CHECK(row_count BETWEEN 2 AND 5000),
 bootstrap_digest TEXT NOT NULL CHECK(length(bootstrap_digest)=64 AND bootstrap_digest NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS continuous_publication_target_insert
 BEFORE INSERT ON continuous_publication_targets WHEN NOT EXISTS(SELECT 1 FROM continuous_daily_cutovers c WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.state='ACTIVE' AND NEW.sheet_id NOT IN (c.legacy_sheet_id,c.continuous_sheet_id,c.raw_sheet_id,c.detail_sheet_id) AND NEW.sheet_name NOT IN (c.legacy_sheet_name,c.continuous_sheet_name,c.raw_sheet_name,c.detail_sheet_name)) OR (SELECT count(*) FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=NEW.spreadsheet_id AND a.stage IN ('VIEWS','DAILY_J','REPORTS') AND a.state='VERIFIED')<>3
 BEGIN SELECT RAISE(ABORT,'publication target requires cutover'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_target_no_update BEFORE UPDATE ON continuous_publication_targets BEGIN SELECT RAISE(ABORT,'publication target immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_target_no_delete BEFORE DELETE ON continuous_publication_targets BEGIN SELECT RAISE(ABORT,'publication target immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_target_no_replace BEFORE INSERT ON continuous_publication_targets WHEN EXISTS(SELECT 1 FROM continuous_publication_targets WHERE spreadsheet_id=NEW.spreadsheet_id OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'publication target collision'); END;
CREATE TABLE IF NOT EXISTS continuous_publication_intents (
 transition_id TEXT PRIMARY KEY CHECK(length(transition_id) BETWEEN 8 AND 128),
 spreadsheet_id TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
 sheet_name TEXT NOT NULL CHECK(length(sheet_name)>0),
 row_number INTEGER NOT NULL CHECK(row_number BETWEEN 2 AND 5000),
 kind TEXT NOT NULL CHECK(kind IN ('STAGE','PUBLISH','REVOKE')),
 source_version INTEGER NOT NULL CHECK(source_version>=1),
 source_revision INTEGER NOT NULL CHECK(source_revision>=0),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
 claim_token TEXT NOT NULL CHECK(length(claim_token)>=8),
 lease_token TEXT NOT NULL CHECK(length(lease_token)>=8),
 before_state TEXT NOT NULL CHECK(before_state IN ('EMPTY','STAGED','PUBLISHED')),
 before_nonce TEXT NOT NULL CHECK(length(before_nonce)=32 AND before_nonce NOT GLOB '*[^0-9a-f]*'),
 after_nonce TEXT NOT NULL CHECK(length(after_nonce)=32 AND after_nonce NOT GLOB '*[^0-9a-f]*' AND after_nonce<>before_nonce),
 detail_count INTEGER NOT NULL CHECK(detail_count BETWEEN 0 AND 500),
 before_value TEXT NOT NULL,
 after_value TEXT NOT NULL CHECK(after_value<>before_value),
 state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','VERIFIED','REVIEW')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK((kind='STAGE' AND before_state='EMPTY' AND before_value='PUB0_'||row_number||'_'||before_nonce) OR
       (kind='PUBLISH' AND before_state='STAGED' AND before_value='PUB1␟MALIPANG_EXPENSE:'||entity_id||'␟'||source_version||'␟'||before_nonce||'␟STAGED␟'||detail_count) OR
       (kind='REVOKE' AND source_version>1 AND before_state IN ('STAGED','PUBLISHED') AND before_value='PUB1␟MALIPANG_EXPENSE:'||entity_id||'␟'||(source_version-1)||'␟'||before_nonce||'␟'||before_state||'␟'||detail_count)),
 CHECK(after_value='PUB1␟MALIPANG_EXPENSE:'||entity_id||'␟'||source_version||'␟'||after_nonce||'␟'||CASE kind WHEN 'STAGE' THEN 'STAGED' WHEN 'PUBLISH' THEN 'PUBLISHED' ELSE 'REVOKED' END||'␟'||detail_count)
);
CREATE UNIQUE INDEX IF NOT EXISTS continuous_publication_one_unsettled
 ON continuous_publication_intents(spreadsheet_id,entity_id) WHERE state IN ('IN_FLIGHT','REVIEW');
CREATE TRIGGER IF NOT EXISTS continuous_publication_intent_insert
 BEFORE INSERT ON continuous_publication_intents
 WHEN NEW.state<>'IN_FLIGHT' OR NOT EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=NEW.source_revision) OR NOT EXISTS(
  SELECT 1 FROM stable_workbook_claims c JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=NEW.entity_id AND j.entity_version=NEW.source_version
  JOIN expense_events e ON e.expense_id=j.entity_key AND e.version=j.entity_version
  WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.operation_token=NEW.claim_token AND c.state='HELD'
   AND j.status='PROCESSING' AND j.lease_token=NEW.lease_token AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
   AND ((NEW.kind IN ('STAGE','PUBLISH') AND e.status='CONFIRMED') OR (NEW.kind='REVOKE' AND e.status='CANCELLED')))
  OR (NEW.kind='STAGE' AND EXISTS(SELECT 1 FROM continuous_publication_markers p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND (p.entity_id=NEW.entity_id OR (p.sheet_id=NEW.sheet_id AND p.row_number=NEW.row_number))))
  OR (NEW.kind IN ('PUBLISH','REVOKE') AND NOT EXISTS(SELECT 1 FROM continuous_publication_markers p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_id=NEW.entity_id AND p.sheet_id=NEW.sheet_id AND p.sheet_name=NEW.sheet_name AND p.row_number=NEW.row_number AND p.state=NEW.before_state AND p.marker=NEW.before_value AND p.version=CASE NEW.kind WHEN 'PUBLISH' THEN NEW.source_version ELSE NEW.source_version-1 END))
 BEGIN SELECT RAISE(ABORT,'publication requires owned live claim'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_intent_no_delete
 BEFORE DELETE ON continuous_publication_intents BEGIN SELECT RAISE(ABORT,'publication intent retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_intent_no_replace
 BEFORE INSERT ON continuous_publication_intents WHEN EXISTS(SELECT 1 FROM continuous_publication_intents WHERE rowid=NEW.rowid OR transition_id=NEW.transition_id)
 BEGIN SELECT RAISE(ABORT,'publication intent collision'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_intent_transition
 BEFORE UPDATE ON continuous_publication_intents WHEN OLD.rowid IS NOT NEW.rowid OR OLD.transition_id IS NOT NEW.transition_id OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.entity_id IS NOT NEW.entity_id OR OLD.sheet_id IS NOT NEW.sheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR OLD.row_number IS NOT NEW.row_number OR OLD.kind IS NOT NEW.kind OR OLD.source_version IS NOT NEW.source_version OR OLD.source_revision IS NOT NEW.source_revision OR OLD.source_digest IS NOT NEW.source_digest OR OLD.claim_token IS NOT NEW.claim_token OR OLD.lease_token IS NOT NEW.lease_token OR OLD.before_state IS NOT NEW.before_state OR OLD.before_nonce IS NOT NEW.before_nonce OR OLD.after_nonce IS NOT NEW.after_nonce OR OLD.detail_count IS NOT NEW.detail_count OR OLD.before_value IS NOT NEW.before_value OR OLD.after_value IS NOT NEW.after_value OR OLD.created_at IS NOT NEW.created_at OR OLD.state<>'IN_FLIGHT' OR NEW.state NOT IN ('VERIFIED','REVIEW')
 BEGIN SELECT RAISE(ABORT,'publication intent transition invalid'); END;
-- A positive REVIEW recovery may see unrelated source changes after the
-- original intent. The caller must re-read and hash the exact target source;
-- this immutable evidence binds that hash to the current global revision in
-- the same transaction that confirms the provider postimage.
CREATE TABLE IF NOT EXISTS continuous_publication_review_evidence (
 transition_id TEXT PRIMARY KEY REFERENCES continuous_publication_intents(transition_id),
 source_revision INTEGER NOT NULL CHECK(source_revision>=0),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS continuous_publication_review_evidence_insert BEFORE INSERT ON continuous_publication_review_evidence
 WHEN NOT EXISTS(SELECT 1 FROM continuous_publication_intents i JOIN stable_source_revision r ON r.singleton=1 AND r.revision=NEW.source_revision JOIN stable_workbook_claims c ON c.spreadsheet_id=i.spreadsheet_id AND c.operation_token=i.claim_token AND c.state='REVIEW' AND c.phase='OPERATION' JOIN stable_recovery_epochs epoch ON epoch.spreadsheet_id=c.spreadsheet_id AND epoch.state IN ('ARMED','REVIEW') AND epoch.target_type='EXPENSE' AND epoch.target_key=i.entity_id AND epoch.target_version=i.source_version JOIN stable_recovery_operations op ON op.epoch_id=epoch.epoch_id AND op.operation_token=c.operation_token AND op.state='ADMITTED' JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=i.entity_id AND j.entity_version=i.source_version AND j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE i.transition_id=NEW.transition_id AND i.source_digest=NEW.source_digest AND i.state='IN_FLIGHT')
 BEGIN SELECT RAISE(ABORT,'publication recovery evidence requires review'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_review_evidence_no_update BEFORE UPDATE ON continuous_publication_review_evidence BEGIN SELECT RAISE(ABORT,'publication recovery evidence immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_review_evidence_no_delete BEFORE DELETE ON continuous_publication_review_evidence BEGIN SELECT RAISE(ABORT,'publication recovery evidence immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_review_evidence_no_replace BEFORE INSERT ON continuous_publication_review_evidence WHEN EXISTS(SELECT 1 FROM continuous_publication_review_evidence WHERE transition_id=NEW.transition_id OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'publication recovery evidence collision'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_verify_guard
 BEFORE UPDATE OF state ON continuous_publication_intents
 WHEN NEW.state='VERIFIED' AND (
  (NOT EXISTS(SELECT 1 FROM stable_source_revision r JOIN stable_workbook_claims c ON r.singleton=1 AND r.revision=NEW.source_revision JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=NEW.entity_id AND j.entity_version=NEW.source_version JOIN expense_events e ON e.expense_id=j.entity_key AND e.version=j.entity_version
   WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.operation_token=NEW.claim_token AND c.state='HELD' AND j.status='PROCESSING' AND j.lease_token=NEW.lease_token AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ((NEW.kind IN ('STAGE','PUBLISH') AND e.status='CONFIRMED') OR (NEW.kind='REVOKE' AND e.status='CANCELLED')))
   AND NOT EXISTS(SELECT 1 FROM continuous_publication_review_evidence proof JOIN stable_source_revision r ON r.singleton=1 AND r.revision=proof.source_revision JOIN stable_workbook_claims c ON 1=1 JOIN stable_recovery_epochs epoch ON epoch.spreadsheet_id=c.spreadsheet_id AND epoch.target_type='EXPENSE' AND epoch.target_key=NEW.entity_id AND epoch.target_version=NEW.source_version AND epoch.state IN ('ARMED','REVIEW') JOIN stable_recovery_operations op ON op.epoch_id=epoch.epoch_id AND op.operation_token=c.operation_token AND op.state='ADMITTED' JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=NEW.entity_id AND j.entity_version=NEW.source_version JOIN expense_events e ON e.expense_id=j.entity_key AND e.version=j.entity_version
    WHERE proof.transition_id=NEW.transition_id AND proof.source_digest=NEW.source_digest AND c.spreadsheet_id=NEW.spreadsheet_id AND c.operation_token=NEW.claim_token AND c.state='REVIEW' AND c.phase='OPERATION' AND length(c.notice_stamp)>0 AND length(c.notice_identity)>0 AND j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND ((NEW.kind IN ('STAGE','PUBLISH') AND e.status='CONFIRMED') OR (NEW.kind='REVOKE' AND e.status='CANCELLED'))))
  OR (NEW.kind='PUBLISH' AND (
   (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=NEW.entity_id AND p.projection IN ('DAILY','EXPENSE_RAW') AND p.source_version=NEW.source_version AND p.source_digest=NEW.source_digest AND p.state='VERIFIED')<>2
   OR (SELECT count(*) FROM expense_document_items item WHERE item.expense_id=NEW.entity_id)<>NEW.detail_count
   OR EXISTS(SELECT 1 FROM expense_document_items item WHERE item.expense_id=NEW.entity_id AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=NEW.entity_id||'|'||item.item_id AND p.projection='DETAIL' AND p.source_version=NEW.source_version AND p.source_digest=NEW.source_digest AND p.state='VERIFIED'))
   OR EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_type='EXPENSE' AND p.projection='DETAIL' AND substr(p.entity_id,1,length(NEW.entity_id)+1)=NEW.entity_id||'|' AND NOT EXISTS(SELECT 1 FROM expense_document_items item WHERE item.expense_id=NEW.entity_id AND p.entity_id=NEW.entity_id||'|'||item.item_id))
  ))
 )
 BEGIN SELECT RAISE(ABORT,'publication verified without complete source and projections'); END;

-- Current marker is advanced only after the corresponding exact provider
-- value has been positively read back and its intent was verified.
CREATE TABLE IF NOT EXISTS continuous_publication_markers (
 spreadsheet_id TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
 sheet_name TEXT NOT NULL CHECK(length(sheet_name)>0),
 row_number INTEGER NOT NULL CHECK(row_number BETWEEN 2 AND 5000),
 version INTEGER NOT NULL CHECK(version>=1),
 state TEXT NOT NULL CHECK(state IN ('STAGED','PUBLISHED','REVOKED')),
 marker TEXT NOT NULL,
 transition_id TEXT NOT NULL REFERENCES continuous_publication_intents(transition_id),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(spreadsheet_id,entity_id),
 UNIQUE(spreadsheet_id,sheet_id,row_number)
);
CREATE TRIGGER IF NOT EXISTS continuous_publication_marker_insert
 BEFORE INSERT ON continuous_publication_markers
 WHEN NEW.state<>'STAGED' OR NOT EXISTS(SELECT 1 FROM continuous_publication_intents i WHERE i.transition_id=NEW.transition_id AND i.spreadsheet_id=NEW.spreadsheet_id AND i.entity_id=NEW.entity_id AND i.sheet_id=NEW.sheet_id AND i.sheet_name=NEW.sheet_name AND i.row_number=NEW.row_number AND i.kind='STAGE' AND i.source_version=NEW.version AND i.after_value=NEW.marker AND i.state='VERIFIED')
 BEGIN SELECT RAISE(ABORT,'publication marker requires verified stage'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_marker_no_delete
 BEFORE DELETE ON continuous_publication_markers BEGIN SELECT RAISE(ABORT,'publication marker retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_marker_no_replace
 BEFORE INSERT ON continuous_publication_markers WHEN EXISTS(SELECT 1 FROM continuous_publication_markers WHERE rowid=NEW.rowid OR (spreadsheet_id=NEW.spreadsheet_id AND entity_id=NEW.entity_id))
 BEGIN SELECT RAISE(ABORT,'publication marker collision'); END;
CREATE TRIGGER IF NOT EXISTS continuous_publication_marker_transition
 BEFORE UPDATE ON continuous_publication_markers
 WHEN OLD.rowid IS NOT NEW.rowid OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.entity_id IS NOT NEW.entity_id OR OLD.sheet_id IS NOT NEW.sheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR OLD.row_number IS NOT NEW.row_number OR OLD.created_at IS NOT NEW.created_at OR NOT (
  OLD.state='STAGED' AND NEW.state='PUBLISHED' AND NEW.version=OLD.version OR
  OLD.state IN ('STAGED','PUBLISHED') AND NEW.state='REVOKED' AND NEW.version=OLD.version+1)
 OR NOT EXISTS(SELECT 1 FROM continuous_publication_intents i WHERE i.transition_id=NEW.transition_id AND i.spreadsheet_id=OLD.spreadsheet_id AND i.entity_id=OLD.entity_id AND i.sheet_id=OLD.sheet_id AND i.sheet_name=OLD.sheet_name AND i.row_number=OLD.row_number AND i.kind=CASE NEW.state WHEN 'PUBLISHED' THEN 'PUBLISH' ELSE 'REVOKE' END AND i.source_version=NEW.version AND i.before_value=OLD.marker AND i.after_value=NEW.marker AND i.state='VERIFIED')
 BEGIN SELECT RAISE(ABORT,'publication marker transition invalid'); END;
