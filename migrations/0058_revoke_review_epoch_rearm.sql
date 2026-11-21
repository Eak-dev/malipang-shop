-- Candidate positive-only rearm of the exact recovered REVOKE epoch.
-- No activation row is inserted by this migration.
CREATE TABLE IF NOT EXISTS continuous_revoke_review_epoch_rearm (
 epoch_id TEXT PRIMARY KEY,
 spreadsheet_id TEXT NOT NULL,
 operation_token TEXT NOT NULL,
 transition_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(source_revision>=0),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS continuous_revoke_review_epoch_rearm_insert BEFORE INSERT ON continuous_revoke_review_epoch_rearm
WHEN NOT EXISTS(SELECT 1 FROM stable_recovery_epochs e JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=NEW.operation_token AND o.state='ADMITTED' JOIN stable_workbook_claims c ON c.spreadsheet_id=e.spreadsheet_id AND c.operation_token=o.operation_token AND c.state='REVIEW' AND c.phase='OPERATION' JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.target_key AND j.entity_version=e.target_version AND j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) JOIN expense_events src ON src.expense_id=j.entity_key AND src.version=j.entity_version AND src.status='CANCELLED' JOIN continuous_publication_intents i ON i.transition_id=NEW.transition_id AND i.spreadsheet_id=e.spreadsheet_id AND i.entity_id=e.target_key AND i.source_version=e.target_version AND i.claim_token=c.operation_token AND i.kind='REVOKE' AND i.state='VERIFIED' AND i.source_digest=NEW.source_digest JOIN continuous_publication_markers m ON m.spreadsheet_id=i.spreadsheet_id AND m.entity_id=i.entity_id AND m.sheet_id=i.sheet_id AND m.sheet_name=i.sheet_name AND m.row_number=i.row_number AND m.transition_id=i.transition_id AND m.version=i.source_version AND m.marker=i.after_value AND m.state='REVOKED' JOIN continuous_publication_review_evidence p ON p.transition_id=i.transition_id AND p.source_digest=i.source_digest JOIN stable_source_revision r ON r.singleton=1 AND r.revision=NEW.source_revision JOIN continuous_revoke_review_close_activation a ON a.singleton=1 WHERE e.epoch_id=NEW.epoch_id AND e.spreadsheet_id=NEW.spreadsheet_id AND e.state='REVIEW' AND e.target_type='EXPENSE' AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||e.target_key||':'||e.target_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES'))
BEGIN SELECT RAISE(ABORT,'revoke epoch rearm requires exact review evidence'); END;
CREATE TRIGGER IF NOT EXISTS continuous_revoke_review_epoch_rearm_no_update BEFORE UPDATE ON continuous_revoke_review_epoch_rearm BEGIN SELECT RAISE(ABORT,'revoke epoch rearm evidence immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_revoke_review_epoch_rearm_no_delete BEFORE DELETE ON continuous_revoke_review_epoch_rearm BEGIN SELECT RAISE(ABORT,'revoke epoch rearm evidence retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_revoke_review_epoch_rearm_no_replace BEFORE INSERT ON continuous_revoke_review_epoch_rearm WHEN EXISTS(SELECT 1 FROM continuous_revoke_review_epoch_rearm WHERE epoch_id=NEW.epoch_id OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'revoke epoch rearm evidence collision'); END;
DROP TRIGGER IF EXISTS stable_recovery_epoch_transition;
CREATE TRIGGER IF NOT EXISTS stable_recovery_epoch_transition
 BEFORE UPDATE ON stable_recovery_epochs
 WHEN NEW.epoch_id IS NOT OLD.epoch_id
   OR NEW.spreadsheet_id IS NOT OLD.spreadsheet_id
   OR NEW.target_type IS NOT OLD.target_type
   OR NEW.target_key IS NOT OLD.target_key
   OR NEW.target_version IS NOT OLD.target_version
   OR NEW.created_at IS NOT OLD.created_at
   OR NOT ((OLD.state='ARMED' AND NEW.state IN ('COMPLETE','REVIEW'))
         OR (OLD.state IN ('COMPLETE','REVIEW') AND NEW.state='CLOSED')
         OR (OLD.state='REVIEW' AND NEW.state='ARMED' AND EXISTS(SELECT 1 FROM continuous_revoke_review_epoch_rearm proof JOIN stable_source_revision r ON r.singleton=1 AND r.revision=proof.source_revision JOIN stable_workbook_claims c ON c.spreadsheet_id=OLD.spreadsheet_id AND c.operation_token=proof.operation_token AND c.state='REVIEW' AND c.phase='OPERATION' JOIN stable_recovery_operations o ON o.epoch_id=OLD.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED' JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=OLD.target_key AND j.entity_version=OLD.target_version AND j.status='REVIEW' WHERE proof.epoch_id=OLD.epoch_id AND proof.spreadsheet_id=OLD.spreadsheet_id)))
 BEGIN SELECT RAISE(ABORT,'recovery epoch immutable or invalid transition'); END;

