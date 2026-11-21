-- Issue #296: narrow one-time, append-only attestation for the VIEWS
-- incident. This does not automatically resume an operator or edit Sheets.
-- The only affected historical manifest is pinned by digest.
CREATE TABLE IF NOT EXISTS continuous_views_incident_recovery(
 spreadsheet_id TEXT PRIMARY KEY,
 operation_token TEXT NOT NULL UNIQUE,
 manifest_digest TEXT NOT NULL CHECK(length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
 provider_evidence_digest TEXT NOT NULL CHECK(length(provider_evidence_digest)=64 AND provider_evidence_digest NOT GLOB '*[^0-9a-f]*'),
 verified_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state='VERIFIED')
);
CREATE TRIGGER IF NOT EXISTS continuous_views_recovery_insert BEFORE INSERT ON continuous_views_incident_recovery
WHEN NEW.state<>'VERIFIED'
 OR NEW.manifest_digest<>'bbdab8c97a741bb58ec0c740a86ef0ca898fb03da0e910c4b393270555b733c2'
 OR NOT EXISTS(SELECT 1 FROM continuous_cutover_operator o
  JOIN stable_workbook_claims c ON c.spreadsheet_id=o.spreadsheet_id AND c.operation_token=o.operation_token
  WHERE o.spreadsheet_id=NEW.spreadsheet_id AND o.operation_token=NEW.operation_token
   AND o.origin='PREWRITE_REVIEW' AND o.state='REVIEW'
   AND c.state='REVIEW' AND c.phase='OPERATION'
   AND c.review_reason='CONTINUOUS_CUTOVER_REVIEW'
   AND c.notice_stamp IS NOT NULL AND c.notice_identity IS NOT NULL)
 OR NOT EXISTS(SELECT 1 FROM continuous_report_cutover_attempts a
  WHERE a.spreadsheet_id=NEW.spreadsheet_id AND a.operation_token=NEW.operation_token
   AND a.stage='VIEWS' AND a.state='IN_FLIGHT' AND a.manifest_digest=NEW.manifest_digest
   AND a.cell_count=4 AND json_array_length(a.manifest_json)=4)
 OR EXISTS(SELECT 1 FROM continuous_report_cutover_attempts a WHERE a.spreadsheet_id=NEW.spreadsheet_id AND a.stage<>'VIEWS')
 OR EXISTS(SELECT 1 FROM continuous_daily_cutovers c WHERE c.spreadsheet_id=NEW.spreadsheet_id)
 OR EXISTS(SELECT 1 FROM stable_projection_writes w WHERE w.spreadsheet_id=NEW.spreadsheet_id AND w.state<>'VERIFIED')
 OR EXISTS(SELECT 1 FROM stable_expense_cancellation_writes w WHERE w.spreadsheet_id=NEW.spreadsheet_id AND w.state<>'VERIFIED')
 OR EXISTS(SELECT 1 FROM sync_jobs j WHERE j.status='PROCESSING')
 OR EXISTS(SELECT 1 FROM staff_config_sync_outbox s WHERE s.status='PROCESSING')
BEGIN SELECT RAISE(ABORT,'views incident recovery preimage rejected'); END;
CREATE TRIGGER IF NOT EXISTS continuous_views_recovery_no_delete BEFORE DELETE ON continuous_views_incident_recovery
BEGIN SELECT RAISE(ABORT,'views incident recovery evidence retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_views_recovery_no_update BEFORE UPDATE ON continuous_views_incident_recovery
BEGIN SELECT RAISE(ABORT,'views incident recovery evidence immutable'); END;
CREATE TRIGGER IF NOT EXISTS continuous_views_recovery_no_replace BEFORE INSERT ON continuous_views_incident_recovery
WHEN EXISTS(SELECT 1 FROM continuous_views_incident_recovery r WHERE r.spreadsheet_id=NEW.spreadsheet_id OR r.operation_token=NEW.operation_token OR r.rowid=NEW.rowid)
BEGIN SELECT RAISE(ABORT,'views incident recovery evidence already exists'); END;

-- Retain all old operator transitions. The only added transition is a
-- REVIEW -> HELD reconciliation after the one exact VIEWS attempt was proven
-- by a provider-bound attestation and verified inside a single D1 batch.
DROP TRIGGER IF EXISTS continuous_operator_update;
CREATE TRIGGER continuous_operator_update BEFORE UPDATE ON continuous_cutover_operator
WHEN NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.operation_token IS NOT OLD.operation_token OR NEW.origin IS NOT OLD.origin OR NEW.original_fingerprint IS NOT OLD.original_fingerprint OR NEW.created_at IS NOT OLD.created_at
 OR NOT (
  OLD.state='STARTING' AND NEW.state IN ('HELD','REVIEW')
  OR OLD.state='HELD' AND NEW.state IN ('VIEWS','DAILY_J','REPORTS','ACTIVATING','RELEASING','REVIEW')
  OR OLD.state IN ('VIEWS','DAILY_J','REPORTS','ACTIVATING') AND NEW.state IN ('HELD','REVIEW')
  OR OLD.state='RELEASING' AND NEW.state IN ('COMPLETE','REVIEW')
  OR (OLD.state='REVIEW' AND NEW.state='HELD' AND OLD.origin='PREWRITE_REVIEW'
   AND EXISTS(SELECT 1 FROM continuous_views_incident_recovery r
    JOIN continuous_report_cutover_attempts a ON a.spreadsheet_id=r.spreadsheet_id
     AND a.operation_token=r.operation_token AND a.manifest_digest=r.manifest_digest
    JOIN stable_workbook_claims c ON c.spreadsheet_id=r.spreadsheet_id
     AND c.operation_token=r.operation_token
    WHERE r.spreadsheet_id=OLD.spreadsheet_id AND r.operation_token=OLD.operation_token
     AND r.state='VERIFIED' AND a.stage='VIEWS' AND a.state='VERIFIED'
     AND c.state='HELD' AND c.phase='OPERATION'
     AND c.review_reason='CONTINUOUS_CUTOVER_REVIEW'
     AND c.notice_stamp IS NOT NULL AND c.notice_identity IS NOT NULL))
 )
BEGIN SELECT RAISE(ABORT,'continuous operator transition rejected'); END;
