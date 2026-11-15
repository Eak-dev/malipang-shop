-- Automatic post-cutover expense epochs are strictly one per source version.
-- Old jobs and other entity types remain fenced by the recovery gate.
CREATE TABLE IF NOT EXISTS continuous_normal_recovery_admissions (
 epoch_id TEXT PRIMARY KEY REFERENCES stable_recovery_epochs(epoch_id),
 spreadsheet_id TEXT NOT NULL,
 expense_id TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(source_version IN (1,2)),
 created_at TEXT NOT NULL,
 UNIQUE(spreadsheet_id,expense_id,source_version)
);
CREATE TRIGGER IF NOT EXISTS continuous_normal_recovery_insert BEFORE INSERT ON continuous_normal_recovery_admissions
WHEN NOT EXISTS(SELECT 1 FROM stable_recovery_epochs r JOIN continuous_daily_cutovers c ON c.spreadsheet_id=r.spreadsheet_id AND c.state='ACTIVE' JOIN continuous_daily_post_cutover_expenses p ON p.spreadsheet_id=c.spreadsheet_id AND p.expense_id=r.target_key JOIN expense_events e ON e.expense_id=p.expense_id JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE r.epoch_id=NEW.epoch_id AND r.spreadsheet_id=NEW.spreadsheet_id AND r.state='ARMED' AND r.target_type='EXPENSE' AND r.target_key=NEW.expense_id AND r.target_version=NEW.source_version AND e.version=NEW.source_version AND ((e.status='CONFIRMED' AND e.version=1) OR (e.status='CANCELLED' AND e.version=2)) AND j.status='PENDING' AND j.attempt_count=0 AND j.lease_token IS NULL AND j.lease_until IS NULL)
 OR NOT EXISTS(SELECT 1 FROM continuous_canary_operator t WHERE t.spreadsheet_id=NEW.spreadsheet_id AND t.state='VERIFIED' AND t.expense_id<>NEW.expense_id)
 OR NOT EXISTS(SELECT 1 FROM continuous_cutover_operator o WHERE o.spreadsheet_id=NEW.spreadsheet_id AND o.state='COMPLETE')
 OR EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.state<>'VERIFIED')
 OR EXISTS(SELECT 1 FROM stable_expense_cancellation_writes p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.state<>'VERIFIED')
 OR EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND f.job_key IN ('EXPENSE:'||NEW.expense_id||':1','EXPENSE:'||NEW.expense_id||':2'))
 OR EXISTS(SELECT 1 FROM continuous_normal_recovery_admissions a WHERE a.rowid=NEW.rowid OR (a.spreadsheet_id=NEW.spreadsheet_id AND a.expense_id=NEW.expense_id AND a.source_version=NEW.source_version))
BEGIN SELECT RAISE(ABORT,'continuous normal recovery admission rejected'); END;
CREATE TRIGGER IF NOT EXISTS continuous_normal_recovery_no_update BEFORE UPDATE ON continuous_normal_recovery_admissions BEGIN SELECT RAISE(ABORT,'continuous normal recovery retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_normal_recovery_no_delete BEFORE DELETE ON continuous_normal_recovery_admissions BEGIN SELECT RAISE(ABORT,'continuous normal recovery retained'); END;
