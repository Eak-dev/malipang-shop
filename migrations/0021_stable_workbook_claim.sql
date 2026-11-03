-- A claim never expires into permission to write. An uncertain operation stays
-- held until separately reviewed. This table stores no row positions.
CREATE TABLE IF NOT EXISTS stable_workbook_claims (
  spreadsheet_id TEXT PRIMARY KEY,
  operation_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('HELD','REVIEW')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- At the approved cutover a single transaction snapshots all existing source
-- identifiers, then activates this marker. Absence is not trusted beforehand.
CREATE TABLE IF NOT EXISTS stable_sync_cutover (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state TEXT NOT NULL CHECK(state IN ('PREPARED','ACTIVE')),
  activated_at TEXT
);
INSERT INTO stable_sync_cutover(singleton,state) SELECT 1,'PREPARED' WHERE NOT EXISTS(SELECT 1 FROM stable_sync_cutover WHERE singleton=1);
CREATE TABLE IF NOT EXISTS stable_pre_cutover_sources (
  entity_type TEXT NOT NULL CHECK(entity_type IN ('EXPENSE','PERSONAL_USE')),
  entity_id TEXT NOT NULL,
  PRIMARY KEY(entity_type,entity_id)
);
CREATE TRIGGER IF NOT EXISTS stable_pre_cutover_no_delete BEFORE DELETE ON stable_pre_cutover_sources
BEGIN SELECT RAISE(ABORT,'stable source snapshot retained'); END;
CREATE TRIGGER IF NOT EXISTS stable_pre_cutover_no_update BEFORE UPDATE ON stable_pre_cutover_sources
BEGIN SELECT RAISE(ABORT,'stable source snapshot immutable'); END;
CREATE TRIGGER IF NOT EXISTS stable_pre_cutover_no_replace BEFORE INSERT ON stable_pre_cutover_sources
WHEN EXISTS(SELECT 1 FROM stable_pre_cutover_sources old WHERE old.rowid=NEW.rowid OR (old.entity_type=NEW.entity_type AND old.entity_id=NEW.entity_id))
BEGIN SELECT RAISE(ABORT,'stable source snapshot collision'); END;
CREATE TRIGGER IF NOT EXISTS stable_cutover_no_delete BEFORE DELETE ON stable_sync_cutover
BEGIN SELECT RAISE(ABORT,'stable cutover retained'); END;
CREATE TRIGGER IF NOT EXISTS stable_cutover_no_replace BEFORE INSERT ON stable_sync_cutover
WHEN EXISTS(SELECT 1 FROM stable_sync_cutover old WHERE old.singleton=NEW.singleton OR old.rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'stable cutover collision'); END;
CREATE TRIGGER IF NOT EXISTS stable_cutover_transition BEFORE UPDATE ON stable_sync_cutover
WHEN OLD.singleton IS NOT NEW.singleton OR OLD.state<>'PREPARED' OR NEW.state<>'ACTIVE' OR NEW.activated_at IS NULL
  OR EXISTS(SELECT 1 FROM expense_events e WHERE NOT EXISTS(SELECT 1 FROM stable_pre_cutover_sources s WHERE s.entity_type='EXPENSE' AND s.entity_id=e.expense_id))
  OR EXISTS(SELECT 1 FROM owner_personal_transactions p WHERE NOT EXISTS(SELECT 1 FROM stable_pre_cutover_sources s WHERE s.entity_type='PERSONAL_USE' AND s.entity_id=p.personal_use_id))
BEGIN SELECT RAISE(ABORT,'stable cutover transition invalid'); END;
