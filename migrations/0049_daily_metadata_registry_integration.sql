-- Uses the workbook-wide registry from 0041. Existing prototype identities
-- are not backfilled or trusted by this migration. Run atomically while all
-- old and new writers are stopped. An ambiguous prior collision aborts.
ALTER TABLE daily_stable_row_intents ADD COLUMN sheet_name TEXT;
ALTER TABLE daily_stable_row_intents ADD COLUMN projected_revision INTEGER;
CREATE TABLE daily_registry_migration_assertion(ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO daily_registry_migration_assertion(ok) SELECT CASE WHEN
 (SELECT count(*) FROM pragma_table_info('daily_recovery_identity_witnesses') WHERE name IN ('sheet_name','projected_revision'))=2
 AND NOT EXISTS(SELECT 1 FROM daily_stable_row_intents i JOIN sheet_metadata_identity_registry r ON r.spreadsheet_id=i.spreadsheet_id AND r.metadata_id=i.metadata_id)
 AND NOT EXISTS(SELECT 1 FROM daily_recovery_identity_witnesses w JOIN sheet_metadata_identity_registry r ON r.spreadsheet_id=w.spreadsheet_id AND r.metadata_id=w.metadata_id)
 THEN 1 ELSE 0 END;
DROP TABLE daily_registry_migration_assertion;
CREATE TRIGGER daily_registry_block_existing BEFORE INSERT ON sheet_metadata_identity_registry
WHEN EXISTS(SELECT 1 FROM daily_stable_row_intents i WHERE i.spreadsheet_id=NEW.spreadsheet_id AND i.metadata_id=NEW.metadata_id) OR EXISTS(SELECT 1 FROM daily_recovery_identity_witnesses w WHERE w.spreadsheet_id=NEW.spreadsheet_id AND w.metadata_id=NEW.metadata_id)
BEGIN SELECT RAISE(ABORT,'daily legacy metadata requires review'); END;
CREATE TRIGGER daily_stable_registry_insert BEFORE INSERT ON daily_stable_row_intents
WHEN NEW.sheet_name IS NULL OR NEW.sheet_name='' OR (NEW.state='VERIFIED' AND (NEW.projected_revision IS NULL OR NEW.projected_revision<1)) OR NOT EXISTS(SELECT 1 FROM sheet_metadata_identity_registry r WHERE r.spreadsheet_id=NEW.spreadsheet_id AND r.sheet_name=NEW.sheet_name AND r.metadata_id=NEW.metadata_id AND r.entity_kind='EXPENSE' AND r.entity_id=NEW.expense_id)
BEGIN SELECT RAISE(ABORT,'daily metadata owner unverified'); END;
CREATE TRIGGER daily_stable_registry_immutable BEFORE UPDATE ON daily_stable_row_intents
WHEN OLD.rowid IS NOT NEW.rowid OR OLD.spreadsheet_id IS NOT NEW.spreadsheet_id OR OLD.sheet_name IS NOT NEW.sheet_name OR OLD.expense_id IS NOT NEW.expense_id OR OLD.metadata_id IS NOT NEW.metadata_id OR (NEW.state='VERIFIED' AND (NEW.projected_revision IS NULL OR NEW.projected_revision<1))
BEGIN SELECT RAISE(ABORT,'daily metadata identity immutable'); END;
CREATE TRIGGER daily_stable_registry_no_delete BEFORE DELETE ON daily_stable_row_intents BEGIN SELECT RAISE(ABORT,'daily stable identity retained'); END;
CREATE TRIGGER daily_stable_registry_no_replace BEFORE INSERT ON daily_stable_row_intents
WHEN EXISTS(SELECT 1 FROM daily_stable_row_intents i WHERE i.rowid=NEW.rowid OR (i.spreadsheet_id=NEW.spreadsheet_id AND (i.expense_id=NEW.expense_id OR i.metadata_id=NEW.metadata_id)))
BEGIN SELECT RAISE(ABORT,'daily stable identity collision'); END;
CREATE TRIGGER daily_witness_registry_insert BEFORE INSERT ON daily_recovery_identity_witnesses
WHEN NEW.sheet_name IS NULL OR NEW.sheet_name='' OR NOT EXISTS(SELECT 1 FROM sheet_metadata_identity_registry r JOIN daily_stable_row_intents i ON i.spreadsheet_id=r.spreadsheet_id AND i.sheet_name=r.sheet_name AND i.expense_id=r.entity_id AND i.metadata_id=r.metadata_id AND i.state='VERIFIED' AND i.projected_version=NEW.projected_version AND i.projected_revision=NEW.projected_revision WHERE r.spreadsheet_id=NEW.spreadsheet_id AND r.sheet_name=NEW.sheet_name AND r.metadata_id=NEW.metadata_id AND r.entity_kind='EXPENSE' AND r.entity_id=NEW.expense_id)
BEGIN SELECT RAISE(ABORT,'daily witness owner unverified'); END;
CREATE TRIGGER daily_witness_no_delete BEFORE DELETE ON daily_recovery_identity_witnesses BEGIN SELECT RAISE(ABORT,'daily witness retained'); END;
CREATE TRIGGER daily_witness_no_update BEFORE UPDATE ON daily_recovery_identity_witnesses BEGIN SELECT RAISE(ABORT,'daily witness immutable'); END;
CREATE TRIGGER daily_witness_no_replace BEFORE INSERT ON daily_recovery_identity_witnesses
WHEN EXISTS(SELECT 1 FROM daily_recovery_identity_witnesses w WHERE w.rowid=NEW.rowid OR (w.spreadsheet_id=NEW.spreadsheet_id AND w.sheet_name=NEW.sheet_name AND w.expense_id=NEW.expense_id AND w.projected_revision=NEW.projected_revision))
BEGIN SELECT RAISE(ABORT,'daily witness collision'); END;
