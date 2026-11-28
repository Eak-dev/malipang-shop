-- Preserve only the historical DAILY settlement audit. The rest of
-- admin_audit keeps its existing maintenance behavior.
CREATE TRIGGER IF NOT EXISTS issue296_historical_daily_audit_no_update
BEFORE UPDATE ON admin_audit
WHEN OLD.id GLOB 'issue296:historical-daily:*' OR NEW.id GLOB 'issue296:historical-daily:*'
 OR (NEW.rowid<>OLD.rowid AND EXISTS(SELECT 1 FROM admin_audit WHERE rowid=NEW.rowid AND id GLOB 'issue296:historical-daily:*'))
BEGIN SELECT RAISE(ABORT,'historical daily audit is immutable'); END;

CREATE TRIGGER IF NOT EXISTS issue296_historical_daily_audit_no_delete
BEFORE DELETE ON admin_audit
WHEN OLD.id GLOB 'issue296:historical-daily:*'
BEGIN SELECT RAISE(ABORT,'historical daily audit is immutable'); END;

CREATE TRIGGER IF NOT EXISTS issue296_historical_daily_audit_no_replace
BEFORE INSERT ON admin_audit
WHEN EXISTS(SELECT 1 FROM admin_audit WHERE (rowid=NEW.rowid OR id=NEW.id) AND id GLOB 'issue296:historical-daily:*')
BEGIN SELECT RAISE(ABORT,'historical daily audit is immutable'); END;
