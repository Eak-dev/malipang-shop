-- Inert until a verified metadata marker and a trusted observation are present.
CREATE TABLE IF NOT EXISTS daily_identity_posting_write_intents(
  expense_id TEXT NOT NULL,
  expense_version INTEGER NOT NULL CHECK(expense_version>0),
  plan_json TEXT NOT NULL,
  before_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','IN_FLIGHT','VALUES_VERIFIED','REVIEW')),
  dispatch_id TEXT UNIQUE,
  fence_token TEXT,
  not_before TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(expense_id,expense_version),
  FOREIGN KEY(expense_id,expense_version) REFERENCES daily_identity_posting_reservations(expense_id,expense_version)
);
