-- Experimental append-only marker reservations. This migration is not
-- deployed by the prototype and does not itself authorize any Sheet write.
-- Reserving a marker and the corresponding stable projection must happen
-- in the same D1 batch; a marker can never be reused for another request.
CREATE TABLE IF NOT EXISTS atomic_daily_marker_reservations (
 spreadsheet_id TEXT NOT NULL,
 sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
 marker TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(source_version>0),
 operation_token TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(spreadsheet_id,sheet_id,marker)
);
CREATE TRIGGER IF NOT EXISTS atomic_daily_marker_no_delete BEFORE DELETE ON atomic_daily_marker_reservations
BEGIN SELECT RAISE(ABORT,'atomic daily marker retained'); END;
CREATE TRIGGER IF NOT EXISTS atomic_daily_marker_no_update BEFORE UPDATE ON atomic_daily_marker_reservations
BEGIN SELECT RAISE(ABORT,'atomic daily marker immutable'); END;
CREATE TRIGGER IF NOT EXISTS atomic_daily_marker_no_replace BEFORE INSERT ON atomic_daily_marker_reservations
WHEN EXISTS(SELECT 1 FROM atomic_daily_marker_reservations r WHERE r.spreadsheet_id=NEW.spreadsheet_id AND r.sheet_id=NEW.sheet_id AND r.marker=NEW.marker)
BEGIN SELECT RAISE(ABORT,'atomic daily marker collision'); END;
