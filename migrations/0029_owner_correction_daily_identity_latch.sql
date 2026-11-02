-- Inert until deliberately activated under the shared daily sheet fence.
-- Once active it is deliberately not downgraded when LINE input is paused.
CREATE TABLE IF NOT EXISTS owner_correction_daily_identity_latch(
  sheet_name TEXT PRIMARY KEY,
  activated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS owner_correction_daily_identity_latch_no_update
BEFORE UPDATE ON owner_correction_daily_identity_latch BEGIN
  SELECT RAISE(ABORT,'daily identity latch is permanent');
END;
CREATE TRIGGER IF NOT EXISTS owner_correction_daily_identity_latch_no_delete
BEFORE DELETE ON owner_correction_daily_identity_latch BEGIN
  SELECT RAISE(ABORT,'daily identity latch is permanent');
END;
