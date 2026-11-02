-- Production candidate: monotonic source revision and admission identity only.
-- These triggers execute inside business writes and can make them fail if D1
-- cannot persist the revision. Do not apply before rollout review and source
-- writers are stopped; Google Sheets edits are NOT covered by this revision.
CREATE TABLE IF NOT EXISTS expense_projection_source_revisions (
  expense_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK(state IN ('TRACKED','REVIEW'))
);
CREATE TABLE IF NOT EXISTS expense_projection_admissions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  expense_id TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS expense_projection_bootstrap (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  state TEXT NOT NULL CHECK(state='COMPLETE')
);
-- One-time baseline only. Re-running must never silently re-enroll a deleted
-- revision; subsequent missing revisions are recreated as REVIEW by triggers.
INSERT OR IGNORE INTO expense_projection_source_revisions(expense_id,revision,state)
  SELECT expense_id,1,'TRACKED' FROM expense_events WHERE NOT EXISTS(SELECT 1 FROM expense_projection_bootstrap WHERE singleton=1);
INSERT OR IGNORE INTO expense_projection_admissions(expense_id)
  SELECT expense_id FROM expense_events WHERE NOT EXISTS(SELECT 1 FROM expense_projection_bootstrap WHERE singleton=1) ORDER BY created_at,expense_id;
