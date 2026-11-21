-- Additive foundation only. It does not authorize a Sheets write or infer
-- preimages for projections made before this migration.
CREATE TABLE IF NOT EXISTS stable_expense_projection_preimages (
 spreadsheet_id TEXT NOT NULL,
 entity_type TEXT NOT NULL DEFAULT 'EXPENSE' CHECK(entity_type='EXPENSE'),
 entity_id TEXT NOT NULL,
 projection TEXT NOT NULL CHECK(projection IN ('DAILY','EXPENSE_RAW','DETAIL')),
 sheet_id INTEGER NOT NULL CHECK(typeof(sheet_id)='integer' AND sheet_id>=0),
 sheet_name TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(typeof(source_version)='integer' AND source_version>0),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
 preimage_width INTEGER NOT NULL CHECK(typeof(preimage_width)='integer' AND preimage_width BETWEEN 1 AND 100),
 preimage_digest TEXT NOT NULL CHECK(length(preimage_digest)=64 AND preimage_digest NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL,
 PRIMARY KEY(spreadsheet_id,entity_type,entity_id,projection),
 FOREIGN KEY(spreadsheet_id,entity_type,entity_id,projection) REFERENCES stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection)
);
CREATE TRIGGER IF NOT EXISTS stable_expense_preimage_verified_source BEFORE INSERT ON stable_expense_projection_preimages
WHEN NOT EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_type=NEW.entity_type AND p.entity_id=NEW.entity_id AND p.projection=NEW.projection AND p.sheet_id=NEW.sheet_id AND p.sheet_name=NEW.sheet_name AND p.source_version=NEW.source_version AND p.source_digest=NEW.source_digest AND p.state='VERIFIED')
BEGIN SELECT RAISE(ABORT,'unverified projection preimage'); END;
CREATE TRIGGER IF NOT EXISTS stable_expense_preimage_no_update BEFORE UPDATE ON stable_expense_projection_preimages
BEGIN SELECT RAISE(ABORT,'projection preimage retained'); END;
CREATE TRIGGER IF NOT EXISTS stable_expense_preimage_no_delete BEFORE DELETE ON stable_expense_projection_preimages
BEGIN SELECT RAISE(ABORT,'projection preimage retained'); END;
CREATE TRIGGER IF NOT EXISTS stable_expense_preimage_no_replace BEFORE INSERT ON stable_expense_projection_preimages
WHEN EXISTS(SELECT 1 FROM stable_expense_projection_preimages p WHERE p.rowid=NEW.rowid OR (p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_type=NEW.entity_type AND p.entity_id=NEW.entity_id AND p.projection=NEW.projection))
BEGIN SELECT RAISE(ABORT,'projection preimage collision'); END;

CREATE TABLE IF NOT EXISTS stable_expense_cancellation_writes (
 spreadsheet_id TEXT NOT NULL,
 entity_type TEXT NOT NULL DEFAULT 'EXPENSE' CHECK(entity_type='EXPENSE'),
 entity_id TEXT NOT NULL,
 projection TEXT NOT NULL CHECK(projection IN ('DAILY','EXPENSE_RAW','DETAIL')),
 cancellation_version INTEGER NOT NULL CHECK(typeof(cancellation_version)='integer' AND cancellation_version>0),
 previous_version INTEGER NOT NULL CHECK(typeof(previous_version)='integer' AND previous_version>0 AND cancellation_version>previous_version),
 preimage_digest TEXT NOT NULL CHECK(length(preimage_digest)=64 AND preimage_digest NOT GLOB '*[^0-9a-f]*'),
 operation_token TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('IN_FLIGHT','VERIFIED','REVIEW')),
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(spreadsheet_id,entity_type,entity_id,projection,cancellation_version),
 FOREIGN KEY(spreadsheet_id,entity_type,entity_id,projection) REFERENCES stable_expense_projection_preimages(spreadsheet_id,entity_type,entity_id,projection)
);
CREATE TRIGGER IF NOT EXISTS stable_expense_cancel_preimage_required BEFORE INSERT ON stable_expense_cancellation_writes
WHEN NEW.state<>'IN_FLIGHT' OR NOT EXISTS(SELECT 1 FROM stable_expense_projection_preimages p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_type=NEW.entity_type AND p.entity_id=NEW.entity_id AND p.projection=NEW.projection AND p.source_version=NEW.previous_version AND p.preimage_digest=NEW.preimage_digest)
BEGIN SELECT RAISE(ABORT,'cancellation preimage unverified'); END;
CREATE TRIGGER IF NOT EXISTS stable_expense_cancel_no_delete BEFORE DELETE ON stable_expense_cancellation_writes
BEGIN SELECT RAISE(ABORT,'cancellation write retained'); END;
CREATE TRIGGER IF NOT EXISTS stable_expense_cancel_no_replace BEFORE INSERT ON stable_expense_cancellation_writes
WHEN EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.rowid=NEW.rowid OR (p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_type=NEW.entity_type AND p.entity_id=NEW.entity_id AND p.projection=NEW.projection AND p.cancellation_version=NEW.cancellation_version))
BEGIN SELECT RAISE(ABORT,'cancellation write collision'); END;
CREATE TRIGGER IF NOT EXISTS stable_expense_cancel_transition BEFORE UPDATE ON stable_expense_cancellation_writes
WHEN OLD.rowid IS NOT NEW.rowid OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.entity_type IS NOT NEW.entity_type OR OLD.entity_id IS NOT NEW.entity_id OR OLD.projection IS NOT NEW.projection OR OLD.cancellation_version IS NOT NEW.cancellation_version OR OLD.previous_version IS NOT NEW.previous_version OR OLD.preimage_digest IS NOT NEW.preimage_digest OR OLD.operation_token IS NOT NEW.operation_token OR OLD.created_at IS NOT NEW.created_at OR OLD.state<>'IN_FLIGHT' OR NEW.state NOT IN ('VERIFIED','REVIEW')
BEGIN SELECT RAISE(ABORT,'invalid cancellation transition'); END;
