-- An exact notice-close attempt for a positively verified expense stage.
-- No missing provider value permits replay. There is no scheduler caller.
CREATE TABLE IF NOT EXISTS continuous_review_notice_close (
 operation_token TEXT PRIMARY KEY,
 spreadsheet_id TEXT NOT NULL,
 epoch_id TEXT NOT NULL,
 expense_id TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(source_version>0),
 projection TEXT NOT NULL CHECK(projection IN ('DAILY','EXPENSE_RAW','DETAIL','FINAL')),
 journal_entity TEXT NOT NULL,
 operation_kind TEXT NOT NULL CHECK(operation_kind IN ('CONFIRM','CANCEL')),
 claim_mode TEXT NOT NULL DEFAULT 'REVIEW' CHECK(claim_mode IN ('REVIEW','HANDOFF')),
 ready_status TEXT NOT NULL DEFAULT 'พร้อมแก้ไข • มีรายการรอตรวจ' CHECK((ready_status IN ('พร้อมแก้ไข','พร้อมแก้ไข • มีรายการรอตรวจ','พร้อมแก้ไข • กำลังซิงก์','พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ') OR (substr(ready_status,-32) NOT GLOB '*[^0-9a-f]*' AND (length(ready_status)=length('พร้อมแก้ไข • กำลังซิงก์ • รหัส ')+32 AND substr(ready_status,1,length('พร้อมแก้ไข • กำลังซิงก์ • รหัส '))='พร้อมแก้ไข • กำลังซิงก์ • รหัส ' OR length(ready_status)=length('พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ • รหัส ')+32 AND substr(ready_status,1,length('พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ • รหัส '))='พร้อมแก้ไข • กำลังซิงก์ • มีรายการรอตรวจ • รหัส ')))),
 notice_identity TEXT NOT NULL,
 paused_stamp TEXT NOT NULL,
 next_stamp TEXT NOT NULL CHECK(next_stamp<>paused_stamp),
 style_digest TEXT NOT NULL CHECK(length(style_digest)=64 AND style_digest NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('TIME_IN_FLIGHT','TIME_VERIFIED','STATUS_IN_FLIGHT','STATUS_ACKED','FINAL_COMMITTED','CLEANUP_IN_FLIGHT','COMPLETE')),
 source_revision INTEGER CHECK(source_revision IS NULL OR source_revision>=0),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 CHECK((state IN ('TIME_IN_FLIGHT','TIME_VERIFIED') AND source_revision IS NULL) OR (state IN ('STATUS_IN_FLIGHT','STATUS_ACKED','FINAL_COMMITTED','CLEANUP_IN_FLIGHT','COMPLETE') AND source_revision IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS continuous_review_close_insert BEFORE INSERT ON continuous_review_notice_close
WHEN NEW.state<>'TIME_IN_FLIGHT' OR NEW.source_revision IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM stable_workbook_claims c
 JOIN stable_recovery_epochs e ON e.epoch_id=NEW.epoch_id AND e.spreadsheet_id=c.spreadsheet_id AND e.state='ARMED' AND e.target_type='EXPENSE' AND e.target_key=NEW.expense_id AND e.target_version=NEW.source_version
 JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=c.operation_token AND o.state='ADMITTED'
 JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.target_key AND j.entity_version=e.target_version AND ((NEW.claim_mode='REVIEW' AND j.status='REVIEW' AND (j.lease_token IS NULL AND j.lease_until IS NULL OR j.lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))) OR (NEW.claim_mode='HANDOFF' AND j.status='PENDING' AND j.lease_token IS NULL AND j.lease_until IS NULL))
 WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.operation_token=NEW.operation_token AND ((NEW.claim_mode='REVIEW' AND c.state='REVIEW' AND c.phase='OPERATION') OR (NEW.claim_mode='HANDOFF' AND c.state='HELD' AND c.phase='END_NOTICE_PENDING' AND EXISTS(SELECT 1 FROM continuous_normal_notice_handoffs h WHERE h.spreadsheet_id=c.spreadsheet_id AND h.operation_token=c.operation_token AND h.expense_id=NEW.expense_id AND h.source_version=NEW.source_version AND h.projection=NEW.projection AND h.journal_entity=NEW.journal_entity AND h.operation_kind=NEW.operation_kind))) AND c.notice_identity=NEW.notice_identity AND c.notice_stamp=NEW.paused_stamp
 ) OR EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key='EXPENSE:'||NEW.expense_id||':'||NEW.source_version AND f.status='OPEN' AND f.error='DEAD_LETTER_MAX_RETRIES')
 OR (NEW.projection<>'FINAL' AND NEW.operation_kind='CONFIRM' AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=NEW.journal_entity AND p.projection=NEW.projection AND p.source_version=NEW.source_version AND p.operation_token=NEW.operation_token AND p.state='VERIFIED'))
 OR (NEW.projection<>'FINAL' AND NEW.operation_kind='CANCEL' AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=NEW.journal_entity AND p.projection=NEW.projection AND p.cancellation_version=NEW.source_version AND p.operation_token=NEW.operation_token AND p.state='VERIFIED'))
 OR (NEW.projection='FINAL' AND (NEW.claim_mode<>'HANDOFF' OR NOT EXISTS(SELECT 1 FROM continuous_final_notice_evidence z WHERE z.spreadsheet_id=NEW.spreadsheet_id AND z.operation_token=NEW.operation_token AND z.epoch_id=NEW.epoch_id AND z.expense_id=NEW.expense_id AND z.source_version=NEW.source_version AND z.operation_kind=NEW.operation_kind)))
 OR (SELECT count(*) FROM stable_projection_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.operation_token=NEW.operation_token)+(SELECT count(*) FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.operation_token=NEW.operation_token)<>CASE WHEN NEW.projection='FINAL' THEN 0 ELSE 1 END
