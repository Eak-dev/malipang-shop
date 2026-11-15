-- Dedicated, opt-in REVIEW REVOKE phases on the existing notice queue.
-- RUNNING is never re-leased or replayed.
CREATE TABLE IF NOT EXISTS continuous_revoke_review_dispatch (
 dispatch_id TEXT PRIMARY KEY,
 spreadsheet_id TEXT NOT NULL,
 operation_token TEXT NOT NULL,
 expense_id TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(source_version>1),
 transition_id TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>=0),
 state TEXT NOT NULL CHECK(state IN ('PENDING','RUNNING','DONE','HELD')),
 owner_token TEXT,
 outcome TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 UNIQUE(spreadsheet_id,operation_token,sequence),
 CHECK((state='PENDING' AND owner_token IS NULL AND outcome IS NULL) OR (state='RUNNING' AND owner_token IS NOT NULL AND outcome IS NULL) OR (state='DONE' AND owner_token IS NOT NULL AND outcome IN ('IN_PROGRESS','COMPLETE')) OR (state='HELD' AND owner_token IS NOT NULL AND outcome='PROOF_UNCERTAIN'))
);
CREATE UNIQUE INDEX IF NOT EXISTS continuous_revoke_review_dispatch_one_live ON continuous_revoke_review_dispatch(spreadsheet_id,operation_token) WHERE state IN ('PENDING','RUNNING');
CREATE TRIGGER IF NOT EXISTS continuous_revoke_review_dispatch_insert BEFORE INSERT ON continuous_revoke_review_dispatch
WHEN NEW.state<>'PENDING' OR NEW.owner_token IS NOT NULL OR NEW.outcome IS NOT NULL OR NOT EXISTS(SELECT 1 FROM continuous_revoke_review_close_activation WHERE singleton=1) OR (NEW.sequence=0 AND NOT EXISTS(SELECT 1 FROM stable_workbook_claims c JOIN stable_recovery_epochs e ON e.spreadsheet_id=c.spreadsheet_id AND e.state IN ('ARMED','REVIEW') AND e.target_type='EXPENSE' AND e.target_key=NEW.expense_id AND e.target_version=NEW.source_version JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED' JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.target_key AND j.entity_version=e.target_version AND j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) JOIN continuous_publication_intents i ON i.transition_id=NEW.transition_id AND i.spreadsheet_id=c.spreadsheet_id AND i.claim_token=c.operation_token AND i.entity_id=e.target_key AND i.source_version=e.target_version AND i.kind='REVOKE' AND i.state IN ('IN_FLIGHT','VERIFIED') WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.operation_token=NEW.operation_token AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||NEW.expense_id||':'||NEW.source_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES') AND c.state='REVIEW' AND (c.phase='OPERATION' OR (c.phase IS NULL AND c.review_reason='CONTINUOUS_SYNC_LEASE_EXPIRED_UNCERTAIN')))) OR (NEW.sequence>0 AND NOT EXISTS(SELECT 1 FROM continuous_revoke_review_dispatch prev WHERE prev.spreadsheet_id=NEW.spreadsheet_id AND prev.operation_token=NEW.operation_token AND prev.expense_id=NEW.expense_id AND prev.source_version=NEW.source_version AND prev.transition_id=NEW.transition_id AND prev.sequence=NEW.sequence-1 AND prev.state='DONE' AND prev.outcome='IN_PROGRESS'))
BEGIN SELECT RAISE(ABORT,'revoke review dispatch requires exact previous phase'); END;
CREATE TRIGGER IF NOT EXISTS continuous_revoke_review_dispatch_transition BEFORE UPDATE ON continuous_revoke_review_dispatch
WHEN NEW.dispatch_id IS NOT OLD.dispatch_id OR NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.operation_token IS NOT OLD.operation_token OR NEW.expense_id IS NOT OLD.expense_id OR NEW.source_version IS NOT OLD.source_version OR NEW.transition_id IS NOT OLD.transition_id OR NEW.sequence IS NOT OLD.sequence OR NEW.created_at IS NOT OLD.created_at OR NOT ((OLD.state='PENDING' AND NEW.state='RUNNING' AND NEW.owner_token IS NOT NULL AND NEW.outcome IS NULL) OR (OLD.state='RUNNING' AND NEW.owner_token IS OLD.owner_token AND ((NEW.state='DONE' AND NEW.outcome IN ('IN_PROGRESS','COMPLETE')) OR (NEW.state='HELD' AND NEW.outcome='PROOF_UNCERTAIN'))))
BEGIN SELECT RAISE(ABORT,'revoke review dispatch transition invalid'); END;
CREATE TRIGGER IF NOT EXISTS continuous_revoke_review_dispatch_no_delete BEFORE DELETE ON continuous_revoke_review_dispatch BEGIN SELECT RAISE(ABORT,'revoke review dispatch retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_revoke_review_dispatch_no_replace BEFORE INSERT ON continuous_revoke_review_dispatch WHEN EXISTS(SELECT 1 FROM continuous_revoke_review_dispatch d WHERE d.dispatch_id=NEW.dispatch_id OR d.rowid=NEW.rowid OR (d.spreadsheet_id=NEW.spreadsheet_id AND d.operation_token=NEW.operation_token AND d.sequence=NEW.sequence)) BEGIN SELECT RAISE(ABORT,'revoke review dispatch collision'); END;
CREATE TRIGGER IF NOT EXISTS continuous_revoke_review_terminal_evidence_fence BEFORE INSERT ON continuous_publication_review_evidence
WHEN EXISTS(SELECT 1 FROM continuous_revoke_review_close_activation WHERE singleton=1) AND EXISTS(SELECT 1 FROM continuous_publication_intents i JOIN failed_jobs f ON f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||i.entity_id||':'||i.source_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES' WHERE i.transition_id=NEW.transition_id AND i.kind='REVOKE')
BEGIN SELECT RAISE(ABORT,'revoke review terminal requires reconciliation'); END;
