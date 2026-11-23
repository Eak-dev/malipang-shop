-- Local evidence experiment, not authority to release a claim or open C's
-- next stage. The explicit barrier remains until the complete protocol passes.
CREATE TABLE IF NOT EXISTS serial_pilot_ledger_stage_receipts(
 operation_token TEXT PRIMARY KEY, epoch_id TEXT NOT NULL, spreadsheet_id TEXT NOT NULL, job_id TEXT NOT NULL,
 entity_id TEXT NOT NULL, projection TEXT NOT NULL CHECK(projection IN ('EXPENSE_RAW','DETAIL')),
 source_version INTEGER NOT NULL, source_digest TEXT NOT NULL, source_revision INTEGER NOT NULL,
 sheet_id INTEGER NOT NULL, sheet_name TEXT NOT NULL, before_digest TEXT NOT NULL, payload_digest TEXT NOT NULL,
 ledger_marker TEXT NOT NULL, worker_version TEXT NOT NULL, nonce TEXT NOT NULL,
 notice_algorithm TEXT NOT NULL CHECK(notice_algorithm='SHA256_MALIPANG_NOTICE_POSTIMAGE_V1'),
 notice_postimage_digest TEXT NOT NULL CHECK(length(notice_postimage_digest)=64 AND notice_postimage_digest NOT GLOB '*[^0-9a-f]*'),
 observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(epoch_id,entity_id,projection)
);
CREATE TRIGGER IF NOT EXISTS serial_ledger_stage_not_ready BEFORE INSERT ON serial_pilot_ledger_stage_receipts BEGIN SELECT RAISE(ABORT,'ledger stage receipt not ready'); END;
CREATE TRIGGER IF NOT EXISTS serial_ledger_stage_no_replace BEFORE INSERT ON serial_pilot_ledger_stage_receipts WHEN EXISTS(SELECT 1 FROM serial_pilot_ledger_stage_receipts r WHERE r.operation_token=NEW.operation_token OR r.rowid=NEW.rowid OR (r.epoch_id=NEW.epoch_id AND r.entity_id=NEW.entity_id AND r.projection=NEW.projection)) BEGIN SELECT RAISE(ABORT,'ledger stage receipt retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_ledger_stage_no_update BEFORE UPDATE ON serial_pilot_ledger_stage_receipts BEGIN SELECT RAISE(ABORT,'ledger stage receipt immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_ledger_stage_no_delete BEFORE DELETE ON serial_pilot_ledger_stage_receipts BEGIN SELECT RAISE(ABORT,'ledger stage receipt retained'); END;
