-- One bounded row per workbook and probe source. The latest verified proof is
-- retained while a fresh challenge is outstanding; late queue replies cannot
-- certify a newer challenge.
CREATE TABLE IF NOT EXISTS continuous_notice_readiness_probes (
 spreadsheet_id TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('MAIN_CRON','NOTICE_CRON')),
 generation INTEGER NOT NULL CHECK(generation>0),
 probe_id TEXT NOT NULL,
 config_fingerprint TEXT NOT NULL CHECK(length(config_fingerprint)=64),
 created_at TEXT NOT NULL,
 verified_generation INTEGER,
 verified_probe_id TEXT,
 verified_fingerprint TEXT,
 verified_created_at TEXT,
 verified_at TEXT,
 PRIMARY KEY(spreadsheet_id,source),
 CHECK((verified_generation IS NULL AND verified_probe_id IS NULL AND verified_fingerprint IS NULL AND verified_created_at IS NULL AND verified_at IS NULL) OR (verified_generation>0 AND verified_generation<=generation AND verified_probe_id IS NOT NULL AND length(verified_fingerprint)=64 AND verified_created_at IS NOT NULL AND verified_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS continuous_notice_readiness_fresh ON continuous_notice_readiness_probes(spreadsheet_id,source,verified_fingerprint,verified_created_at);
CREATE TRIGGER IF NOT EXISTS continuous_notice_probe_insert BEFORE INSERT ON continuous_notice_readiness_probes WHEN NEW.generation<>1 OR NEW.verified_generation IS NOT NULL BEGIN SELECT RAISE(ABORT,'probe must begin unverified'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_probe_update BEFORE UPDATE ON continuous_notice_readiness_probes WHEN NEW.spreadsheet_id IS NOT OLD.spreadsheet_id OR NEW.source IS NOT OLD.source OR NOT (
 (NEW.generation=OLD.generation+1 AND NEW.probe_id IS NOT OLD.probe_id AND NEW.verified_generation IS OLD.verified_generation AND NEW.verified_probe_id IS OLD.verified_probe_id AND NEW.verified_fingerprint IS OLD.verified_fingerprint AND NEW.verified_created_at IS OLD.verified_created_at AND NEW.verified_at IS OLD.verified_at)
 OR (NEW.generation=OLD.generation AND NEW.probe_id IS OLD.probe_id AND NEW.config_fingerprint IS OLD.config_fingerprint AND NEW.created_at IS OLD.created_at AND (OLD.verified_generation IS NULL OR OLD.verified_generation<OLD.generation) AND NEW.verified_generation=OLD.generation AND NEW.verified_probe_id=OLD.probe_id AND NEW.verified_fingerprint=OLD.config_fingerprint AND NEW.verified_created_at=OLD.created_at AND NEW.verified_at IS NOT NULL)
) BEGIN SELECT RAISE(ABORT,'invalid probe transition'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_probe_no_delete BEFORE DELETE ON continuous_notice_readiness_probes BEGIN SELECT RAISE(ABORT,'probe retained'); END;
CREATE TRIGGER IF NOT EXISTS continuous_notice_probe_no_replace BEFORE INSERT ON continuous_notice_readiness_probes WHEN EXISTS(SELECT 1 FROM continuous_notice_readiness_probes p WHERE (p.spreadsheet_id=NEW.spreadsheet_id AND p.source=NEW.source) OR p.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'probe already exists'); END;
