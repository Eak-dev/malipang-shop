-- Local draft containment only. No entry authorizes releasing a claim,
-- declaring a safe park, or reserving another job.
CREATE TABLE IF NOT EXISTS serial_pilot_hold_evidence(
 round_id TEXT NOT NULL, job_id TEXT NOT NULL, audit_id TEXT NOT NULL,
 spreadsheet_id TEXT NOT NULL, fingerprint TEXT NOT NULL, epoch_id TEXT NOT NULL,
 source_namespace TEXT NOT NULL, observed_at TEXT NOT NULL,
 PRIMARY KEY(round_id,job_id), UNIQUE(job_id)
);
CREATE TRIGGER IF NOT EXISTS serial_pilot_hold_not_ready BEFORE INSERT ON serial_pilot_hold_evidence BEGIN SELECT RAISE(ABORT,'pilot hold not ready'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_hold_no_replace BEFORE INSERT ON serial_pilot_hold_evidence WHEN EXISTS(SELECT 1 FROM serial_pilot_hold_evidence WHERE job_id=NEW.job_id OR rowid=NEW.rowid OR (round_id=NEW.round_id AND job_id=NEW.job_id)) BEGIN SELECT RAISE(ABORT,'pilot hold retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_hold_no_update BEFORE UPDATE ON serial_pilot_hold_evidence BEGIN SELECT RAISE(ABORT,'pilot hold immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_pilot_hold_no_delete BEFORE DELETE ON serial_pilot_hold_evidence BEGIN SELECT RAISE(ABORT,'pilot hold retained'); END;
