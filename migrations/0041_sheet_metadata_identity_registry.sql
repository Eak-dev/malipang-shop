-- Metadata IDs are workbook-global. Keep a permanent owner even if an
-- intent row is deleted; reused IDs require explicit reviewed recovery.
-- Backfill fails atomically if existing tables disagree about ownership.
CREATE TABLE sheet_metadata_identity_registry (
  spreadsheet_id TEXT NOT NULL,
  metadata_id INTEGER NOT NULL CHECK(metadata_id BETWEEN 1 AND 2147483647),
  sheet_name TEXT NOT NULL,
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('EXPENSE','PERSONAL_USE')),
  entity_id TEXT NOT NULL,
  PRIMARY KEY(spreadsheet_id, metadata_id),
  UNIQUE(spreadsheet_id, sheet_name, entity_kind, entity_id)
);
INSERT INTO sheet_metadata_identity_registry(spreadsheet_id,metadata_id,sheet_name,entity_kind,entity_id)
SELECT DISTINCT spreadsheet_id,metadata_id,sheet_name,entity_kind,entity_id FROM (
 SELECT spreadsheet_id,metadata_id,sheet_name,'EXPENSE' AS entity_kind,expense_id AS entity_id FROM full_raw_identity_intents
 UNION ALL SELECT spreadsheet_id,metadata_id,sheet_name,'EXPENSE',expense_id FROM full_raw_append_intents
 UNION ALL SELECT spreadsheet_id,metadata_id,sheet_name,'PERSONAL_USE',personal_use_id FROM personal_raw_identity_intents
);
CREATE TRIGGER metadata_registry_no_delete BEFORE DELETE ON sheet_metadata_identity_registry BEGIN SELECT RAISE(ABORT,'METADATA_REGISTRY_REVIEW_REQUIRED'); END;
CREATE TRIGGER metadata_registry_no_update BEFORE UPDATE ON sheet_metadata_identity_registry BEGIN SELECT RAISE(ABORT,'METADATA_REGISTRY_REVIEW_REQUIRED'); END;
CREATE TRIGGER metadata_registry_no_replace BEFORE INSERT ON sheet_metadata_identity_registry
WHEN EXISTS(SELECT 1 FROM sheet_metadata_identity_registry r WHERE r.rowid=NEW.rowid OR (r.spreadsheet_id=NEW.spreadsheet_id AND (r.metadata_id=NEW.metadata_id OR (r.sheet_name=NEW.sheet_name AND r.entity_kind=NEW.entity_kind AND r.entity_id=NEW.entity_id))))
BEGIN SELECT RAISE(ABORT,'METADATA_REGISTRY_OWNER_CONFLICT'); END;
CREATE TRIGGER metadata_expense_identity_validate BEFORE INSERT ON full_raw_identity_intents
WHEN EXISTS(SELECT 1 FROM sheet_metadata_identity_registry r WHERE r.spreadsheet_id=NEW.spreadsheet_id AND (r.metadata_id=NEW.metadata_id OR (r.sheet_name=NEW.sheet_name AND r.entity_kind='EXPENSE' AND r.entity_id=NEW.expense_id)) AND (r.metadata_id<>NEW.metadata_id OR r.sheet_name<>NEW.sheet_name OR r.entity_kind<>'EXPENSE' OR r.entity_id<>NEW.expense_id))
BEGIN SELECT RAISE(ABORT,'METADATA_REGISTRY_OWNER_CONFLICT'); END;
CREATE TRIGGER metadata_expense_identity_register AFTER INSERT ON full_raw_identity_intents
BEGIN INSERT INTO sheet_metadata_identity_registry(spreadsheet_id,metadata_id,sheet_name,entity_kind,entity_id) SELECT NEW.spreadsheet_id,NEW.metadata_id,NEW.sheet_name,'EXPENSE',NEW.expense_id WHERE NOT EXISTS(SELECT 1 FROM sheet_metadata_identity_registry r WHERE r.spreadsheet_id=NEW.spreadsheet_id AND r.metadata_id=NEW.metadata_id) ON CONFLICT DO NOTHING; END;
CREATE TRIGGER metadata_expense_identity_immutable BEFORE UPDATE OF spreadsheet_id,sheet_name,metadata_id,expense_id ON full_raw_identity_intents
WHEN OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR OLD.metadata_id IS NOT NEW.metadata_id OR OLD.expense_id IS NOT NEW.expense_id
BEGIN SELECT RAISE(ABORT,'METADATA_IDENTITY_CHANGE_REQUIRES_REVIEW'); END;
CREATE TRIGGER metadata_expense_append_validate BEFORE INSERT ON full_raw_append_intents
WHEN EXISTS(SELECT 1 FROM sheet_metadata_identity_registry r WHERE r.spreadsheet_id=NEW.spreadsheet_id AND (r.metadata_id=NEW.metadata_id OR (r.sheet_name=NEW.sheet_name AND r.entity_kind='EXPENSE' AND r.entity_id=NEW.expense_id)) AND (r.metadata_id<>NEW.metadata_id OR r.sheet_name<>NEW.sheet_name OR r.entity_kind<>'EXPENSE' OR r.entity_id<>NEW.expense_id))
BEGIN SELECT RAISE(ABORT,'METADATA_REGISTRY_OWNER_CONFLICT'); END;
CREATE TRIGGER metadata_expense_append_register AFTER INSERT ON full_raw_append_intents
BEGIN INSERT INTO sheet_metadata_identity_registry(spreadsheet_id,metadata_id,sheet_name,entity_kind,entity_id) SELECT NEW.spreadsheet_id,NEW.metadata_id,NEW.sheet_name,'EXPENSE',NEW.expense_id WHERE NOT EXISTS(SELECT 1 FROM sheet_metadata_identity_registry r WHERE r.spreadsheet_id=NEW.spreadsheet_id AND r.metadata_id=NEW.metadata_id) ON CONFLICT DO NOTHING; END;
CREATE TRIGGER metadata_expense_append_immutable BEFORE UPDATE OF spreadsheet_id,sheet_name,metadata_id,expense_id ON full_raw_append_intents
WHEN OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR OLD.metadata_id IS NOT NEW.metadata_id OR OLD.expense_id IS NOT NEW.expense_id
BEGIN SELECT RAISE(ABORT,'METADATA_IDENTITY_CHANGE_REQUIRES_REVIEW'); END;
CREATE TRIGGER metadata_personal_identity_validate BEFORE INSERT ON personal_raw_identity_intents
WHEN EXISTS(SELECT 1 FROM sheet_metadata_identity_registry r WHERE r.spreadsheet_id=NEW.spreadsheet_id AND (r.metadata_id=NEW.metadata_id OR (r.sheet_name=NEW.sheet_name AND r.entity_kind='PERSONAL_USE' AND r.entity_id=NEW.personal_use_id)) AND (r.metadata_id<>NEW.metadata_id OR r.sheet_name<>NEW.sheet_name OR r.entity_kind<>'PERSONAL_USE' OR r.entity_id<>NEW.personal_use_id))
BEGIN SELECT RAISE(ABORT,'METADATA_REGISTRY_OWNER_CONFLICT'); END;
CREATE TRIGGER metadata_personal_identity_register AFTER INSERT ON personal_raw_identity_intents
BEGIN INSERT INTO sheet_metadata_identity_registry(spreadsheet_id,metadata_id,sheet_name,entity_kind,entity_id) SELECT NEW.spreadsheet_id,NEW.metadata_id,NEW.sheet_name,'PERSONAL_USE',NEW.personal_use_id WHERE NOT EXISTS(SELECT 1 FROM sheet_metadata_identity_registry r WHERE r.spreadsheet_id=NEW.spreadsheet_id AND r.metadata_id=NEW.metadata_id) ON CONFLICT DO NOTHING; END;
CREATE TRIGGER metadata_personal_identity_immutable BEFORE UPDATE OF spreadsheet_id,sheet_name,metadata_id,personal_use_id ON personal_raw_identity_intents
WHEN OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR OLD.metadata_id IS NOT NEW.metadata_id OR OLD.personal_use_id IS NOT NEW.personal_use_id
BEGIN SELECT RAISE(ABORT,'METADATA_IDENTITY_CHANGE_REQUIRES_REVIEW'); END;
CREATE TRIGGER metadata_expense_identity_no_replace BEFORE INSERT ON full_raw_identity_intents
WHEN EXISTS(SELECT 1 FROM full_raw_identity_intents t WHERE t.rowid=NEW.rowid OR (t.spreadsheet_id=NEW.spreadsheet_id AND t.metadata_id=NEW.metadata_id) OR (t.spreadsheet_id=NEW.spreadsheet_id AND t.sheet_name=NEW.sheet_name AND t.expense_id=NEW.expense_id))
BEGIN SELECT RAISE(ABORT,'METADATA_INTENT_REPLACE_REQUIRES_REVIEW'); END;
CREATE TRIGGER metadata_expense_identity_rowid_no_replace BEFORE UPDATE ON full_raw_identity_intents
WHEN EXISTS(SELECT 1 FROM full_raw_identity_intents t WHERE t.rowid=NEW.rowid AND t.rowid<>OLD.rowid)
BEGIN SELECT RAISE(ABORT,'METADATA_INTENT_REPLACE_REQUIRES_REVIEW'); END;
CREATE TRIGGER metadata_expense_append_no_replace BEFORE INSERT ON full_raw_append_intents
WHEN EXISTS(SELECT 1 FROM full_raw_append_intents t WHERE t.rowid=NEW.rowid OR (t.spreadsheet_id=NEW.spreadsheet_id AND t.metadata_id=NEW.metadata_id) OR (t.spreadsheet_id=NEW.spreadsheet_id AND t.sheet_name=NEW.sheet_name AND t.expense_id=NEW.expense_id))
BEGIN SELECT RAISE(ABORT,'METADATA_INTENT_REPLACE_REQUIRES_REVIEW'); END;
CREATE TRIGGER metadata_expense_append_rowid_no_replace BEFORE UPDATE ON full_raw_append_intents
WHEN EXISTS(SELECT 1 FROM full_raw_append_intents t WHERE t.rowid=NEW.rowid AND t.rowid<>OLD.rowid)
BEGIN SELECT RAISE(ABORT,'METADATA_INTENT_REPLACE_REQUIRES_REVIEW'); END;
CREATE TRIGGER metadata_personal_identity_no_replace BEFORE INSERT ON personal_raw_identity_intents
WHEN EXISTS(SELECT 1 FROM personal_raw_identity_intents t WHERE t.rowid=NEW.rowid OR (t.spreadsheet_id=NEW.spreadsheet_id AND t.metadata_id=NEW.metadata_id) OR (t.spreadsheet_id=NEW.spreadsheet_id AND t.sheet_name=NEW.sheet_name AND t.personal_use_id=NEW.personal_use_id))
BEGIN SELECT RAISE(ABORT,'METADATA_INTENT_REPLACE_REQUIRES_REVIEW'); END;
CREATE TRIGGER metadata_personal_identity_rowid_no_replace BEFORE UPDATE ON personal_raw_identity_intents
WHEN EXISTS(SELECT 1 FROM personal_raw_identity_intents t WHERE t.rowid=NEW.rowid AND t.rowid<>OLD.rowid)
BEGIN SELECT RAISE(ABORT,'METADATA_INTENT_REPLACE_REQUIRES_REVIEW'); END;
CREATE TRIGGER metadata_expense_identity_no_delete BEFORE DELETE ON full_raw_identity_intents BEGIN SELECT RAISE(ABORT,'METADATA_INTENT_DELETE_REQUIRES_REVIEW'); END;
CREATE TRIGGER metadata_expense_append_no_delete BEFORE DELETE ON full_raw_append_intents BEGIN SELECT RAISE(ABORT,'METADATA_INTENT_DELETE_REQUIRES_REVIEW'); END;
CREATE TRIGGER metadata_personal_identity_no_delete BEFORE DELETE ON personal_raw_identity_intents BEGIN SELECT RAISE(ABORT,'METADATA_INTENT_DELETE_REQUIRES_REVIEW'); END;
