-- Local oracle/fence model only. A signature is not evidence that Google has
-- no request in flight. These barriers cannot be removed by ordinary DML.
CREATE TABLE IF NOT EXISTS serial_pilot_oracle_fence(
 spreadsheet_id TEXT PRIMARY KEY, fence_digest TEXT NOT NULL CHECK(length(fence_digest)=64 AND fence_digest NOT GLOB '*[^0-9a-f]*'),
 generation INTEGER NOT NULL CHECK(generation>0), created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS serial_pilot_oracle_fence_not_ready BEFORE INSERT ON serial_pilot_oracle_fence BEGIN SELECT RAISE(ABORT,'oracle fence not ready'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_oracle_fence_no_replace BEFORE INSERT ON serial_pilot_oracle_fence WHEN EXISTS(SELECT 1 FROM serial_pilot_oracle_fence WHERE spreadsheet_id=NEW.spreadsheet_id OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'oracle fence retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_oracle_fence_no_update BEFORE UPDATE ON serial_pilot_oracle_fence BEGIN SELECT RAISE(ABORT,'oracle fence immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_oracle_fence_no_delete BEFORE DELETE ON serial_pilot_oracle_fence BEGIN SELECT RAISE(ABORT,'oracle fence retained'); END;
CREATE TABLE IF NOT EXISTS serial_pilot_attested_handoffs(
 nonce TEXT PRIMARY KEY,round_id TEXT NOT NULL,predecessor_job_id TEXT NOT NULL UNIQUE,successor_job_id TEXT NOT NULL UNIQUE,
 spreadsheet_id TEXT NOT NULL,predecessor_epoch_id TEXT NOT NULL,successor_epoch_id TEXT NOT NULL UNIQUE,
 claim_token TEXT NOT NULL,worker_version TEXT NOT NULL,source_revision INTEGER NOT NULL,
 fence_digest TEXT NOT NULL,fence_generation INTEGER NOT NULL,issued_at TEXT NOT NULL,expires_at TEXT NOT NULL,
 payload_digest TEXT NOT NULL,signer_digest TEXT NOT NULL,signature_digest TEXT NOT NULL,created_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS serial_pilot_attested_handoff_not_ready BEFORE INSERT ON serial_pilot_attested_handoffs BEGIN SELECT RAISE(ABORT,'attested handoff not ready'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_attested_handoff_no_replace BEFORE INSERT ON serial_pilot_attested_handoffs
WHEN EXISTS(SELECT 1 FROM serial_pilot_attested_handoffs WHERE nonce=NEW.nonce OR predecessor_job_id=NEW.predecessor_job_id OR successor_job_id=NEW.successor_job_id OR successor_epoch_id=NEW.successor_epoch_id OR rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'attested handoff collision'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_attested_handoff_no_update BEFORE UPDATE ON serial_pilot_attested_handoffs BEGIN SELECT RAISE(ABORT,'attested handoff immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_attested_handoff_no_delete BEFORE DELETE ON serial_pilot_attested_handoffs BEGIN SELECT RAISE(ABORT,'attested handoff retained'); END;
