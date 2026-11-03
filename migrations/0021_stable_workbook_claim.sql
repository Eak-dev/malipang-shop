-- A claim never expires into permission to write. An uncertain operation stays
-- held until separately reviewed. This table stores no row positions.
CREATE TABLE IF NOT EXISTS stable_workbook_claims (
  spreadsheet_id TEXT PRIMARY KEY,
  operation_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('HELD','REVIEW')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
