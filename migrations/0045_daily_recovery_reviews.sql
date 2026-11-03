-- Identity data shape shared with the #229 stable-row draft. No production
-- identity is enrolled by this migration and no row number is stored.
-- Reserved for a future independently verified production enrollment; this
-- candidate provides no API to create or trust one as a recovery authorization.
CREATE TABLE IF NOT EXISTS daily_recovery_identity_witnesses (
 spreadsheet_id TEXT NOT NULL,sheet_name TEXT NOT NULL,expense_id TEXT NOT NULL,metadata_id INTEGER NOT NULL,
 projected_version INTEGER NOT NULL CHECK(typeof(projected_version)='integer' AND projected_version BETWEEN 1 AND 9007199254740991),projected_revision INTEGER NOT NULL CHECK(typeof(projected_revision)='integer' AND projected_revision BETWEEN 1 AND 9007199254740991),baseline_sha256 TEXT NOT NULL CHECK(length(baseline_sha256)=64),
 provenance TEXT NOT NULL CHECK(provenance='PRODUCTION_VERIFIED_WRITER'),
 created_at TEXT NOT NULL, PRIMARY KEY(spreadsheet_id,sheet_name,expense_id,projected_revision)
);
CREATE TABLE IF NOT EXISTS daily_recovery_reviews (
 action_id TEXT PRIMARY KEY,spreadsheet_id TEXT NOT NULL,sheet_name TEXT NOT NULL,
 window_token TEXT NOT NULL,intent_operation_token TEXT NOT NULL,
 expense_id TEXT NOT NULL,source_version INTEGER NOT NULL,source_revision INTEGER NOT NULL,
 evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),
 source_observation TEXT NOT NULL CHECK(source_observation IN ('CURRENT_REVISION','CHANGED_OR_UNAVAILABLE')),
 provider_observation TEXT NOT NULL CHECK(provider_observation IN ('MATCHES_RECORDED_INPUTS','DIFFERS','UNVERIFIED')),
 badge_observation TEXT NOT NULL CHECK(badge_observation IN ('MATCHES_RECORDED','MATCHES_ORIGINAL','DIFFERS','UNVERIFIED')),
 postimage_observation TEXT NOT NULL CHECK(postimage_observation IN ('MATCHES_POSTIMAGE','DIFFERS','UNVERIFIED')),
 principal TEXT NOT NULL CHECK(principal='ADMIN_TOKEN'),
 reason TEXT NOT NULL CHECK(reason IN ('EVIDENCE_INCOMPLETE','SOURCE_CHANGED','PROVIDER_MISMATCH','OTHER')),
 decision TEXT NOT NULL CHECK(decision IN ('KEEP_REVIEW','HOLD_IN_FLIGHT')),observed_at TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(spreadsheet_id,sheet_name,window_token,evidence_digest,reason)
);
CREATE TRIGGER daily_recovery_reviews_no_delete BEFORE DELETE ON daily_recovery_reviews BEGIN SELECT RAISE(ABORT,'daily recovery audit retained'); END;
CREATE TRIGGER daily_recovery_reviews_no_update BEFORE UPDATE ON daily_recovery_reviews BEGIN SELECT RAISE(ABORT,'daily recovery audit immutable'); END;
CREATE TRIGGER daily_recovery_reviews_no_replace BEFORE INSERT ON daily_recovery_reviews
WHEN EXISTS(SELECT 1 FROM daily_recovery_reviews a WHERE a.rowid=NEW.rowid OR a.action_id=NEW.action_id OR (a.spreadsheet_id=NEW.spreadsheet_id AND a.sheet_name=NEW.sheet_name AND a.window_token=NEW.window_token AND a.evidence_digest=NEW.evidence_digest AND a.reason=NEW.reason))
BEGIN SELECT RAISE(ABORT,'daily recovery audit collision'); END;
-- Holding an uncertain operation and its audit are one SQLite statement.
-- This cannot revoke a Google request already in flight.
CREATE TRIGGER daily_recovery_reviews_hold_validate BEFORE INSERT ON daily_recovery_reviews
WHEN NOT EXISTS(SELECT 1 FROM daily_notice_dispatch_intents i WHERE i.spreadsheet_id=NEW.spreadsheet_id AND i.sheet_name=NEW.sheet_name AND i.window_token=NEW.window_token AND i.operation_token=NEW.intent_operation_token AND i.expense_id=NEW.expense_id AND i.source_version=NEW.source_version AND i.source_revision=NEW.source_revision AND ((NEW.decision='KEEP_REVIEW' AND i.state='REVIEW') OR (NEW.decision='HOLD_IN_FLIGHT' AND i.state='IN_FLIGHT')))
BEGIN SELECT RAISE(ABORT,'daily recovery intent changed'); END;
CREATE TRIGGER daily_recovery_reviews_hold_apply AFTER INSERT ON daily_recovery_reviews
WHEN NEW.decision='HOLD_IN_FLIGHT'
BEGIN UPDATE daily_notice_dispatch_intents SET state='REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id=NEW.spreadsheet_id AND sheet_name=NEW.sheet_name AND window_token=NEW.window_token AND operation_token=NEW.intent_operation_token AND state='IN_FLIGHT'; END;
