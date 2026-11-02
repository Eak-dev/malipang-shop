-- A D1 reservation is only a first step. Sheets identity and row contents
-- must be independently checked before any external write or promotion.
CREATE TABLE IF NOT EXISTS expense_owner_correction_move_reservations(
  correction_id TEXT PRIMARY KEY REFERENCES expense_owner_corrections(correction_id),
  expense_id TEXT NOT NULL REFERENCES expense_events(expense_id),
  owner_employee_id TEXT NOT NULL REFERENCES employees(employee_id),
  sheet_name TEXT NOT NULL,
  row_number INTEGER NOT NULL CHECK(row_number>0),
  mapping_key TEXT NOT NULL UNIQUE,
  metadata_id INTEGER NOT NULL UNIQUE CHECK(metadata_id BETWEEN 1 AND 2147483647),
  header_digest TEXT NOT NULL,
  creation_nonce TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('PREPARED','ACTIVE','REVIEW','RELEASED')),
  created_at TEXT NOT NULL
);
