-- Local final-observation experiment only. It does not close the epoch/session
-- or release a claim; no external fence/quiescence is proven by this record.
CREATE TABLE IF NOT EXISTS serial_pilot_final_receipts(
 operation_token TEXT PRIMARY KEY,epoch_id TEXT NOT NULL UNIQUE,spreadsheet_id TEXT NOT NULL,job_id TEXT NOT NULL,
 nonce TEXT NOT NULL,worker_version TEXT NOT NULL,source_revision INTEGER NOT NULL,source_digest TEXT NOT NULL,
 provider_algorithm TEXT NOT NULL CHECK(provider_algorithm='SHA256_MALIPANG_PROJECTION_SNAPSHOT_V1'),
 provider_digest TEXT NOT NULL CHECK(length(provider_digest)=64 AND provider_digest NOT GLOB '*[^0-9a-f]*'),
 notice_algorithm TEXT NOT NULL CHECK(notice_algorithm='SHA256_MALIPANG_NOTICE_POSTIMAGE_V1'),
 notice_digest TEXT NOT NULL CHECK(length(notice_digest)=64 AND notice_digest NOT GLOB '*[^0-9a-f]*'),
 provider_observed_at TEXT NOT NULL,notice_observed_at TEXT NOT NULL,recorded_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS serial_final_receipt_not_ready BEFORE INSERT ON serial_pilot_final_receipts BEGIN SELECT RAISE(ABORT,'final receipt not ready'); END;
CREATE TRIGGER IF NOT EXISTS serial_final_receipt_no_replace BEFORE INSERT ON serial_pilot_final_receipts WHEN EXISTS(SELECT 1 FROM serial_pilot_final_receipts r WHERE r.operation_token=NEW.operation_token OR r.epoch_id=NEW.epoch_id OR r.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'final receipt retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_final_receipt_no_update BEFORE UPDATE ON serial_pilot_final_receipts BEGIN SELECT RAISE(ABORT,'final receipt immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_final_receipt_no_delete BEFORE DELETE ON serial_pilot_final_receipts BEGIN SELECT RAISE(ABORT,'final receipt retained'); END;
