-- Durable, identity-minimized incident generations. The source transition and
-- incident creation run in the same SQLite transaction. No error payload,
-- recipient, merchant, amount, LINE identifier or provider response is stored.
CREATE TABLE IF NOT EXISTS sync_alert_incidents (
 incident_id INTEGER PRIMARY KEY AUTOINCREMENT,
 kind TEXT NOT NULL CHECK(kind IN ('JOB','WORKBOOK','TERMINAL')),
 source_id TEXT NOT NULL,
 category TEXT NOT NULL CHECK(category IN ('FAILED','MONTH_OPENING','ROW_FORMULA','CAPACITY','CANCELLED_OR_SUPERSEDED','REVIEW','WORKBOOK_REVIEW','TERMINAL')),
 state TEXT NOT NULL CHECK(state IN ('OPEN','CLOSED')),
 opened_at TEXT NOT NULL,
 closed_at TEXT,
 alerted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_alert_incident_one_open ON sync_alert_incidents(kind,source_id) WHERE state='OPEN';
CREATE INDEX IF NOT EXISTS sync_alert_incident_unsent ON sync_alert_incidents(alerted_at,incident_id);

CREATE TRIGGER IF NOT EXISTS sync_alert_job_insert AFTER INSERT ON sync_jobs
WHEN NEW.status IN ('FAILED','REVIEW')
BEGIN
 INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at)
 SELECT 'JOB',NEW.job_id, CASE WHEN NEW.status='FAILED' THEN 'FAILED'
  WHEN NEW.last_error='STABLE_DAILY_MONTH_OPENING_UNVERIFIED' THEN 'MONTH_OPENING'
  WHEN NEW.last_error='STABLE_DAILY_ROW_HELPER_FORMULA_UNVERIFIED' THEN 'ROW_FORMULA'
  WHEN NEW.last_error='STABLE_DAILY_CAPACITY' THEN 'CAPACITY'
  WHEN NEW.last_error IN ('STABLE_CANCELLED_SOURCE_REVIEW','STABLE_SUPERSEDED_SOURCE_REVIEW','STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED') THEN 'CANCELLED_OR_SUPERSEDED'
  ELSE 'REVIEW' END ,'OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NOT EXISTS(SELECT 1 FROM sync_alert_incidents WHERE kind='JOB' AND source_id=NEW.job_id AND state='OPEN')
 ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS sync_alert_job_update AFTER UPDATE OF status,last_error ON sync_jobs
WHEN NEW.status IN ('FAILED','REVIEW')
BEGIN
 -- A failure may later become a held REVIEW with a different explanation.
 -- Close the old generation before opening the new one, so an already-sent
 -- alert never hides the action the owner now needs to take. Keep unsent
 -- generations too: their durable record may be the only evidence of a
 -- short-lived failure.
 UPDATE sync_alert_incidents SET state='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE kind='JOB' AND source_id=NEW.job_id AND state='OPEN' AND category<> CASE WHEN NEW.status='FAILED' THEN 'FAILED'
  WHEN NEW.last_error='STABLE_DAILY_MONTH_OPENING_UNVERIFIED' THEN 'MONTH_OPENING'
  WHEN NEW.last_error='STABLE_DAILY_ROW_HELPER_FORMULA_UNVERIFIED' THEN 'ROW_FORMULA'
  WHEN NEW.last_error='STABLE_DAILY_CAPACITY' THEN 'CAPACITY'
  WHEN NEW.last_error IN ('STABLE_CANCELLED_SOURCE_REVIEW','STABLE_SUPERSEDED_SOURCE_REVIEW','STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED') THEN 'CANCELLED_OR_SUPERSEDED'
  ELSE 'REVIEW' END;
 INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at)
 SELECT 'JOB',NEW.job_id, CASE WHEN NEW.status='FAILED' THEN 'FAILED'
  WHEN NEW.last_error='STABLE_DAILY_MONTH_OPENING_UNVERIFIED' THEN 'MONTH_OPENING'
  WHEN NEW.last_error='STABLE_DAILY_ROW_HELPER_FORMULA_UNVERIFIED' THEN 'ROW_FORMULA'
  WHEN NEW.last_error='STABLE_DAILY_CAPACITY' THEN 'CAPACITY'
  WHEN NEW.last_error IN ('STABLE_CANCELLED_SOURCE_REVIEW','STABLE_SUPERSEDED_SOURCE_REVIEW','STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED') THEN 'CANCELLED_OR_SUPERSEDED'
  ELSE 'REVIEW' END ,'OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NOT EXISTS(SELECT 1 FROM sync_alert_incidents WHERE kind='JOB' AND source_id=NEW.job_id AND state='OPEN')
 ON CONFLICT DO NOTHING;
