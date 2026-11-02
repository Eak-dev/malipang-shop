-- A RUNNING row is not evidence that old workers or external editors stopped.
-- An independently verified cutover must explicitly hold and drain them.
CREATE TABLE IF NOT EXISTS daily_legacy_writer_gates (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('OPEN','HOLD')),
  generation TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_name)
);
