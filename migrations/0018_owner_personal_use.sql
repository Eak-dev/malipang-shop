-- Owner draws/returns are a separate cash-movement ledger.  They must never
-- be stored as business expenses, because that would distort P&L.
CREATE TABLE IF NOT EXISTS owner_personal_transactions(
  personal_use_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  line_user_id TEXT NOT NULL,
  transaction_type TEXT NOT NULL CHECK(transaction_type IN ('PERSONAL_USE','PERSONAL_RETURN')),
  description TEXT NOT NULL,
  amount_satang INTEGER NOT NULL CHECK(amount_satang>0),
  source_wallet TEXT NOT NULL CHECK(source_wallet IN ('SHOP_BANK','CASH_DRAWER')),
  transaction_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('WAITING_CONFIRM','CONFIRMED','CANCELLED')),
  trace_id TEXT,
  submitted_by_employee_id TEXT,
  branch_id TEXT,
  reviewed_by_employee_id TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_owner_personal_transactions_month
  ON owner_personal_transactions(transaction_date,status,source_wallet);
CREATE TABLE IF NOT EXISTS owner_personal_transaction_audit(
  audit_id TEXT PRIMARY KEY,
  personal_use_id TEXT NOT NULL,
  actor_employee_id TEXT,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(personal_use_id) REFERENCES owner_personal_transactions(personal_use_id)
);
CREATE INDEX IF NOT EXISTS idx_owner_personal_audit_event
  ON owner_personal_transaction_audit(personal_use_id,created_at);
