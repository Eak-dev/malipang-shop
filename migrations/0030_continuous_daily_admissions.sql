-- Exact-source admissions are inert until separately reconciled; this journal
-- stores only hashes of provider evidence, never receipt contents.
CREATE TABLE IF NOT EXISTS continuous_daily_source_admissions (
 spreadsheet_id TEXT NOT NULL,
 expense_id TEXT NOT NULL,
 source_version INTEGER NOT NULL CHECK(typeof(source_version)='integer' AND source_version>0),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
 provider_digest TEXT NOT NULL CHECK(length(provider_digest)=64 AND provider_digest NOT GLOB '*[^0-9a-f]*'),
 source_revision INTEGER NOT NULL CHECK(typeof(source_revision)='integer' AND source_revision>=0),
 claim_token TEXT NOT NULL,
 admitted_at TEXT NOT NULL,
 PRIMARY KEY(spreadsheet_id,expense_id,source_version,source_digest),
 FOREIGN KEY(spreadsheet_id) REFERENCES continuous_daily_cutovers(spreadsheet_id)
);
CREATE TRIGGER IF NOT EXISTS continuous_daily_admission_insert BEFORE INSERT ON continuous_daily_source_admissions
WHEN NOT EXISTS(SELECT 1 FROM continuous_daily_cutovers c JOIN continuous_daily_pre_cutover_expenses p ON p.spreadsheet_id=c.spreadsheet_id WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.state='ACTIVE' AND p.expense_id=NEW.expense_id)
 OR NOT EXISTS(SELECT 1 FROM stable_sync_cutover WHERE singleton=1 AND state='ACTIVE')
 OR EXISTS(SELECT 1 FROM continuous_daily_post_cutover_expenses p WHERE p.spreadsheet_id=NEW.spreadsheet_id AND p.expense_id=NEW.expense_id)
 OR NOT EXISTS(SELECT 1 FROM stable_workbook_claims c WHERE c.spreadsheet_id=NEW.spreadsheet_id AND c.operation_token=NEW.claim_token AND c.state='HELD')
 OR NOT EXISTS(SELECT 1 FROM stable_source_revision r WHERE r.singleton=1 AND r.revision=NEW.source_revision)
 OR NOT EXISTS(SELECT 1 FROM expense_events e JOIN sync_jobs j ON j.entity_type='EXPENSE' AND j.entity_key=e.expense_id AND j.entity_version=e.version WHERE e.expense_id=NEW.expense_id AND e.version=NEW.source_version AND e.version=1 AND e.status='CONFIRMED' AND j.status='PROCESSING' AND j.attempt_count=1 AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 OR EXISTS(SELECT 1 FROM stable_pre_cutover_sources s WHERE s.entity_type='EXPENSE' AND s.entity_id=NEW.expense_id)
 OR EXISTS(SELECT 1 FROM sync_jobs j WHERE j.entity_type='EXPENSE' AND j.entity_key=NEW.expense_id AND j.entity_version<>NEW.source_version)
 OR EXISTS(SELECT 1 FROM stable_projection_writes p WHERE p.entity_type='EXPENSE' AND (p.entity_id=NEW.expense_id OR substr(p.entity_id,1,length(NEW.expense_id)+1)=NEW.expense_id||'|'))
 OR EXISTS(SELECT 1 FROM stable_expense_cancellation_writes w WHERE w.entity_type='EXPENSE' AND (w.entity_id=NEW.expense_id OR substr(w.entity_id,1,length(NEW.expense_id)+1)=NEW.expense_id||'|'))
 OR EXISTS(SELECT 1 FROM sheet_row_index i WHERE i.entity_key=NEW.expense_id OR substr(i.entity_key,1,length(NEW.expense_id)+1)=NEW.expense_id||'|')
 OR EXISTS(SELECT 1 FROM failed_jobs f WHERE f.queue_name='malipang-jobs' AND substr(f.job_key,1,length(NEW.expense_id)+9)='EXPENSE:'||NEW.expense_id||':')
BEGIN SELECT RAISE(ABORT,'continuous daily admission rejected'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_admission_no_delete BEFORE DELETE ON continuous_daily_source_admissions
BEGIN SELECT RAISE(ABORT,'continuous daily admission retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_admission_no_update BEFORE UPDATE ON continuous_daily_source_admissions
BEGIN SELECT RAISE(ABORT,'continuous daily admission immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_daily_admission_no_replace BEFORE INSERT ON continuous_daily_source_admissions
WHEN EXISTS(SELECT 1 FROM continuous_daily_source_admissions a WHERE a.rowid=NEW.rowid OR (a.spreadsheet_id=NEW.spreadsheet_id AND a.expense_id=NEW.expense_id AND a.source_version=NEW.source_version AND a.source_digest=NEW.source_digest))
BEGIN SELECT RAISE(ABORT,'continuous daily admission collision'); END;
