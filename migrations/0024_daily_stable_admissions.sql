-- Proof of source order; no sheet row numbers are stored. Admissions are
-- appended in the same D1 transaction that inserts the expense event.
CREATE TABLE IF NOT EXISTS daily_stable_source_admissions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id TEXT NOT NULL UNIQUE,
  admitted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER IF NOT EXISTS daily_stable_admit_expense
AFTER INSERT ON expense_events BEGIN
  INSERT OR IGNORE INTO daily_stable_source_admissions(expense_id) VALUES (NEW.expense_id);
END;

-- PREPARED is not authority to write. ACTIVE also requires independently
-- proven writer cutover and an editing protocol outside this table.
CREATE TABLE IF NOT EXISTS daily_stable_cutovers (
  spreadsheet_id TEXT PRIMARY KEY,
  sheet_name TEXT NOT NULL,
  generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','ACTIVE','HELD')),
  source_watermark INTEGER CHECK(source_watermark >= 0),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  CHECK(state <> 'ACTIVE' OR (source_watermark IS NOT NULL AND activated_at IS NOT NULL))
);
