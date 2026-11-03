-- Candidate for the existing D1 database only. These triggers execute inside
-- personal-use writes and can intentionally abort them if revision tracking
-- cannot be preserved. Do not apply before cutover and business-impact review.
CREATE TABLE IF NOT EXISTS personal_projection_source_revisions (
  personal_use_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('TRACKED','REVIEW'))
);
CREATE TABLE IF NOT EXISTS personal_projection_admissions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  personal_use_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS personal_projection_bootstrap (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state TEXT NOT NULL CHECK(state='COMPLETE')
);
INSERT OR IGNORE INTO personal_projection_source_revisions(personal_use_id,revision,state)
  SELECT personal_use_id,1,'TRACKED' FROM owner_personal_transactions WHERE NOT EXISTS(SELECT 1 FROM personal_projection_bootstrap WHERE singleton=1);
INSERT OR IGNORE INTO personal_projection_admissions(personal_use_id)
  SELECT personal_use_id FROM owner_personal_transactions WHERE NOT EXISTS(SELECT 1 FROM personal_projection_bootstrap WHERE singleton=1) ORDER BY created_at,personal_use_id;
-- BEFORE triggers account for conflicts that SQLite REPLACE can remove
-- without DELETE triggers. A harmless ignored collision may conservatively
-- increase a revision. Missing revision records are created as REVIEW.
CREATE TRIGGER IF NOT EXISTS personal_projection_before_insert BEFORE INSERT ON owner_personal_transactions BEGIN
  INSERT INTO personal_projection_source_revisions(personal_use_id,revision,state)
    SELECT p.personal_use_id,1,'REVIEW' FROM owner_personal_transactions p WHERE p.personal_use_id=NEW.personal_use_id OR p.message_id=NEW.message_id OR p.rowid=NEW.rowid
    ON CONFLICT(personal_use_id) DO UPDATE SET revision=revision+1;
  INSERT INTO personal_projection_source_revisions(personal_use_id,revision,state)
    SELECT NEW.personal_use_id,1,'REVIEW' WHERE EXISTS(SELECT 1 FROM owner_personal_transactions p WHERE p.personal_use_id<>NEW.personal_use_id AND (p.message_id=NEW.message_id OR p.rowid=NEW.rowid))
    ON CONFLICT(personal_use_id) DO UPDATE SET revision=revision+1,state='REVIEW';
END;
CREATE TRIGGER IF NOT EXISTS personal_projection_insert AFTER INSERT ON owner_personal_transactions BEGIN
  INSERT INTO personal_projection_source_revisions(personal_use_id,revision,state) VALUES(NEW.personal_use_id,1,'TRACKED')
    ON CONFLICT(personal_use_id) DO UPDATE SET revision=revision+1,state='REVIEW';
  INSERT OR IGNORE INTO personal_projection_admissions(personal_use_id) VALUES(NEW.personal_use_id);
END;
CREATE TRIGGER IF NOT EXISTS personal_projection_before_update BEFORE UPDATE ON owner_personal_transactions BEGIN
  INSERT INTO personal_projection_source_revisions(personal_use_id,revision,state)
    SELECT p.personal_use_id,1,'REVIEW' FROM owner_personal_transactions p WHERE p.rowid<>OLD.rowid AND (p.personal_use_id=NEW.personal_use_id OR p.message_id=NEW.message_id OR p.rowid=NEW.rowid)
    ON CONFLICT(personal_use_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS personal_projection_update AFTER UPDATE ON owner_personal_transactions BEGIN
  INSERT INTO personal_projection_source_revisions(personal_use_id,revision,state) SELECT OLD.personal_use_id,1,'REVIEW' WHERE OLD.personal_use_id<>NEW.personal_use_id
    ON CONFLICT(personal_use_id) DO UPDATE SET revision=revision+1,state='REVIEW';
  INSERT INTO personal_projection_source_revisions(personal_use_id,revision,state) VALUES(NEW.personal_use_id,1,'REVIEW')
    ON CONFLICT(personal_use_id) DO UPDATE SET revision=revision+1,state= CASE WHEN OLD.personal_use_id<>NEW.personal_use_id THEN 'REVIEW' ELSE state END;
END;
CREATE TRIGGER IF NOT EXISTS personal_projection_delete AFTER DELETE ON owner_personal_transactions BEGIN
  INSERT INTO personal_projection_source_revisions(personal_use_id,revision,state) VALUES(OLD.personal_use_id,1,'REVIEW')
    ON CONFLICT(personal_use_id) DO UPDATE SET revision=revision+1,state='REVIEW';
END;
INSERT OR IGNORE INTO personal_projection_bootstrap(singleton,state) VALUES(1,'COMPLETE');
