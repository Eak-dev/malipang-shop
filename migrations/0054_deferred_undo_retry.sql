-- Scheduling metadata only; it does not authorize an Undo or a Sheets write.
-- The source remains frozen while the corresponding request is PENDING.
CREATE TABLE IF NOT EXISTS continuous_deferred_undo_retries (
 request_id TEXT PRIMARY KEY REFERENCES continuous_pending_undo(request_id),
 attempt_count INTEGER NOT NULL CHECK(attempt_count > 0),
 next_attempt_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
