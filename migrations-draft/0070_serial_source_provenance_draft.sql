-- Experimental source identity fence. This is NOT a provider quiescence proof
-- or a release mechanism; no production activation is authorized here.
ALTER TABLE expense_events ADD COLUMN serial_source_namespace TEXT;
CREATE TABLE IF NOT EXISTS serial_source_provenance_activation(
 singleton INTEGER PRIMARY KEY CHECK(singleton=1), spreadsheet_id TEXT NOT NULL CHECK(length(spreadsheet_id) BETWEEN 1 AND 256),
 namespace TEXT NOT NULL CHECK(length(namespace)=32 AND namespace NOT GLOB '*[^0-9a-f]*'), activated_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS serial_source_provenance_not_ready BEFORE INSERT ON serial_source_provenance_activation BEGIN SELECT RAISE(ABORT,'source provenance not ready'); END;
CREATE TRIGGER IF NOT EXISTS serial_source_provenance_no_update BEFORE UPDATE ON serial_source_provenance_activation BEGIN SELECT RAISE(ABORT,'source activation immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_source_provenance_no_delete BEFORE DELETE ON serial_source_provenance_activation BEGIN SELECT RAISE(ABORT,'source activation retained'); END;
CREATE TRIGGER IF NOT EXISTS serial_source_provenance_no_replace BEFORE INSERT ON serial_source_provenance_activation WHEN EXISTS(SELECT 1 FROM serial_source_provenance_activation WHERE singleton=NEW.singleton OR rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'source activation collision'); END;
-- This check detects known collisions, but absence is NOT proof that no old
-- provider request exists. The independent external-writer gate is still needed.
CREATE TRIGGER IF NOT EXISTS serial_source_provenance_namespace_guard BEFORE INSERT ON serial_source_provenance_activation
WHEN EXISTS(SELECT 1 FROM expense_events WHERE substr(expense_id,1,37)='exp_'||NEW.namespace||'_')
 OR EXISTS(SELECT 1 FROM sync_jobs WHERE entity_type='EXPENSE' AND substr(entity_key,1,37)='exp_'||NEW.namespace||'_')
BEGIN SELECT RAISE(ABORT,'source namespace already used'); END;
CREATE TRIGGER IF NOT EXISTS serial_source_provenance_insert_guard BEFORE INSERT ON expense_events
WHEN (NEW.serial_source_namespace IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM serial_source_provenance_activation a WHERE a.singleton=1 AND a.namespace=NEW.serial_source_namespace
  AND substr(NEW.expense_id,1,37)='exp_'||a.namespace||'_' AND length(NEW.expense_id)=73
  AND substr(NEW.expense_id,46,1)='-' AND substr(NEW.expense_id,51,1)='-' AND substr(NEW.expense_id,56,1)='-' AND substr(NEW.expense_id,61,1)='-'
  AND length(replace(substr(NEW.expense_id,38),'-',''))=32 AND replace(substr(NEW.expense_id,38),'-','') NOT GLOB '*[^0-9a-f]*'
  AND NEW.status='WAITING_CONFIRM' AND NEW.version=1
  AND NOT EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='serial_source_provenance_not_ready')
  AND (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_source_provenance_no_update','serial_source_provenance_no_delete','serial_source_provenance_no_replace','serial_source_provenance_namespace_guard','serial_source_provenance_insert_guard','serial_source_provenance_update_guard','serial_source_provenance_delete_guard'))=7))
 OR (NEW.serial_source_namespace IS NULL AND EXISTS(SELECT 1 FROM serial_source_provenance_activation a WHERE a.singleton=1 AND substr(NEW.expense_id,1,37)='exp_'||a.namespace||'_'))
 OR EXISTS(SELECT 1 FROM expense_events old WHERE (old.expense_id=NEW.expense_id OR old.rowid=NEW.rowid OR old.message_id=NEW.message_id) AND (old.serial_source_namespace IS NOT NULL OR NEW.serial_source_namespace IS NOT NULL))
BEGIN SELECT RAISE(ABORT,'source provenance insert invalid'); END;
CREATE TRIGGER IF NOT EXISTS serial_source_provenance_update_guard BEFORE UPDATE ON expense_events
WHEN NEW.serial_source_namespace IS NOT OLD.serial_source_namespace OR (OLD.serial_source_namespace IS NOT NULL AND NEW.expense_id IS NOT OLD.expense_id)
BEGIN SELECT RAISE(ABORT,'source provenance immutable'); END;
CREATE TRIGGER IF NOT EXISTS serial_source_provenance_delete_guard BEFORE DELETE ON expense_events WHEN OLD.serial_source_namespace IS NOT NULL BEGIN SELECT RAISE(ABORT,'source provenance retained'); END;
-- A job counter is positive only for a source born in the same protected
-- namespace and workbook. Existing/unknown sources remain version 0.
CREATE TRIGGER IF NOT EXISTS serial_source_job_birth_guard BEFORE INSERT ON sync_jobs
WHEN NEW.serial_provenance_version=1 AND (
 NOT EXISTS(SELECT 1 FROM expense_events e JOIN serial_source_provenance_activation s ON s.namespace=e.serial_source_namespace JOIN serial_job_provenance_activation j ON j.spreadsheet_id=s.spreadsheet_id WHERE e.expense_id=NEW.entity_key AND e.version=NEW.entity_version AND e.status='CONFIRMED' AND s.singleton=1 AND j.singleton=1)
 OR EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name IN ('serial_source_provenance_not_ready','serial_job_provenance_not_ready'))
 OR (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('serial_source_provenance_no_update','serial_source_provenance_no_delete','serial_source_provenance_no_replace','serial_source_provenance_namespace_guard','serial_source_provenance_insert_guard','serial_source_provenance_update_guard','serial_source_provenance_delete_guard','serial_source_job_birth_guard'))<>8)
BEGIN SELECT RAISE(ABORT,'source job birth unverified'); END;
