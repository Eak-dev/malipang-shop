-- A LINE user can have one short-lived, explicitly targeted edit at a time.
-- This is deliberately separate from raw webhook evidence and preserves the
-- event's idempotency boundary while a person confirms a draft description.
CREATE TABLE IF NOT EXISTS expense_pending_edits(
  line_user_id TEXT PRIMARY KEY,
  expense_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK(field IN ('description')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(expense_id) REFERENCES expense_events(expense_id)
);
CREATE INDEX IF NOT EXISTS idx_expense_pending_edits_expiry
ON expense_pending_edits(expires_at);
