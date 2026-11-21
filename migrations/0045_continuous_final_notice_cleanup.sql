-- Unique-preimage one-shot cleanup of FINAL's syncing notice. The claim
-- remains HELD until positive readback of this exact notice attempt.
CREATE TABLE IF NOT EXISTS continuous_final_notice_cleanup (
 operation_token TEXT PRIMARY KEY,
 spreadsheet_id TEXT NOT NULL,
 find_status TEXT NOT NULL,
 replacement_status TEXT NOT NULL CHECK(replacement_status IN ('พร้อมแก้ไข','พร้อมแก้ไข • มีรายการรอตรวจ')),
 notice_stamp TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS continuous_final_notice_cleanup_insert BEFORE INSERT ON continuous_final_notice_cleanup
WHEN NOT EXISTS(SELECT 1 FROM continuous_review_notice_close n JOIN stable_workbook_claims c ON c.spreadsheet_id=n.spreadsheet_id AND c.operation_token=n.operation_token JOIN stable_recovery_epochs e ON e.epoch_id=n.epoch_id AND e.spreadsheet_id=n.spreadsheet_id JOIN stable_recovery_operations o ON o.epoch_id=e.epoch_id AND o.operation_token=n.operation_token JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=n.expense_id AND j.entity_version=n.source_version WHERE n.operation_token=NEW.operation_token AND n.spreadsheet_id=NEW.spreadsheet_id AND n.projection='FINAL' AND n.claim_mode='HANDOFF' AND n.state='FINAL_COMMITTED' AND n.ready_status=NEW.find_status AND n.next_stamp=NEW.notice_stamp AND c.state='HELD' AND c.phase='END_NOTICE_PENDING' AND c.notice_identity=n.notice_identity AND c.notice_stamp=n.next_stamp AND e.state='COMPLETE' AND e.target_type='EXPENSE' AND e.target_key=n.expense_id AND e.target_version=n.source_version AND o.state='VERIFIED' AND j.status='COMPLETED' AND ((NEW.replacement_status='พร้อมแก้ไข' AND NOT EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW')) OR (NEW.replacement_status='พร้อมแก้ไข • มีรายการรอตรวจ' AND EXISTS(SELECT 1 FROM sync_jobs WHERE status='REVIEW'))))
BEGIN SELECT RAISE(ABORT,'final cleanup requires committed exact target'); END;
CREATE TRIGGER IF NOT EXISTS continuous_final_notice_cleanup_no_update BEFORE UPDATE ON continuous_final_notice_cleanup BEGIN SELECT RAISE(ABORT,'final cleanup immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_final_notice_cleanup_no_delete BEFORE DELETE ON continuous_final_notice_cleanup BEGIN SELECT RAISE(ABORT,'final cleanup retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_final_notice_cleanup_no_replace BEFORE INSERT ON continuous_final_notice_cleanup WHEN EXISTS(SELECT 1 FROM continuous_final_notice_cleanup a WHERE a.operation_token=NEW.operation_token OR a.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'final cleanup already exists'); END;
