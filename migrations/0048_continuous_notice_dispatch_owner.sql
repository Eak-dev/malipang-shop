-- Re-runnable except the ALTER TABLE ... ADD COLUMN, which SQLite cannot make
-- conditional. If a partial apply is ever suspected, use
-- scripts/migration-forward-fix.mjs to emit this file without that statement.
-- A phase is owned by one invocation. Owner never changes after claim and a
-- timed-out RUNNING phase is held rather than stolen or executed a second time.
ALTER TABLE continuous_notice_dispatches ADD COLUMN owner_token TEXT;
DROP TRIGGER IF EXISTS continuous_notice_dispatch_transition;
CREATE TRIGGER IF NOT EXISTS continuous_notice_dispatch_transition BEFORE UPDATE ON continuous_notice_dispatches
WHEN NEW.dispatch_id IS NOT OLD.dispatch_id OR NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.operation_token IS NOT OLD.operation_token OR NEW.expense_id IS NOT OLD.expense_id OR NEW.source_version IS NOT OLD.source_version OR NEW.sequence IS NOT OLD.sequence OR NEW.safe_retry IS NOT OLD.safe_retry OR NEW.created_at IS NOT OLD.created_at OR NOT ((OLD.state='PENDING' AND NEW.state='RUNNING' AND NEW.outcome IS NULL) OR (OLD.state='PENDING' AND NEW.state='HELD' AND NEW.outcome='RUNNER_CRASH') OR (OLD.state='RUNNING' AND NEW.state='DONE' AND NEW.outcome IN ('IN_PROGRESS','SAFE_RETRY','RESUMED','ALREADY_COMPLETED')) OR (OLD.state='RUNNING' AND NEW.state='HELD' AND NEW.outcome IN ('OUTCOME_UNKNOWN','RETRY_EXHAUSTED','RUNNER_CRASH')))
BEGIN SELECT RAISE(ABORT,'notice dispatch transition invalid'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_dispatch_owner_insert BEFORE INSERT ON continuous_notice_dispatches WHEN NEW.owner_token IS NOT NULL BEGIN SELECT RAISE(ABORT,'pending phase cannot have owner'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_dispatch_owner_update BEFORE UPDATE ON continuous_notice_dispatches WHEN NOT ((OLD.state='PENDING' AND NEW.state='RUNNING' AND OLD.owner_token IS NULL AND NEW.owner_token IS NOT NULL AND length(NEW.owner_token)=36 AND NEW.owner_token GLOB '????????-????-????-????-????????????') OR (OLD.state='PENDING' AND NEW.state='HELD' AND OLD.owner_token IS NULL AND NEW.owner_token IS NULL) OR (OLD.state='RUNNING' AND NEW.state IN ('DONE','HELD') AND NEW.owner_token IS OLD.owner_token)) BEGIN SELECT RAISE(ABORT,'notice dispatch owner invalid'); END;
