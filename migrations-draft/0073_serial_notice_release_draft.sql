-- Local mock experiment only. The barrier remains until #296 supplies an
-- authoritative continuous fence and the release protocol is independently verified.
CREATE TABLE IF NOT EXISTS serial_pilot_notice_release_receipts(
 operation_token TEXT PRIMARY KEY, spreadsheet_id TEXT NOT NULL, round_id TEXT NOT NULL,
 predecessor_job_id TEXT NOT NULL, successor_job_id TEXT NOT NULL, epoch_id TEXT NOT NULL,
 nonce TEXT NOT NULL UNIQUE, worker_version TEXT NOT NULL, source_revision INTEGER NOT NULL,
 fence_digest TEXT NOT NULL, fence_generation INTEGER NOT NULL, attestation_expires_at TEXT NOT NULL,
 notice_algorithm TEXT NOT NULL CHECK(notice_algorithm='SHA256_MALIPANG_NOTICE_POSTIMAGE_V1'),
 notice_postimage_digest TEXT NOT NULL CHECK(length(notice_postimage_digest)=64 AND notice_postimage_digest NOT GLOB '*[^0-9a-f]*'),
 observed_at TEXT NOT NULL, released_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS serial_pilot_notice_release_not_ready BEFORE INSERT ON serial_pilot_notice_release_receipts BEGIN SELECT RAISE(ABORT,'notice release not ready'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_notice_release_no_replace BEFORE INSERT ON serial_pilot_notice_release_receipts WHEN EXISTS(SELECT 1 FROM serial_pilot_notice_release_receipts WHERE operation_token=NEW.operation_token OR nonce=NEW.nonce OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'notice release retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_notice_release_no_update BEFORE UPDATE ON serial_pilot_notice_release_receipts BEGIN SELECT RAISE(ABORT,'notice release immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_notice_release_no_delete BEFORE DELETE ON serial_pilot_notice_release_receipts BEGIN SELECT RAISE(ABORT,'notice release retained'); END;
-- Synthetic stop signal only: revocation never proves that an in-flight
-- provider request has ended or that an external writer is fenced.
CREATE TABLE IF NOT EXISTS serial_pilot_oracle_revocations(
 spreadsheet_id TEXT NOT NULL, fence_digest TEXT NOT NULL, fence_generation INTEGER NOT NULL,
 revoked_at TEXT NOT NULL, PRIMARY KEY(spreadsheet_id,fence_digest,fence_generation)
);
CREATE TRIGGER IF NOT EXISTS serial_pilot_oracle_revoke_not_ready BEFORE INSERT ON serial_pilot_oracle_revocations BEGIN SELECT RAISE(ABORT,'oracle revocation not ready'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_oracle_revoke_insert BEFORE INSERT ON serial_pilot_oracle_revocations WHEN NOT EXISTS(SELECT 1 FROM serial_pilot_oracle_fence f WHERE f.spreadsheet_id=NEW.spreadsheet_id AND f.fence_digest=NEW.fence_digest AND f.generation=NEW.fence_generation) OR EXISTS(SELECT 1 FROM serial_pilot_oracle_revocations WHERE (spreadsheet_id=NEW.spreadsheet_id AND fence_digest=NEW.fence_digest AND fence_generation=NEW.fence_generation) OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'invalid oracle revocation'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_oracle_revoke_no_update BEFORE UPDATE ON serial_pilot_oracle_revocations BEGIN SELECT RAISE(ABORT,'oracle revocation immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_oracle_revoke_no_delete BEFORE DELETE ON serial_pilot_oracle_revocations BEGIN SELECT RAISE(ABORT,'oracle revocation retained'); END;