END;
CREATE TRIGGER IF NOT EXISTS sync_alert_job_complete AFTER UPDATE OF status ON sync_jobs
WHEN NEW.status='COMPLETED'
BEGIN UPDATE sync_alert_incidents SET state='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='JOB' AND source_id=NEW.job_id AND state='OPEN'; END;
CREATE TRIGGER IF NOT EXISTS sync_alert_job_delete AFTER DELETE ON sync_jobs
BEGIN UPDATE sync_alert_incidents SET state='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='JOB' AND source_id=OLD.job_id AND state='OPEN'; END;

-- The claim rowid is an internal opaque correlation value, not a claim token
-- or a spreadsheet identifier. Its generation closes when the claim is removed.
CREATE TRIGGER IF NOT EXISTS sync_alert_claim_insert AFTER INSERT ON stable_workbook_claims
WHEN NEW.state='REVIEW'
BEGIN INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at)
 SELECT 'WORKBOOK',CAST(NEW.rowid AS TEXT),'WORKBOOK_REVIEW','OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NOT EXISTS(SELECT 1 FROM sync_alert_incidents WHERE kind='WORKBOOK' AND source_id=CAST(NEW.rowid AS TEXT) AND state='OPEN')
 ON CONFLICT DO NOTHING; END;
CREATE TRIGGER IF NOT EXISTS sync_alert_claim_update AFTER UPDATE OF state ON stable_workbook_claims
WHEN NEW.state='REVIEW'
BEGIN INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at)
 SELECT 'WORKBOOK',CAST(NEW.rowid AS TEXT),'WORKBOOK_REVIEW','OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NOT EXISTS(SELECT 1 FROM sync_alert_incidents WHERE kind='WORKBOOK' AND source_id=CAST(NEW.rowid AS TEXT) AND state='OPEN')
 ON CONFLICT DO NOTHING; END;
CREATE TRIGGER IF NOT EXISTS sync_alert_claim_release AFTER DELETE ON stable_workbook_claims
BEGIN UPDATE sync_alert_incidents SET state='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='WORKBOOK' AND source_id=CAST(OLD.rowid AS TEXT) AND state='OPEN'; END;
CREATE TRIGGER IF NOT EXISTS sync_alert_claim_resume AFTER UPDATE OF state ON stable_workbook_claims
WHEN NEW.state<>'REVIEW'
BEGIN UPDATE sync_alert_incidents SET state='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='WORKBOOK' AND source_id=CAST(NEW.rowid AS TEXT) AND state='OPEN'; END;

CREATE TRIGGER IF NOT EXISTS sync_alert_terminal_insert AFTER INSERT ON failed_jobs
WHEN NEW.queue_name='malipang-jobs' AND NEW.status='OPEN' AND NEW.error='DEAD_LETTER_MAX_RETRIES'
 AND json_extract( CASE WHEN json_valid(NEW.payload_json) THEN NEW.payload_json ELSE '{}' END ,'$.kind') IN ('SHEETS_SYNC','STAFF_CONFIG_SYNC')
BEGIN INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at)
 SELECT 'TERMINAL',NEW.id,'TERMINAL','OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NOT EXISTS(SELECT 1 FROM sync_alert_incidents WHERE kind='TERMINAL' AND source_id=NEW.id AND state='OPEN')
 ON CONFLICT DO NOTHING; END;
CREATE TRIGGER IF NOT EXISTS sync_alert_terminal_update AFTER UPDATE OF status,error ON failed_jobs
WHEN NEW.queue_name='malipang-jobs' AND NEW.status='OPEN' AND NEW.error='DEAD_LETTER_MAX_RETRIES'
 AND json_extract( CASE WHEN json_valid(NEW.payload_json) THEN NEW.payload_json ELSE '{}' END ,'$.kind') IN ('SHEETS_SYNC','STAFF_CONFIG_SYNC')
BEGIN INSERT INTO sync_alert_incidents(kind,source_id,category,state,opened_at)
 SELECT 'TERMINAL',NEW.id,'TERMINAL','OPEN',strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE NOT EXISTS(SELECT 1 FROM sync_alert_incidents WHERE kind='TERMINAL' AND source_id=NEW.id AND state='OPEN')
 ON CONFLICT DO NOTHING; END;
CREATE TRIGGER IF NOT EXISTS sync_alert_terminal_resolve AFTER UPDATE OF status,error ON failed_jobs
WHEN NEW.status<>'OPEN' OR NEW.error<>'DEAD_LETTER_MAX_RETRIES'
BEGIN UPDATE sync_alert_incidents SET state='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='TERMINAL' AND source_id=NEW.id AND state='OPEN'; END;
CREATE TRIGGER IF NOT EXISTS sync_alert_terminal_delete AFTER DELETE ON failed_jobs
BEGIN UPDATE sync_alert_incidents SET state='CLOSED',closed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE kind='TERMINAL' AND source_id=OLD.id AND state='OPEN'; END;

-- Existing incidents predate this alerting feature and are not backfilled.
