-- Durable uncertainty barrier. No automatic deletion or retry is permitted.
CREATE TABLE IF NOT EXISTS expense_owner_correction_move_marker_dispatch(
  correction_id TEXT PRIMARY KEY REFERENCES expense_owner_correction_move_reservations(correction_id),
  dispatch_id TEXT NOT NULL UNIQUE,
  sheet_name TEXT NOT NULL,
  sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
  row_number INTEGER NOT NULL CHECK(row_number>0),
  metadata_id INTEGER NOT NULL CHECK(metadata_id BETWEEN 1 AND 2147483647),
  fence_token TEXT NOT NULL,
  not_before TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','VERIFIED','REVIEW')),
  created_at TEXT NOT NULL
);
