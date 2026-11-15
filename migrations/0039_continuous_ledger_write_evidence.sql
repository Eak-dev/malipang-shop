-- Immutable positive proof reserved before a helper-ledger mutation. It is
-- never authority to replay a missing or still-unknown request.
CREATE TABLE IF NOT EXISTS continuous_ledger_write_evidence (
 spreadsheet_id TEXT NOT NULL,
 entity_id TEXT NOT NULL,
 projection TEXT NOT NULL CHECK(projection IN ('EXPENSE_RAW','DETAIL')),
 operation_kind TEXT NOT NULL CHECK(operation_kind IN ('CONFIRM','CANCEL')),
 sheet_id INTEGER NOT NULL CHECK(sheet_id>=0),
 sheet_name TEXT NOT NULL CHECK(length(sheet_name)>0),
 source_version INTEGER NOT NULL CHECK(source_version>0),
 operation_token TEXT NOT NULL CHECK(length(operation_token)>0),
 cancel_source_revision INTEGER,
 cancel_source_fingerprint TEXT,
 marker TEXT NOT NULL CHECK(length(marker)=36 AND substr(marker,5) NOT GLOB '*[^0-9a-f]*' AND ((operation_kind='CONFIRM' AND substr(marker,1,4)='LWC_') OR (operation_kind='CANCEL' AND substr(marker,1,4)='LXC_'))),
 target_row INTEGER NOT NULL CHECK(target_row>=2 AND target_row<=5000),
 before_rows INTEGER NOT NULL CHECK(before_rows>=2 AND before_rows<=5000),
 write_mode TEXT NOT NULL CHECK(write_mode IN ('REPLACE','APPEND')),
 before_digest TEXT NOT NULL CHECK(length(before_digest)=64 AND before_digest NOT GLOB '*[^0-9a-f]*'),
 payload_digest TEXT NOT NULL CHECK(length(payload_digest)=64 AND payload_digest NOT GLOB '*[^0-9a-f]*'),
 created_at TEXT NOT NULL,
 CHECK((write_mode='REPLACE' AND target_row<=before_rows) OR (write_mode='APPEND' AND operation_kind='CONFIRM' AND target_row=before_rows+1 AND before_rows<5000)),
 CHECK((operation_kind='CONFIRM' AND cancel_source_revision IS NULL AND cancel_source_fingerprint IS NULL) OR (operation_kind='CANCEL' AND cancel_source_revision IS NOT NULL AND cancel_source_revision>=0 AND cancel_source_fingerprint IS NOT NULL AND length(cancel_source_fingerprint)=64 AND cancel_source_fingerprint NOT GLOB '*[^0-9a-f]*')),
 PRIMARY KEY(spreadsheet_id,entity_id,projection,operation_kind,source_version)
);
CREATE TRIGGER IF NOT EXISTS continuous_ledger_evidence_source BEFORE INSERT ON continuous_ledger_write_evidence
WHEN (NEW.operation_kind='CONFIRM' AND NOT EXISTS(SELECT 1 FROM stable_projection_writes p JOIN atomic_daily_marker_reservations m ON m.spreadsheet_id=p.spreadsheet_id AND m.sheet_id=p.sheet_id AND m.entity_id=p.entity_id AND m.source_version=p.source_version AND m.operation_token=p.operation_token WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=NEW.entity_id AND p.projection=NEW.projection AND p.sheet_id=NEW.sheet_id AND p.sheet_name=NEW.sheet_name AND p.source_version=NEW.source_version AND p.operation_token=NEW.operation_token AND p.state='IN_FLIGHT'))
 OR (NEW.operation_kind='CANCEL' AND NOT EXISTS(SELECT 1 FROM stable_expense_cancellation_writes c JOIN stable_projection_writes p ON p.spreadsheet_id=c.spreadsheet_id AND p.entity_type=c.entity_type AND p.entity_id=c.entity_id AND p.projection=c.projection JOIN stable_source_revision r ON r.singleton=1 AND r.revision=NEW.cancel_source_revision WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.entity_type='EXPENSE' AND c.entity_id=NEW.entity_id AND c.projection=NEW.projection AND c.cancellation_version=NEW.source_version AND c.operation_token=NEW.operation_token AND c.state='IN_FLIGHT' AND p.state='VERIFIED' AND p.sheet_id=NEW.sheet_id AND p.sheet_name=NEW.sheet_name))
BEGIN SELECT RAISE(ABORT,'ledger evidence requires exact intent'); END;
CREATE TRIGGER IF NOT EXISTS continuous_ledger_evidence_no_update BEFORE UPDATE ON continuous_ledger_write_evidence BEGIN SELECT RAISE(ABORT,'ledger evidence immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_ledger_evidence_no_delete BEFORE DELETE ON continuous_ledger_write_evidence BEGIN SELECT RAISE(ABORT,'ledger evidence retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_ledger_evidence_no_replace BEFORE INSERT ON continuous_ledger_write_evidence
WHEN EXISTS(SELECT 1 FROM continuous_ledger_write_evidence e WHERE e.rowid=NEW.rowid OR (e.spreadsheet_id=NEW.spreadsheet_id AND e.entity_id=NEW.entity_id AND e.projection=NEW.projection AND e.operation_kind=NEW.operation_kind AND e.source_version=NEW.source_version))
BEGIN SELECT RAISE(ABORT,'ledger evidence collision'); END;
