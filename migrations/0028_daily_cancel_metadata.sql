-- Dependency: 0024. A cancellation stage may finish after later RAW/detail
-- stages, so retain only the posting month and target identity needed to
-- verify its final balance; do not retain the original receipt payload here.
CREATE TABLE IF NOT EXISTS stable_daily_cancellation_metadata (
 spreadsheet_id TEXT NOT NULL,
 entity_type TEXT NOT NULL DEFAULT 'EXPENSE' CHECK(entity_type='EXPENSE'),
 entity_id TEXT NOT NULL,
 projection TEXT NOT NULL DEFAULT 'DAILY' CHECK(projection='DAILY'),
 cancellation_version INTEGER NOT NULL CHECK(typeof(cancellation_version)='integer' AND cancellation_version>1),
 sheet_id INTEGER NOT NULL CHECK(typeof(sheet_id)='integer' AND sheet_id>=0),
 sheet_name TEXT NOT NULL CHECK(length(sheet_name)>0),
 posting_year INTEGER NOT NULL CHECK(typeof(posting_year)='integer' AND posting_year BETWEEN 1900 AND 9999),
 posting_month INTEGER NOT NULL CHECK(typeof(posting_month)='integer' AND posting_month BETWEEN 1 AND 12),
 operation_token TEXT NOT NULL CHECK(length(operation_token)>0),
 created_at TEXT NOT NULL,
 PRIMARY KEY(spreadsheet_id,entity_type,entity_id,projection,cancellation_version),
 FOREIGN KEY(spreadsheet_id,entity_type,entity_id,projection,cancellation_version) REFERENCES stable_expense_cancellation_writes(spreadsheet_id,entity_type,entity_id,projection,cancellation_version)
);
CREATE TRIGGER IF NOT EXISTS stable_daily_cancel_meta_bound BEFORE INSERT ON stable_daily_cancellation_metadata
WHEN NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c JOIN stable_expense_projection_preimages p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type=c.entity_type AND p.entity_id=c.entity_id AND p.projection=c.projection WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.entity_type=NEW.entity_type AND c.entity_id=NEW.entity_id AND c.projection=NEW.projection AND c.cancellation_version=NEW.cancellation_version AND c.operation_token=NEW.operation_token AND c.state='IN_FLIGHT' AND p.sheet_id=NEW.sheet_id AND p.sheet_name=NEW.sheet_name AND p.source_version=c.previous_version AND p.preimage_digest=c.preimage_digest)
BEGIN SELECT RAISE(ABORT,'daily cancellation metadata source unverified'); END;
CREATE TRIGGER IF NOT EXISTS stable_daily_cancel_meta_no_update BEFORE UPDATE ON stable_daily_cancellation_metadata
BEGIN SELECT RAISE(ABORT,'daily cancellation metadata retained'); END;
CREATE TRIGGER IF NOT EXISTS stable_daily_cancel_meta_no_delete BEFORE DELETE ON stable_daily_cancellation_metadata
BEGIN SELECT RAISE(ABORT,'daily cancellation metadata retained'); END;
CREATE TRIGGER IF NOT EXISTS stable_daily_cancel_meta_no_replace BEFORE INSERT ON stable_daily_cancellation_metadata
WHEN EXISTS(SELECT 1 FROM stable_daily_cancellation_metadata m WHERE m.rowid=NEW.rowid OR (m.spreadsheet_id=NEW.spreadsheet_id AND m.entity_type=NEW.entity_type AND m.entity_id=NEW.entity_id AND m.projection=NEW.projection AND m.cancellation_version=NEW.cancellation_version))
BEGIN SELECT RAISE(ABORT,'daily cancellation metadata collision'); END;
