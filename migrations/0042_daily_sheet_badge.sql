-- Existing, explicitly provisioned named ranges only. No row/column position
-- is persisted. Unknown writes are REVIEW and are never automatically replayed.
CREATE TABLE IF NOT EXISTS daily_sheet_badge_journal (
  spreadsheet_id TEXT NOT NULL,
  sheet_id INTEGER NOT NULL,
  state_range_id TEXT NOT NULL,
  time_range_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('READY','IN_FLIGHT','REVIEW','RESTORED')),
  preimage_json TEXT NOT NULL CHECK(length(preimage_json)<=32768),
  expected_values_json TEXT NOT NULL CHECK(length(expected_values_json)<=1024),
  operation_token TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,sheet_id),
  UNIQUE(spreadsheet_id),
  UNIQUE(spreadsheet_id,state_range_id),
  UNIQUE(spreadsheet_id,time_range_id),
  CHECK(state_range_id<>time_range_id),
  CHECK((state='IN_FLIGHT' AND operation_token IS NOT NULL) OR (state<>'IN_FLIGHT' AND operation_token IS NULL))
);