-- SQLite REPLACE can delete conflicting rows without firing DELETE triggers.
-- BEFORE INSERT tracks every currently-declared unique collision. A harmless
-- ignored duplicate also bumps revisions, which can conservatively hold sync.
CREATE TRIGGER IF NOT EXISTS expense_projection_event_before_insert BEFORE INSERT ON expense_events BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT e.expense_id,1,'REVIEW' FROM expense_events e WHERE e.expense_id=NEW.expense_id OR e.message_id=NEW.message_id OR e.rowid=NEW.rowid
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT NEW.expense_id,1,'REVIEW' WHERE EXISTS(SELECT 1 FROM expense_events e WHERE (e.message_id=NEW.message_id OR e.rowid=NEW.rowid) AND e.expense_id<>NEW.expense_id)
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1,state='REVIEW';
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_event_insert AFTER INSERT ON expense_events BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state) VALUES(NEW.expense_id,1,'TRACKED')
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1,state='REVIEW';
  INSERT OR IGNORE INTO expense_projection_admissions(expense_id) VALUES(NEW.expense_id);
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_event_update AFTER UPDATE ON expense_events BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state) SELECT OLD.expense_id,1,'REVIEW' WHERE OLD.expense_id<>NEW.expense_id
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1,state='REVIEW';
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state) VALUES(NEW.expense_id,1,'REVIEW')
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1,state= CASE WHEN OLD.expense_id<>NEW.expense_id THEN 'REVIEW' ELSE state END;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_event_delete AFTER DELETE ON expense_events BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state) VALUES(OLD.expense_id,1,'REVIEW')
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1,state='REVIEW';
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_document_before_insert BEFORE INSERT ON expense_documents BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT expense_id,1,'REVIEW' FROM (
      SELECT d.expense_id AS expense_id FROM expense_documents d WHERE d.document_id IN (SELECT d.document_id FROM expense_documents d WHERE d.rowid=NEW.rowid OR d.document_id=NEW.document_id UNION SELECT d.document_id FROM expense_documents d WHERE d.message_id=NEW.message_id UNION SELECT d.document_id FROM expense_documents d WHERE d.reference_key=NEW.reference_key AND d.reference_key IS NOT NULL AND d.reference_key<>'' UNION SELECT d.document_id FROM expense_documents d WHERE d.image_hash=NEW.image_hash AND d.image_hash IS NOT NULL AND d.image_hash<>'' UNION SELECT d.document_id FROM expense_documents d WHERE d.legal_vendor_name=NEW.legal_vendor_name AND d.legal_vendor_name IS NOT NULL AND d.legal_vendor_name<>'' AND d.document_number=NEW.document_number AND d.document_number IS NOT NULL AND d.document_number<>'' AND NOT (d.expense_id IS NULL AND COALESCE(d.reference_key,'') GLOB 'receipt:linked:v1:*' AND d.order_id IS NOT NULL AND trim(d.order_id)<>'') AND NOT (NEW.expense_id IS NULL AND COALESCE(NEW.reference_key,'') GLOB 'receipt:linked:v1:*' AND NEW.order_id IS NOT NULL AND trim(NEW.order_id)<>''))
      UNION SELECT l.expense_id FROM expense_document_links l WHERE l.document_id IN (SELECT d.document_id FROM expense_documents d WHERE d.rowid=NEW.rowid OR d.document_id=NEW.document_id UNION SELECT d.document_id FROM expense_documents d WHERE d.message_id=NEW.message_id UNION SELECT d.document_id FROM expense_documents d WHERE d.reference_key=NEW.reference_key AND d.reference_key IS NOT NULL AND d.reference_key<>'' UNION SELECT d.document_id FROM expense_documents d WHERE d.image_hash=NEW.image_hash AND d.image_hash IS NOT NULL AND d.image_hash<>'' UNION SELECT d.document_id FROM expense_documents d WHERE d.legal_vendor_name=NEW.legal_vendor_name AND d.legal_vendor_name IS NOT NULL AND d.legal_vendor_name<>'' AND d.document_number=NEW.document_number AND d.document_number IS NOT NULL AND d.document_number<>'' AND NOT (d.expense_id IS NULL AND COALESCE(d.reference_key,'') GLOB 'receipt:linked:v1:*' AND d.order_id IS NOT NULL AND trim(d.order_id)<>'') AND NOT (NEW.expense_id IS NULL AND COALESCE(NEW.reference_key,'') GLOB 'receipt:linked:v1:*' AND NEW.order_id IS NOT NULL AND trim(NEW.order_id)<>''))
    ) WHERE expense_id IS NOT NULL AND expense_id<>'' ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_document_insert AFTER INSERT ON expense_documents BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT expense_id,1,'REVIEW' FROM (SELECT NEW.expense_id AS expense_id UNION SELECT l.expense_id FROM expense_document_links l WHERE l.document_id=NEW.document_id) WHERE expense_id IS NOT NULL AND expense_id<>''
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_document_update AFTER UPDATE ON expense_documents BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT expense_id,1,'REVIEW' FROM (SELECT NEW.expense_id AS expense_id UNION SELECT OLD.expense_id UNION SELECT l.expense_id FROM expense_document_links l WHERE l.document_id=NEW.document_id OR l.document_id=OLD.document_id) WHERE expense_id IS NOT NULL AND expense_id<>''
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_document_delete AFTER DELETE ON expense_documents BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT expense_id,1,'REVIEW' FROM (SELECT OLD.expense_id AS expense_id UNION SELECT l.expense_id FROM expense_document_links l WHERE l.document_id=OLD.document_id) WHERE expense_id IS NOT NULL AND expense_id<>''
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_link_before_insert BEFORE INSERT ON expense_document_links BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT l.expense_id,1,'REVIEW' FROM expense_document_links l WHERE l.link_id=NEW.link_id OR l.rowid=NEW.rowid OR (l.expense_id=NEW.expense_id AND l.document_id=NEW.document_id)
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_link_insert AFTER INSERT ON expense_document_links BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state) VALUES(NEW.expense_id,1,'REVIEW')
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_link_update AFTER UPDATE ON expense_document_links BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT expense_id,1,'REVIEW' FROM (SELECT NEW.expense_id AS expense_id UNION SELECT OLD.expense_id) WHERE expense_id IS NOT NULL AND expense_id<>''
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_link_delete AFTER DELETE ON expense_document_links BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state) VALUES(OLD.expense_id,1,'REVIEW')
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_item_before_insert BEFORE INSERT ON expense_document_items BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT expense_id,1,'REVIEW' FROM (
      SELECT i.expense_id AS expense_id FROM expense_document_items i WHERE (i.item_id=NEW.item_id OR i.rowid=NEW.rowid)
      UNION SELECT d.expense_id FROM expense_documents d JOIN expense_document_items i ON i.document_id=d.document_id WHERE (i.item_id=NEW.item_id OR i.rowid=NEW.rowid)
      UNION SELECT l.expense_id FROM expense_document_links l JOIN expense_document_items i ON i.document_id=l.document_id WHERE (i.item_id=NEW.item_id OR i.rowid=NEW.rowid)
    ) WHERE expense_id IS NOT NULL AND expense_id<>'' ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_item_insert AFTER INSERT ON expense_document_items BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT expense_id,1,'REVIEW' FROM (SELECT NEW.expense_id AS expense_id UNION SELECT d.expense_id FROM expense_documents d WHERE d.document_id=NEW.document_id UNION SELECT l.expense_id FROM expense_document_links l WHERE l.document_id=NEW.document_id) WHERE expense_id IS NOT NULL AND expense_id<>''
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_item_update AFTER UPDATE ON expense_document_items BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT expense_id,1,'REVIEW' FROM (SELECT NEW.expense_id AS expense_id UNION SELECT OLD.expense_id UNION SELECT d.expense_id FROM expense_documents d WHERE d.document_id=NEW.document_id OR d.document_id=OLD.document_id UNION SELECT l.expense_id FROM expense_document_links l WHERE l.document_id=NEW.document_id OR l.document_id=OLD.document_id) WHERE expense_id IS NOT NULL AND expense_id<>''
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_item_delete AFTER DELETE ON expense_document_items BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT expense_id,1,'REVIEW' FROM (SELECT OLD.expense_id AS expense_id UNION SELECT d.expense_id FROM expense_documents d WHERE d.document_id=OLD.document_id UNION SELECT l.expense_id FROM expense_document_links l WHERE l.document_id=OLD.document_id) WHERE expense_id IS NOT NULL AND expense_id<>''
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
-- UPDATE OR REPLACE can also delete a conflicting row without DELETE triggers.
-- Exclude the row being updated so ordinary updates do not cause extra bumps.
CREATE TRIGGER IF NOT EXISTS expense_projection_event_before_update BEFORE UPDATE ON expense_events BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT e.expense_id,1,'REVIEW' FROM expense_events e WHERE e.rowid<>OLD.rowid AND (e.expense_id=NEW.expense_id OR e.message_id=NEW.message_id OR e.rowid=NEW.rowid)
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1,state='REVIEW';
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT NEW.expense_id,1,'REVIEW' WHERE EXISTS(SELECT 1 FROM expense_events e WHERE e.rowid<>OLD.rowid AND (e.expense_id=NEW.expense_id OR e.message_id=NEW.message_id OR e.rowid=NEW.rowid))
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1,state='REVIEW';
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_document_before_update BEFORE UPDATE ON expense_documents BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT expense_id,1,'REVIEW' FROM (
      SELECT d.expense_id AS expense_id FROM expense_documents d WHERE d.document_id IN (SELECT d.document_id FROM expense_documents d WHERE d.rowid<>OLD.rowid AND (d.rowid=NEW.rowid OR d.document_id=NEW.document_id) UNION SELECT d.document_id FROM expense_documents d WHERE d.rowid<>OLD.rowid AND d.message_id=NEW.message_id UNION SELECT d.document_id FROM expense_documents d WHERE d.rowid<>OLD.rowid AND d.reference_key=NEW.reference_key AND d.reference_key IS NOT NULL AND d.reference_key<>'' UNION SELECT d.document_id FROM expense_documents d WHERE d.rowid<>OLD.rowid AND d.image_hash=NEW.image_hash AND d.image_hash IS NOT NULL AND d.image_hash<>'' UNION SELECT d.document_id FROM expense_documents d WHERE d.rowid<>OLD.rowid AND d.legal_vendor_name=NEW.legal_vendor_name AND d.legal_vendor_name IS NOT NULL AND d.legal_vendor_name<>'' AND d.document_number=NEW.document_number AND d.document_number IS NOT NULL AND d.document_number<>'' AND NOT (d.expense_id IS NULL AND COALESCE(d.reference_key,'') GLOB 'receipt:linked:v1:*' AND d.order_id IS NOT NULL AND trim(d.order_id)<>'') AND NOT (NEW.expense_id IS NULL AND COALESCE(NEW.reference_key,'') GLOB 'receipt:linked:v1:*' AND NEW.order_id IS NOT NULL AND trim(NEW.order_id)<>''))
      UNION SELECT l.expense_id FROM expense_document_links l WHERE l.document_id IN (SELECT d.document_id FROM expense_documents d WHERE d.rowid<>OLD.rowid AND (d.rowid=NEW.rowid OR d.document_id=NEW.document_id) UNION SELECT d.document_id FROM expense_documents d WHERE d.rowid<>OLD.rowid AND d.message_id=NEW.message_id UNION SELECT d.document_id FROM expense_documents d WHERE d.rowid<>OLD.rowid AND d.reference_key=NEW.reference_key AND d.reference_key IS NOT NULL AND d.reference_key<>'' UNION SELECT d.document_id FROM expense_documents d WHERE d.rowid<>OLD.rowid AND d.image_hash=NEW.image_hash AND d.image_hash IS NOT NULL AND d.image_hash<>'' UNION SELECT d.document_id FROM expense_documents d WHERE d.rowid<>OLD.rowid AND d.legal_vendor_name=NEW.legal_vendor_name AND d.legal_vendor_name IS NOT NULL AND d.legal_vendor_name<>'' AND d.document_number=NEW.document_number AND d.document_number IS NOT NULL AND d.document_number<>'' AND NOT (d.expense_id IS NULL AND COALESCE(d.reference_key,'') GLOB 'receipt:linked:v1:*' AND d.order_id IS NOT NULL AND trim(d.order_id)<>'') AND NOT (NEW.expense_id IS NULL AND COALESCE(NEW.reference_key,'') GLOB 'receipt:linked:v1:*' AND NEW.order_id IS NOT NULL AND trim(NEW.order_id)<>''))
    ) WHERE expense_id IS NOT NULL AND expense_id<>'' ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_link_before_update BEFORE UPDATE ON expense_document_links BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT l.expense_id,1,'REVIEW' FROM expense_document_links l WHERE l.rowid<>OLD.rowid AND (l.link_id=NEW.link_id OR l.rowid=NEW.rowid OR (l.expense_id=NEW.expense_id AND l.document_id=NEW.document_id))
    ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS expense_projection_item_before_update BEFORE UPDATE ON expense_document_items BEGIN
  INSERT INTO expense_projection_source_revisions(expense_id,revision,state)
    SELECT expense_id,1,'REVIEW' FROM (
      SELECT i.expense_id AS expense_id FROM expense_document_items i WHERE i.rowid<>OLD.rowid AND (i.item_id=NEW.item_id OR i.rowid=NEW.rowid)
      UNION SELECT d.expense_id FROM expense_documents d JOIN expense_document_items i ON i.document_id=d.document_id WHERE i.rowid<>OLD.rowid AND (i.item_id=NEW.item_id OR i.rowid=NEW.rowid)
      UNION SELECT l.expense_id FROM expense_document_links l JOIN expense_document_items i ON i.document_id=l.document_id WHERE i.rowid<>OLD.rowid AND (i.item_id=NEW.item_id OR i.rowid=NEW.rowid)
    ) WHERE expense_id IS NOT NULL AND expense_id<>'' ON CONFLICT(expense_id) DO UPDATE SET revision=revision+1;
END;
INSERT OR IGNORE INTO expense_projection_bootstrap(singleton,state) VALUES(1,'COMPLETE');
