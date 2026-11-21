-- One retained, positively verified synthetic Canary completion incident.
-- Ambiguous provider writes remain IN_FLIGHT and cannot be retried.
CREATE TABLE IF NOT EXISTS canary_completed_recovery (
 spreadsheet_id TEXT PRIMARY KEY,
 operation_token TEXT NOT NULL UNIQUE,
 epoch_id TEXT NOT NULL,
 expense_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer' AND source_revision>=0),
 paused_stamp TEXT NOT NULL CHECK(length(paused_stamp)>0),
 notice_identity TEXT NOT NULL CHECK(length(notice_identity)>0),
 next_stamp TEXT NOT NULL CHECK(length(next_stamp)>32 AND next_stamp<>paused_stamp),
 ready_status TEXT NOT NULL CHECK(ready_status IN ('พร้อมแก้ไข','พร้อมแก้ไข • มีรายการรอตรวจ')),
 style_digest TEXT NOT NULL CHECK(length(style_digest)=64 AND style_digest NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('TIME_IN_FLIGHT','TIME_ACKED','STATUS_IN_FLIGHT','STATUS_ACKED','COMPLETE')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(epoch_id) REFERENCES stable_recovery_epochs(epoch_id)
);
CREATE TRIGGER IF NOT EXISTS canary_completed_recovery_insert BEFORE INSERT ON canary_completed_recovery
WHEN NEW.state<>'TIME_IN_FLIGHT' OR NEW.expense_id NOT GLOB 'exp_canary_*'
 OR NOT EXISTS(SELECT 1 FROM continuous_canary_operator c
  JOIN expense_events e ON e.expense_id=c.expense_id AND e.status='CONFIRMED' AND e.version=1
  JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=1 AND j.status='COMPLETED' AND j.lease_token IS NULL AND j.lease_until IS NULL
  JOIN stable_workbook_claims w ON w.spreadsheet_id=c.spreadsheet_id AND w.operation_token=NEW.operation_token AND w.state='REVIEW' AND w.phase='OPERATION' AND w.review_reason='STABLE_EXPENSE_COMPLETION_UNCERTAIN'
  JOIN stable_recovery_epochs ep ON ep.spreadsheet_id=c.spreadsheet_id AND ep.epoch_id=NEW.epoch_id AND ep.state='ARMED' AND ep.target_type='EXPENSE' AND ep.target_key=e.expense_id AND ep.target_version=1
  JOIN stable_recovery_operations o ON o.epoch_id=ep.epoch_id AND o.operation_token=w.operation_token AND o.state='ADMITTED'
  JOIN stable_source_revision r ON r.singleton=1 AND r.revision=NEW.source_revision
  WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.expense_id=NEW.expense_id AND c.state='ARMED_CONFIRM' AND c.duplicate_epoch_id IS NULL
   AND e.description='[SYSTEM TEST] Synthetic expense - cancel after verification' AND e.amount_satang=100 AND e.trace_id=c.trace_id AND e.line_user_id=c.line_user_id
   AND w.notice_stamp=NEW.paused_stamp AND w.notice_identity=NEW.notice_identity
   AND EXISTS(SELECT 1 FROM sync_alert_incidents a WHERE a.kind='JOB' AND a.source_id=j.job_id AND a.state='CLOSED' AND a.closed_at=j.updated_at)
   AND (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=c.spreadsheet_id AND p.entity_type='EXPENSE' AND p.source_version=1 AND p.state='VERIFIED' AND ((p.entity_id=c.expense_id AND p.projection IN ('DAILY','EXPENSE_RAW')) OR (p.entity_id=c.expense_id||'|'||c.item_id AND p.projection='DETAIL')))=3
   AND NOT EXISTS(SELECT 1 FROM sync_jobs other WHERE other.entity_type='EXPENSE' AND other.entity_key=c.expense_id AND other.entity_version<>1))
 OR (SELECT count(*) FROM continuous_canary_operator)<>1 OR (SELECT count(*) FROM stable_workbook_claims)<>1
 OR (SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW'))<>1 OR (SELECT count(*) FROM stable_recovery_operations WHERE state='ADMITTED')<>1
 OR EXISTS(SELECT 1 FROM sync_jobs WHERE status='PROCESSING') OR EXISTS(SELECT 1 FROM staff_config_sync_outbox WHERE status='PROCESSING')
 OR EXISTS(SELECT 1 FROM stable_projection_writes WHERE state<>'VERIFIED') OR EXISTS(SELECT 1 FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED')
 OR EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||NEW.expense_id||':1' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')
BEGIN SELECT RAISE(ABORT,'completed Canary recovery preimage rejected'); END;
CREATE TRIGGER IF NOT EXISTS canary_completed_recovery_transition BEFORE UPDATE ON canary_completed_recovery
WHEN NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.operation_token IS NOT OLD.operation_token OR NEW.epoch_id IS NOT OLD.epoch_id OR NEW.expense_id IS NOT OLD.expense_id OR NEW.source_revision IS NOT OLD.source_revision OR NEW.paused_stamp IS NOT OLD.paused_stamp OR NEW.notice_identity IS NOT OLD.notice_identity OR NEW.next_stamp IS NOT OLD.next_stamp OR NEW.ready_status IS NOT OLD.ready_status OR NEW.style_digest IS NOT OLD.style_digest OR NEW.created_at IS NOT OLD.created_at
 OR (NEW.state='COMPLETE' AND (EXISTS(SELECT 1 FROM stable_workbook_claims w WHERE w.spreadsheet_id=NEW.spreadsheet_id AND w.operation_token=NEW.operation_token) OR NOT EXISTS(SELECT 1 FROM stable_recovery_epochs e JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id WHERE e.epoch_id=NEW.epoch_id AND e.spreadsheet_id=NEW.spreadsheet_id AND e.state='COMPLETE' AND o.operation_token=NEW.operation_token AND o.state='VERIFIED')))
 OR NOT (OLD.state='TIME_IN_FLIGHT' AND NEW.state='TIME_ACKED' OR OLD.state='TIME_ACKED' AND NEW.state='STATUS_IN_FLIGHT' OR OLD.state='STATUS_IN_FLIGHT' AND NEW.state='STATUS_ACKED' OR OLD.state='STATUS_ACKED' AND NEW.state='COMPLETE')
BEGIN SELECT RAISE(ABORT,'completed Canary recovery transition rejected'); END;
CREATE TRIGGER IF NOT EXISTS canary_completed_recovery_no_delete BEFORE DELETE ON canary_completed_recovery BEGIN SELECT RAISE(ABORT,'completed Canary recovery retained'); END;
CREATE TRIGGER IF NOT EXISTS canary_completed_recovery_no_replace BEFORE INSERT ON canary_completed_recovery WHEN EXISTS(SELECT 1 FROM canary_completed_recovery r WHERE r.spreadsheet_id=NEW.spreadsheet_id OR r.operation_token=NEW.operation_token OR r.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'completed Canary recovery already exists'); END;
