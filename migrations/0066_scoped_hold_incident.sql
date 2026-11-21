-- A single retained incident. Notice writes are journaled before dispatch;
-- ambiguous provider outcomes remain in flight and cannot be retried.
CREATE TABLE IF NOT EXISTS scoped_hold_incident_recovery (
 spreadsheet_id TEXT PRIMARY KEY,
 operation_token TEXT NOT NULL UNIQUE,
 job_id TEXT NOT NULL UNIQUE,
 expense_id TEXT NOT NULL,
 source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer' AND source_revision>=0),
 paused_stamp TEXT NOT NULL CHECK(length(paused_stamp)>0),
 notice_identity TEXT NOT NULL CHECK(length(notice_identity)>0),
 next_stamp TEXT NOT NULL CHECK(length(next_stamp)>32 AND next_stamp<>paused_stamp),
 ready_status TEXT NOT NULL CHECK(ready_status='พร้อมแก้ไข • มีรายการรอตรวจ'),
 style_digest TEXT NOT NULL CHECK(length(style_digest)=64 AND style_digest NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('TIME_IN_FLIGHT','TIME_ACKED','STATUS_IN_FLIGHT','STATUS_ACKED','COMPLETE')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS scoped_hold_incident_insert BEFORE INSERT ON scoped_hold_incident_recovery
WHEN NEW.state<>'TIME_IN_FLIGHT' OR NOT EXISTS(
 SELECT 1 FROM stable_workbook_claims w JOIN sync_jobs j ON j.job_id=NEW.job_id
 JOIN expense_events e ON e.expense_id=j.entity_key
 JOIN stable_source_revision r ON r.singleton=1 AND r.revision=NEW.source_revision
 WHERE w.spreadsheet_id=NEW.spreadsheet_id AND w.operation_token=NEW.operation_token AND w.state='REVIEW' AND w.phase='OPERATION' AND w.review_reason='STABLE_EXPENSE_SOURCE_UNVERIFIED'
 AND w.notice_stamp=NEW.paused_stamp AND w.notice_identity=NEW.notice_identity
 AND j.entity_type='EXPENSE' AND j.entity_key=NEW.expense_id AND j.entity_version=1 AND j.status='REVIEW' AND j.last_error='STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED' AND j.attempt_count=1 AND j.lease_token IS NULL AND j.lease_until IS NULL
 AND e.status='CANCELLED' AND e.version=2 AND j.updated_at>=w.created_at AND j.updated_at<=w.updated_at AND (julianday(w.updated_at)-julianday(j.updated_at))*86400.0<2
 AND EXISTS(SELECT 1 FROM sync_alert_incidents a WHERE a.kind='JOB' AND a.source_id=j.job_id AND a.state='OPEN')
 AND EXISTS(SELECT 1 FROM sync_jobs u WHERE u.entity_type='EXPENSE' AND u.entity_key=j.entity_key AND u.entity_version=2 AND u.status='PENDING' AND u.attempt_count=0 AND u.lease_token IS NULL AND u.lease_until IS NULL)
 AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|'))
 AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=j.entity_key OR substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|'))
 AND NOT EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=j.entity_key OR substr(i.entity_key,1,length(j.entity_key)+1)=j.entity_key||'|')
 AND NOT EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key IN ('EXPENSE:'||j.entity_key||':1','EXPENSE:'||j.entity_key||':2'))
 ) OR (SELECT count(*) FROM stable_workbook_claims)<>1 OR EXISTS(SELECT 1 FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW'))
 OR EXISTS(SELECT 1 FROM sync_jobs WHERE status='PROCESSING') OR EXISTS(SELECT 1 FROM staff_config_sync_outbox WHERE status='PROCESSING')
 OR EXISTS(SELECT 1 FROM stable_projection_writes WHERE state<>'VERIFIED') OR EXISTS(SELECT 1 FROM stable_expense_cancellation_writes WHERE state<>'VERIFIED')
BEGIN SELECT RAISE(ABORT,'scoped hold incident preimage rejected'); END;
CREATE TRIGGER IF NOT EXISTS scoped_hold_incident_transition BEFORE UPDATE ON scoped_hold_incident_recovery
WHEN NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.operation_token IS NOT OLD.operation_token OR NEW.job_id IS NOT OLD.job_id OR NEW.expense_id IS NOT OLD.expense_id OR NEW.source_revision IS NOT OLD.source_revision OR NEW.paused_stamp IS NOT OLD.paused_stamp OR NEW.notice_identity IS NOT OLD.notice_identity OR NEW.next_stamp IS NOT OLD.next_stamp OR NEW.ready_status IS NOT OLD.ready_status OR NEW.style_digest IS NOT OLD.style_digest OR NEW.created_at IS NOT OLD.created_at
 OR (NEW.state='COMPLETE' AND EXISTS(SELECT 1 FROM stable_workbook_claims w WHERE w.spreadsheet_id=NEW.spreadsheet_id AND w.operation_token=NEW.operation_token))
 OR NOT (OLD.state='TIME_IN_FLIGHT' AND NEW.state='TIME_ACKED' OR OLD.state='TIME_ACKED' AND NEW.state='STATUS_IN_FLIGHT' OR OLD.state='STATUS_IN_FLIGHT' AND NEW.state='STATUS_ACKED' OR OLD.state='STATUS_ACKED' AND NEW.state='COMPLETE')
BEGIN SELECT RAISE(ABORT,'scoped hold incident transition rejected'); END;
CREATE TRIGGER IF NOT EXISTS scoped_hold_incident_no_delete BEFORE DELETE ON scoped_hold_incident_recovery BEGIN SELECT RAISE(ABORT,'scoped hold incident retained'); END;
CREATE TRIGGER IF NOT EXISTS scoped_hold_incident_no_replace BEFORE INSERT ON scoped_hold_incident_recovery WHEN EXISTS(SELECT 1 FROM scoped_hold_incident_recovery r WHERE r.spreadsheet_id=NEW.spreadsheet_id OR r.operation_token=NEW.operation_token OR r.job_id=NEW.job_id OR r.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'scoped hold incident collision'); END;