BEGIN SELECT RAISE(ABORT,'review close requires exact verified operation'); END;
CREATE TRIGGER IF NOT EXISTS continuous_review_close_transition BEFORE UPDATE ON continuous_review_notice_close
WHEN NEW.operation_token IS NOT OLD.operation_token OR NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.epoch_id IS NOT OLD.epoch_id OR NEW.expense_id IS NOT OLD.expense_id OR NEW.source_version IS NOT OLD.source_version OR NEW.projection IS NOT OLD.projection OR NEW.journal_entity IS NOT OLD.journal_entity OR NEW.operation_kind IS NOT OLD.operation_kind OR NEW.claim_mode IS NOT OLD.claim_mode OR NEW.notice_identity IS NOT OLD.notice_identity OR NEW.paused_stamp IS NOT OLD.paused_stamp OR NEW.next_stamp IS NOT OLD.next_stamp OR NEW.style_digest IS NOT OLD.style_digest OR NEW.created_at IS NOT OLD.created_at
 OR NOT (OLD.state='TIME_IN_FLIGHT' AND NEW.state='TIME_VERIFIED' AND NEW.source_revision IS NULL AND NEW.ready_status IS OLD.ready_status OR OLD.state='TIME_VERIFIED' AND NEW.state='STATUS_IN_FLIGHT' AND NEW.source_revision IS NOT NULL AND EXISTS(SELECT 1 FROM continuous_notice_status_attempts a WHERE a.operation_token=NEW.operation_token AND a.spreadsheet_id=NEW.spreadsheet_id AND a.initial_ready_status=OLD.ready_status AND a.dispatch_ready_status=NEW.ready_status AND a.next_stamp=NEW.next_stamp AND a.source_revision=NEW.source_revision) OR OLD.state='STATUS_IN_FLIGHT' AND NEW.state='STATUS_ACKED' AND NEW.source_revision IS OLD.source_revision AND NEW.ready_status IS OLD.ready_status OR OLD.state='STATUS_ACKED' AND NEW.state IN ('COMPLETE','FINAL_COMMITTED') AND NEW.source_revision IS OLD.source_revision AND NEW.ready_status IS OLD.ready_status OR OLD.state='FINAL_COMMITTED' AND NEW.state='CLEANUP_IN_FLIGHT' AND NEW.source_revision IS OLD.source_revision AND NEW.ready_status IS OLD.ready_status AND EXISTS(SELECT 1 FROM continuous_final_notice_cleanup a WHERE a.operation_token=NEW.operation_token AND a.spreadsheet_id=NEW.spreadsheet_id AND a.find_status=NEW.ready_status AND a.notice_stamp=NEW.next_stamp) OR OLD.state='CLEANUP_IN_FLIGHT' AND NEW.state='COMPLETE' AND NEW.source_revision IS OLD.source_revision AND NEW.ready_status IS OLD.ready_status)
BEGIN SELECT RAISE(ABORT,'review close transition rejected'); END;
CREATE TRIGGER IF NOT EXISTS continuous_review_close_no_delete BEFORE DELETE ON continuous_review_notice_close BEGIN SELECT RAISE(ABORT,'review close retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_review_close_no_replace BEFORE INSERT ON continuous_review_notice_close
WHEN EXISTS(SELECT 1 FROM continuous_review_notice_close c WHERE c.operation_token=NEW.operation_token OR c.rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'review close already exists'); END;
