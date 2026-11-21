-- Exact synthetic preflight incident only. This table records a one-shot
-- provider-notice recovery; it is not an authorization to dispatch one.
-- Uncertain provider replies leave the corresponding IN_FLIGHT row fenced.
CREATE TABLE IF NOT EXISTS canary_unwritten_recovery (
 spreadsheet_id TEXT PRIMARY KEY,
 operation_token TEXT NOT NULL UNIQUE,
 epoch_id TEXT NOT NULL,
 expense_id TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(source_version=1),
 source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer' AND source_revision>=0),
 paused_stamp TEXT NOT NULL CHECK(length(paused_stamp)>0),
 notice_identity TEXT NOT NULL CHECK(length(notice_identity)>0),
 next_stamp TEXT NOT NULL CHECK(length(next_stamp)>32 AND next_stamp<>paused_stamp),
 ready_status TEXT NOT NULL CHECK(ready_status IN ('พร้อมแก้ไข','พร้อมแก้ไข • มีรายการรอตรวจ')),
 provider_digest TEXT NOT NULL CHECK(length(provider_digest)=64 AND provider_digest NOT GLOB '*[^0-9a-f]*'),
 style_digest TEXT NOT NULL CHECK(length(style_digest)=64 AND style_digest NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('TIME_IN_FLIGHT','TIME_ACKED','STATUS_IN_FLIGHT','STATUS_ACKED','COMPLETE')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 FOREIGN KEY(epoch_id) REFERENCES stable_recovery_epochs(epoch_id)
);

CREATE TRIGGER IF NOT EXISTS canary_unwritten_recovery_insert BEFORE INSERT ON canary_unwritten_recovery
WHEN NEW.state<>'TIME_IN_FLIGHT'
 OR NEW.expense_id NOT GLOB 'exp_canary_*'
 OR NOT EXISTS(SELECT 1 FROM continuous_canary_operator c
  JOIN expense_events e ON e.expense_id=c.expense_id AND e.status='CONFIRMED' AND e.version=1
  JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=1
  JOIN stable_workbook_claims w ON w.spreadsheet_id=c.spreadsheet_id AND w.operation_token=NEW.operation_token
  JOIN stable_recovery_epochs r ON r.spreadsheet_id=c.spreadsheet_id AND r.epoch_id=NEW.epoch_id
  JOIN stable_recovery_operations o ON o.epoch_id=r.epoch_id AND o.operation_token=w.operation_token
  JOIN stable_source_revision rev ON rev.singleton=1 AND rev.revision=NEW.source_revision
  WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.expense_id=NEW.expense_id AND c.state='ARMED_CONFIRM'
   AND e.description='[SYSTEM TEST] Synthetic expense - cancel after verification' AND e.amount_satang=100
   AND j.status='REVIEW' AND j.last_error='STABLE_SYNC_REVIEW' AND j.lease_token IS NULL AND j.lease_until IS NULL
   AND w.state='REVIEW' AND w.phase='OPERATION' AND w.review_reason='INSERT_DAILY_PREFLIGHT_REPORT_HEALTH_FORMULA'
   AND w.notice_stamp=NEW.paused_stamp AND w.notice_identity=NEW.notice_identity
   AND r.state='ARMED' AND r.target_type='EXPENSE' AND r.target_key=e.expense_id AND r.target_version=1 AND o.state='ADMITTED')
 OR (SELECT count(*) FROM stable_workbook_claims)<>1
 OR (SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW'))<>1
 OR EXISTS(SELECT 1 FROM sync_jobs WHERE status='PROCESSING')
 OR EXISTS(SELECT 1 FROM staff_config_sync_outbox WHERE status='PROCESSING')
 OR EXISTS(SELECT 1 FROM stable_projection_writes WHERE state<>'VERIFIED')
 OR EXISTS(SELECT 1 FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED')
 OR EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=NEW.expense_id OR substr(p.entity_id,1,length(NEW.expense_id)+1)=NEW.expense_id||'|'))
 OR EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=NEW.expense_id OR substr(p.entity_id,1,length(NEW.expense_id)+1)=NEW.expense_id||'|'))
 OR EXISTS(SELECT 1 FROM continuous_publication_intents p WHERE p.entity_id=NEW.expense_id)
 OR EXISTS(SELECT 1 FROM atomic_daily_marker_reservations p WHERE p.entity_id=NEW.expense_id)
 OR EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||NEW.expense_id||':1' AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')
BEGIN SELECT RAISE(ABORT,'canary unwritten recovery preimage rejected'); END;

CREATE TRIGGER IF NOT EXISTS canary_unwritten_recovery_transition BEFORE UPDATE ON canary_unwritten_recovery
WHEN NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.operation_token IS NOT OLD.operation_token
 OR NEW.epoch_id IS NOT OLD.epoch_id OR NEW.expense_id IS NOT OLD.expense_id
 OR NEW.source_version IS NOT OLD.source_version OR NEW.source_revision IS NOT OLD.source_revision
 OR NEW.paused_stamp IS NOT OLD.paused_stamp OR NEW.notice_identity IS NOT OLD.notice_identity
 OR NEW.next_stamp IS NOT OLD.next_stamp OR NEW.ready_status IS NOT OLD.ready_status
 OR NEW.provider_digest IS NOT OLD.provider_digest OR NEW.style_digest IS NOT OLD.style_digest
 OR NEW.created_at IS NOT OLD.created_at
 OR NOT (OLD.state='TIME_IN_FLIGHT' AND NEW.state='TIME_ACKED'
  OR OLD.state='TIME_ACKED' AND NEW.state='STATUS_IN_FLIGHT'
  OR OLD.state='STATUS_IN_FLIGHT' AND NEW.state='STATUS_ACKED'
  OR OLD.state='STATUS_ACKED' AND NEW.state='COMPLETE')
BEGIN SELECT RAISE(ABORT,'canary unwritten recovery transition rejected'); END;

CREATE TRIGGER IF NOT EXISTS canary_unwritten_recovery_no_delete BEFORE DELETE ON canary_unwritten_recovery
BEGIN SELECT RAISE(ABORT,'canary unwritten recovery retained'); END;
CREATE TRIGGER IF NOT EXISTS canary_unwritten_recovery_no_replace BEFORE INSERT ON canary_unwritten_recovery
WHEN EXISTS(SELECT 1 FROM canary_unwritten_recovery r WHERE r.spreadsheet_id=NEW.spreadsheet_id OR r.operation_token=NEW.operation_token OR r.rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'canary unwritten recovery already exists'); END;
