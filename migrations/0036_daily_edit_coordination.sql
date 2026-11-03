-- Candidate for the existing D1 database. There is deliberately no default
-- row: absence or an unknown prior state must not imply an editable window.
CREATE TABLE IF NOT EXISTS daily_edit_coordination (
  spreadsheet_id TEXT NOT NULL,
  sheet_name TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('AVAILABLE','NOTICE','SYNCING','REVIEW')),
  window_token TEXT,
  cutover_generation TEXT,
  notice_until TEXT,
  deadline TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_name),
  CHECK((state='AVAILABLE' AND window_token IS NULL AND cutover_generation IS NULL AND notice_until IS NULL AND deadline IS NULL) OR (state<>'AVAILABLE' AND window_token IS NOT NULL AND cutover_generation IS NOT NULL AND notice_until IS NOT NULL AND deadline IS NOT NULL))
);
