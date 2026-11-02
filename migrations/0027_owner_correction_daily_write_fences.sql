-- Shared uncertainty fence for normal daily-sheet writes and correction
-- sync workers when the feature is enabled. Move reservation is separate.
CREATE TABLE IF NOT EXISTS owner_correction_daily_write_fences(
  sheet_name TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('OWNED','IN_FLIGHT')),
  dispatch_id TEXT,
  not_before TEXT,
  updated_at TEXT NOT NULL,
  CHECK((state='OWNED' AND dispatch_id IS NULL AND not_before IS NULL) OR
        (state='IN_FLIGHT' AND dispatch_id IS NOT NULL AND not_before IS NOT NULL))
);
