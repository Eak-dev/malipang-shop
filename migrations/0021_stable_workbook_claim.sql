-- A claim never expires into permission to write. An uncertain operation stays
-- held until separately reviewed. This table stores no row positions.
CREATE TABLE IF NOT EXISTS stable_workbook_claims (
  spreadsheet_id TEXT PRIMARY KEY,
  operation_token TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('HELD','REVIEW')),
  notice_stamp TEXT,
  notice_identity TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Keeps proof that an ID was already dispatched or verified, without a row
-- number. A missing ID after dispatch is always a review, not a new append.
CREATE TABLE IF NOT EXISTS stable_projection_writes (
  spreadsheet_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('PERSONAL_USE','EXPENSE')),
  entity_id TEXT NOT NULL,
  projection TEXT NOT NULL CHECK(projection IN ('PERSONAL_RAW','EXPENSE_RAW','DAILY','DETAIL')),
  sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
  sheet_name TEXT NOT NULL,
  source_version INTEGER NOT NULL CHECK(source_version>0),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
  operation_token TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','VERIFIED','REVIEW')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id,entity_type,entity_id,projection)
);
CREATE TRIGGER IF NOT EXISTS stable_projection_no_delete BEFORE DELETE ON stable_projection_writes
BEGIN SELECT RAISE(ABORT,'stable projection retained'); END;
CREATE TRIGGER IF NOT EXISTS stable_projection_no_replace BEFORE INSERT ON stable_projection_writes
WHEN EXISTS(SELECT 1 FROM stable_projection_writes old WHERE old.rowid=NEW.rowid OR (old.spreadsheet_id=NEW.spreadsheet_id AND old.entity_type=NEW.entity_type AND old.entity_id=NEW.entity_id AND old.projection=NEW.projection))
BEGIN SELECT RAISE(ABORT,'stable projection collision'); END;
CREATE TRIGGER IF NOT EXISTS stable_projection_transition BEFORE UPDATE ON stable_projection_writes
WHEN OLD.rowid IS NOT NEW.rowid OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.entity_type IS NOT NEW.entity_type OR OLD.entity_id IS NOT NEW.entity_id OR OLD.projection IS NOT NEW.projection OR OLD.sheet_id IS NOT NEW.sheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR OLD.source_version IS NOT NEW.source_version OR OLD.source_digest IS NOT NEW.source_digest OR OLD.operation_token IS NOT NEW.operation_token OR OLD.state<>'IN_FLIGHT' OR NEW.state NOT IN ('VERIFIED','REVIEW')
BEGIN SELECT RAISE(ABORT,'stable projection transition invalid'); END;

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

-- A single source revision detects concurrent source changes without keeping
-- or guessing any Sheet row position.
CREATE TABLE IF NOT EXISTS stable_source_revision (
 singleton INTEGER PRIMARY KEY CHECK(singleton=1),
 revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0)
);
INSERT INTO stable_source_revision(singleton,revision) SELECT 1,0 WHERE NOT EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=1);
CREATE TRIGGER IF NOT EXISTS stable_source_revision_no_delete BEFORE DELETE ON stable_source_revision BEGIN SELECT RAISE(ABORT,'source revision retained'); END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_no_replace BEFORE INSERT ON stable_source_revision WHEN EXISTS(SELECT 1 FROM stable_source_revision WHERE singleton=NEW.singleton OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'source revision collision'); END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_monotonic BEFORE UPDATE ON stable_source_revision WHEN OLD.singleton IS NOT NEW.singleton OR NEW.revision<>OLD.revision+1 BEGIN SELECT RAISE(ABORT,'source revision invalid'); END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_events_insert AFTER INSERT ON expense_events
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_events_update AFTER UPDATE ON expense_events
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_events_delete AFTER DELETE ON expense_events
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_documents_insert AFTER INSERT ON expense_documents
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_documents_update AFTER UPDATE ON expense_documents
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_documents_delete AFTER DELETE ON expense_documents
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_document_links_insert AFTER INSERT ON expense_document_links
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_document_links_update AFTER UPDATE ON expense_document_links
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_document_links_delete AFTER DELETE ON expense_document_links
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_document_items_insert AFTER INSERT ON expense_document_items
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_document_items_update AFTER UPDATE ON expense_document_items
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_expense_document_items_delete AFTER DELETE ON expense_document_items
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_owner_personal_transactions_insert AFTER INSERT ON owner_personal_transactions
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_owner_personal_transactions_update AFTER UPDATE ON owner_personal_transactions
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
CREATE TRIGGER IF NOT EXISTS stable_source_revision_owner_personal_transactions_delete AFTER DELETE ON owner_personal_transactions
BEGIN UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1; SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'source revision missing') END; END;
