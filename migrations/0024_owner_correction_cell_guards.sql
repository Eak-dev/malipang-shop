-- Temporary, narrowly scoped locks for the specific daily-sheet input cells
-- touched by a confirmed expense correction. Google allocates range IDs, so
-- unknown request outcomes are fenced until their provider-side deadline.
CREATE TABLE IF NOT EXISTS expense_owner_correction_cell_guards(
  correction_id TEXT PRIMARY KEY REFERENCES expense_owner_corrections(correction_id),
  expense_id TEXT NOT NULL REFERENCES expense_events(expense_id),
  expense_version INTEGER NOT NULL CHECK(expense_version>0),
  daily_metadata_id INTEGER NOT NULL CHECK(daily_metadata_id>0),
  sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
  columns_json TEXT NOT NULL CHECK(json_valid(columns_json)),
  guards_json TEXT CHECK(guards_json IS NULL OR json_valid(guards_json)),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','IN_FLIGHT','ACTIVE','REVIEW','REMOVING','REMOVED')),
  dispatch_token TEXT,
  not_before TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owner_correction_live_cell_guards
  ON expense_owner_correction_cell_guards(expense_id,expense_version) WHERE state<>'REMOVED';
CREATE INDEX IF NOT EXISTS idx_owner_correction_cell_guards_cleanup ON expense_owner_correction_cell_guards(state,updated_at);
