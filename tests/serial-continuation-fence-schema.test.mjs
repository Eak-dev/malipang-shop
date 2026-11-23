import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../migrations/0074_serial_continuation_fence_draft.sql',import.meta.url),'utf8');
function model(includeLedgerMigration=true){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE stable_workbook_claims(spreadsheet_id TEXT PRIMARY KEY,operation_token TEXT UNIQUE,state TEXT,phase TEXT);
 CREATE TABLE serial_pilot_notice_release_receipts(operation_token TEXT,spreadsheet_id TEXT,epoch_id TEXT,successor_job_id TEXT,nonce TEXT,fence_digest TEXT,fence_generation INTEGER,source_revision INTEGER);
 CREATE TABLE serial_pilot_attested_handoffs(nonce TEXT,spreadsheet_id TEXT,successor_epoch_id TEXT,successor_job_id TEXT,worker_version TEXT,fence_digest TEXT,fence_generation INTEGER,claim_token TEXT);
 CREATE TABLE serial_pilot_oracle_fence(spreadsheet_id TEXT,fence_digest TEXT,generation INTEGER);
 CREATE TABLE serial_pilot_oracle_revocations(spreadsheet_id TEXT,fence_digest TEXT,fence_generation INTEGER);
 CREATE TABLE sync_jobs(job_id TEXT,entity_type TEXT,entity_key TEXT,entity_version INTEGER,status TEXT,last_error TEXT,lease_token TEXT,lease_until TEXT,serial_provenance_version INTEGER,serial_lease_generation INTEGER);
 CREATE TABLE stable_recovery_epochs(epoch_id TEXT,spreadsheet_id TEXT,target_type TEXT,target_key TEXT,target_version INTEGER,state TEXT);
 CREATE TABLE stable_recovery_operations(operation_token TEXT,epoch_id TEXT,state TEXT,admitted_at TEXT);
 CREATE TABLE stable_projection_writes(spreadsheet_id TEXT,entity_type TEXT,entity_id TEXT,source_version INTEGER,projection TEXT,operation_token TEXT,state TEXT,sheet_id INTEGER,sheet_name TEXT,source_digest TEXT);
 CREATE TABLE failed_jobs(queue_name TEXT,job_key TEXT,status TEXT);
 CREATE TABLE stable_source_revision(singleton INTEGER,revision INTEGER);
 CREATE TABLE expense_events(expense_id TEXT,version INTEGER,status TEXT);
 CREATE TABLE expense_document_items(expense_id TEXT,item_id TEXT);
 CREATE TABLE continuous_daily_cutovers(spreadsheet_id TEXT,state TEXT,raw_sheet_id INTEGER,raw_sheet_name TEXT,detail_sheet_id INTEGER,detail_sheet_name TEXT);
 CREATE TABLE continuous_ledger_write_evidence(spreadsheet_id TEXT,entity_id TEXT,projection TEXT,operation_kind TEXT,sheet_id INTEGER,sheet_name TEXT,source_version INTEGER,operation_token TEXT,marker TEXT,before_digest TEXT,payload_digest TEXT);
 CREATE TABLE atomic_daily_marker_reservations(spreadsheet_id TEXT,sheet_id INTEGER,entity_id TEXT,source_version INTEGER,operation_token TEXT,marker TEXT);
 CREATE TABLE continuous_daily_write_evidence(spreadsheet_id TEXT,entity_id TEXT,sheet_id INTEGER,sheet_name TEXT,source_version INTEGER,source_digest TEXT,operation_token TEXT,marker TEXT);
 CREATE TABLE stable_expense_projection_preimages(spreadsheet_id TEXT,entity_type TEXT,entity_id TEXT,source_version INTEGER,projection TEXT,sheet_id INTEGER,sheet_name TEXT,source_digest TEXT);`);db.exec(sql);if(includeLedgerMigration)db.exec(readFileSync(new URL('../migrations/0075_serial_ledger_receipt_draft.sql',import.meta.url),'utf8'));return db;
}
test('0074 alone cannot accept a ledger receipt before the follow-on migration',()=>{
 const db=model(false);try{
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_ledger_stage_receipts VALUES('token','epoch','book','job','entity','EXPENSE_RAW',1,'source',1,2,'sheet','before','payload','marker','worker','nonce','SHA256_MALIPANG_NOTICE_POSTIMAGE_V1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','observed','recorded')"));
  assert.equal(db.prepare('SELECT count(*) n FROM serial_pilot_ledger_stage_receipts').get().n,0);
  const completion="INSERT INTO serial_pilot_final_completions VALUES('token','epoch','book','job','nonce','worker',1,'daily',2,'raw',3,'detail','provider','notice','p-time','n-time','done')";
  assert.throws(()=>db.exec(completion));db.exec('DROP TRIGGER serial_final_completion_not_ready');assert.throws(()=>db.exec(completion));
  assert.equal(db.prepare('SELECT count(*) n FROM serial_pilot_final_completions').get().n,0);
  db.exec(readFileSync(new URL('../migrations/0075_serial_ledger_receipt_draft.sql',import.meta.url),'utf8'));
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_ledger_stage_receipts VALUES('token','epoch','book','job','entity','EXPENSE_RAW',1,'source',1,2,'sheet','before','payload','marker','worker','nonce','SHA256_MALIPANG_NOTICE_POSTIMAGE_V1','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','observed','recorded')"));
 }finally{db.close();}
});
test('continuation barriers preserve ordinary claim behavior while disabled',()=>{
 const db=model();try{
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_continuation_sessions VALUES('epoch','book','job','nonce','digest',1,'now')"));
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_continuation_permits VALUES('token','epoch','job','lease',1,'worker','now')"));
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_continuation_authorizations VALUES('token','epoch','job','lease',1,'first','worker','now')"));
  db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('book','token','HELD'); UPDATE stable_workbook_claims SET state='REVIEW'; DELETE FROM stable_workbook_claims");
  assert.equal(db.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{db.close();}
});
test('initial serial pilot claim remains fenced before a session exists',()=>{
 const db=model();try{
  db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase) VALUES('book','token','HELD','SERIAL_PILOT_ADOPTED')");
  const rowid=db.prepare("SELECT rowid FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().rowid;
  for(const sql of ["DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'","UPDATE stable_workbook_claims SET phase='OPERATION' WHERE spreadsheet_id='book'","UPDATE stable_workbook_claims SET phase=NULL WHERE spreadsheet_id='book'","UPDATE stable_workbook_claims SET spreadsheet_id='elsewhere' WHERE spreadsheet_id='book'","INSERT OR REPLACE INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('book','other','HELD')","INSERT OR REPLACE INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('elsewhere','token','HELD')"])assert.throws(()=>db.exec(sql));
  assert.throws(()=>db.prepare("INSERT OR REPLACE INTO stable_workbook_claims(rowid,spreadsheet_id,operation_token,state) VALUES(?,'elsewhere','other','HELD')").run(rowid));
  db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('other','other','HELD')");
  assert.throws(()=>db.exec("UPDATE OR REPLACE stable_workbook_claims SET spreadsheet_id='book' WHERE spreadsheet_id='other'"));
  assert.throws(()=>db.exec("UPDATE OR REPLACE stable_workbook_claims SET operation_token='token' WHERE spreadsheet_id='other'"));
  assert.throws(()=>db.prepare("UPDATE OR REPLACE stable_workbook_claims SET rowid=? WHERE spreadsheet_id='other'").run(rowid));
  db.exec("UPDATE stable_workbook_claims SET state='REVIEW' WHERE spreadsheet_id='book'");
  assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET state='HELD' WHERE spreadsheet_id='book'"));
  assert.equal(db.prepare("SELECT phase FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().phase,'SERIAL_PILOT_ADOPTED');
 }finally{db.close();}
});
test('attested reserved and taken claims stay fenced before adoption',()=>{
 const db=model();try{
  db.exec("INSERT INTO serial_pilot_attested_handoffs(nonce,spreadsheet_id,claim_token) VALUES('nonce','book','token'); INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase) VALUES('book','token','HELD','PILOT_RESERVED')");
  const rowid=db.prepare("SELECT rowid FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().rowid;
  for(const phase of ['PILOT_RESERVED','PILOT_TAKEN']){
   if(phase==='PILOT_TAKEN')db.exec("UPDATE stable_workbook_claims SET phase='PILOT_TAKEN' WHERE spreadsheet_id='book'");
   assert.throws(()=>db.exec("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'"));
   assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET phase='OPERATION' WHERE spreadsheet_id='book'"));
   assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET phase=NULL WHERE spreadsheet_id='book'"));
   assert.throws(()=>db.exec("INSERT OR REPLACE INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('other','token','HELD')"));
   assert.throws(()=>db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('book','new','HELD') ON CONFLICT DO NOTHING"));
   assert.throws(()=>db.prepare("INSERT OR REPLACE INTO stable_workbook_claims(rowid,spreadsheet_id,operation_token,state) VALUES(?,'other','other','HELD')").run(rowid));
   assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET spreadsheet_id='other' WHERE spreadsheet_id='book'"));
   assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET spreadsheet_id=NULL WHERE spreadsheet_id='book'"));
   assert.throws(()=>db.exec("UPDATE OR REPLACE stable_workbook_claims SET spreadsheet_id=NULL WHERE spreadsheet_id='book'"));
   assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET operation_token=NULL WHERE spreadsheet_id='book'"));
  }
  db.exec("UPDATE stable_workbook_claims SET phase='SERIAL_PILOT_ADOPTED' WHERE spreadsheet_id='book'");
  assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET phase='PILOT_TAKEN' WHERE spreadsheet_id='book'"));
  db.exec("UPDATE stable_workbook_claims SET state='REVIEW' WHERE spreadsheet_id='book'");
  assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET state='HELD' WHERE spreadsheet_id='book'"));
  assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET phase='OPERATION' WHERE spreadsheet_id='book'"));
 }finally{db.close();}
});
test('attested claim with missing phase cannot be laundered into an ordinary claim',()=>{
 const db=model();try{
  db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase) VALUES('book','token','HELD',NULL); INSERT INTO serial_pilot_attested_handoffs(nonce,spreadsheet_id,claim_token) VALUES('nonce','book','token')");
  assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET phase='OPERATION' WHERE spreadsheet_id='book'"));
  assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET spreadsheet_id=NULL WHERE spreadsheet_id='book'"));
  assert.throws(()=>db.exec("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'"));
 }finally{db.close();}
});
test('mock session rejects unrelated claims, stale permits, replacement and revoked release',()=>{
 const db=model();try{
  const required=["stable_source_revision_expense_events_insert", "stable_source_revision_expense_events_update", "stable_source_revision_expense_events_delete", "stable_source_revision_expense_documents_insert", "stable_source_revision_expense_documents_update", "stable_source_revision_expense_documents_delete", "stable_source_revision_expense_document_links_insert", "stable_source_revision_expense_document_links_update", "stable_source_revision_expense_document_links_delete", "stable_source_revision_expense_document_items_insert", "stable_source_revision_expense_document_items_update", "stable_source_revision_expense_document_items_delete", "stable_source_revision_owner_personal_transactions_insert", "stable_source_revision_owner_personal_transactions_update", "stable_source_revision_owner_personal_transactions_delete", "stable_source_revision_no_delete", "stable_source_revision_no_replace", "stable_source_revision_monotonic", "stable_pre_cutover_no_delete", "stable_pre_cutover_no_update", "stable_pre_cutover_no_replace", "stable_cutover_no_delete", "stable_cutover_no_replace", "stable_cutover_transition", "stable_projection_no_delete", "stable_projection_no_replace", "stable_projection_transition", "continuous_daily_cutover_prepared", "continuous_daily_cutover_no_delete", "continuous_daily_cutover_no_replace", "continuous_daily_cutover_transition", "continuous_daily_snapshot_prepared", "continuous_daily_snapshot_no_delete", "continuous_daily_snapshot_no_update", "continuous_daily_snapshot_no_replace", "continuous_daily_record_post_cutover", "continuous_daily_post_no_delete", "continuous_daily_post_no_update", "continuous_daily_post_no_replace", "continuous_expense_projection_target_fence", "continuous_expense_cutover_no_processing", "atomic_daily_marker_no_delete", "atomic_daily_marker_no_update", "atomic_daily_marker_no_replace", "stable_expense_preimage_verified_source", "stable_expense_preimage_no_update", "stable_expense_preimage_no_delete", "stable_expense_preimage_no_replace", "continuous_report_attempt_insert", "continuous_report_attempt_transition", "continuous_report_attempt_no_delete", "continuous_report_attempt_no_replace", "continuous_ledger_evidence_source", "continuous_ledger_evidence_no_update", "continuous_ledger_evidence_no_delete", "continuous_ledger_evidence_no_replace", "continuous_daily_evidence_source", "continuous_daily_evidence_no_update", "continuous_daily_evidence_no_delete", "continuous_daily_evidence_no_replace", "serial_source_provenance_no_update", "serial_source_provenance_no_delete", "serial_source_provenance_no_replace", "serial_source_provenance_namespace_guard", "serial_source_provenance_insert_guard", "serial_source_provenance_update_guard", "serial_source_provenance_delete_guard", "serial_source_job_birth_guard", "serial_job_provenance_insert_guard", "serial_job_provenance_update_guard", "serial_job_provenance_delete_guard", "serial_job_provenance_activation_no_update", "serial_job_provenance_activation_no_delete", "serial_job_provenance_activation_no_replace", "serial_job_provenance_source_gate", "serial_pilot_hold_no_replace", "serial_pilot_hold_no_update", "serial_pilot_hold_no_delete", "serial_pilot_oracle_fence_no_replace", "serial_pilot_oracle_fence_no_update", "serial_pilot_oracle_fence_no_delete", "serial_pilot_attested_handoff_no_replace", "serial_pilot_attested_handoff_no_update", "serial_pilot_attested_handoff_no_delete", "serial_pilot_round_insert", "serial_pilot_items_insert", "serial_pilot_items_no_update", "serial_pilot_items_no_delete", "serial_pilot_round_no_delete", "serial_pilot_round_transition", "serial_pilot_bindings_insert", "serial_pilot_bindings_no_update", "serial_pilot_bindings_no_delete", "serial_pilot_fence_reservation", "serial_pilot_fence_audit_no_replace", "serial_pilot_fence_audit_no_update", "serial_pilot_fence_audit_no_delete", "serial_pilot_snapshot_insert_guard", "serial_pilot_snapshot_audit", "serial_pilot_oracle_revoke_insert", "serial_pilot_oracle_revoke_no_update", "serial_pilot_oracle_revoke_no_delete", "serial_pilot_notice_release_no_replace", "serial_pilot_notice_release_no_update", "serial_pilot_notice_release_no_delete", "serial_ledger_stage_no_replace", "serial_ledger_stage_no_update", "serial_ledger_stage_no_delete", "serial_continuation_session_insert", "serial_continuation_session_no_update", "serial_continuation_session_no_delete", "serial_continuation_permit_insert", "serial_continuation_permit_no_update", "serial_continuation_permit_no_delete", "serial_continuation_claim_insert", "serial_continuation_claim_conflict", "serial_continuation_claim_identity", "serial_continuation_claim_review", "serial_continuation_claim_delete", "serial_continuation_completion_guard", "serial_continuation_completion_no_update", "serial_continuation_completion_no_delete"];
  required.push('serial_continuation_authorization_insert','serial_continuation_authorization_no_update','serial_continuation_authorization_no_delete','serial_continuation_claim_phase');
  db.exec('CREATE TABLE integrity_fixture(x INTEGER)');for(const name of required){if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name))db.exec('CREATE TRIGGER '+name+' BEFORE INSERT ON integrity_fixture BEGIN SELECT 1; END;');}
  db.exec('DROP TRIGGER serial_ledger_stage_not_ready; DROP TRIGGER serial_continuation_permit_not_ready; DROP TRIGGER serial_continuation_authorization_not_ready');
  db.exec(`INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('book','first','HELD');
  INSERT INTO serial_pilot_notice_release_receipts VALUES('first','book','epoch','job','nonce','digest',1,1);
  INSERT INTO serial_pilot_attested_handoffs VALUES('nonce','book','epoch','job','worker','digest',1,'initial');
  INSERT INTO serial_pilot_oracle_fence VALUES('book','digest',1);
  INSERT INTO sync_jobs VALUES('job','EXPENSE','expense',1,'PENDING','STABLE_STAGE_CONTINUE',NULL,NULL,1,1);
  INSERT INTO stable_recovery_epochs VALUES('epoch','book','EXPENSE','expense',1,'ARMED');
  INSERT INTO stable_recovery_operations VALUES('first','epoch','VERIFIED','now');
  INSERT INTO stable_projection_writes VALUES('book','EXPENSE','expense',1,'DAILY','first','VERIFIED',2,'daily','source');
  INSERT INTO stable_source_revision VALUES(1,1);
  INSERT INTO atomic_daily_marker_reservations VALUES('book',2,'expense',1,'first','marker');
  INSERT INTO continuous_daily_write_evidence VALUES('book','expense',2,'daily',1,'source','first','marker');
  INSERT INTO stable_expense_projection_preimages VALUES('book','EXPENSE','expense',1,'DAILY',2,'daily','source');
  DROP TRIGGER serial_continuation_session_not_ready;
  INSERT INTO serial_pilot_continuation_sessions VALUES('epoch','book','job','nonce','digest',1,'now');`);
  for(const name of required.filter(name=>name!=='serial_continuation_claim_delete')){
   const saved=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name).sql;
   db.exec('DROP TRIGGER '+name);
   assert.throws(()=>db.exec("DELETE FROM stable_workbook_claims WHERE operation_token='first'"),'missing '+name+' must hold');
   db.exec(saved);
  }
  db.exec("DELETE FROM stable_workbook_claims WHERE operation_token='first'");
  assert.throws(()=>db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('book','other','HELD')"));
  db.exec("UPDATE sync_jobs SET status='PROCESSING',last_error=NULL,lease_token='lease',lease_until='2099-01-01T00:00:00.000Z',serial_lease_generation=4;");
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_continuation_authorizations VALUES('next','epoch','job','wrong',4,'first','worker','now')"));
  db.exec("INSERT INTO serial_pilot_continuation_authorizations VALUES('next','epoch','job','lease',4,'first','worker','now')");
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_continuation_authorizations VALUES('other-auth','epoch','job','lease',4,'first','worker','now')"));
  assert.throws(()=>db.exec("UPDATE serial_pilot_continuation_authorizations SET previous_operation_token='wrong'"));
  assert.throws(()=>db.exec("DELETE FROM serial_pilot_continuation_authorizations"));
  assert.throws(()=>db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase) VALUES('book','next','HELD','SERIAL_CONTINUATION')"),'authorization alone cannot acquire');
  db.exec("INSERT INTO serial_pilot_oracle_revocations VALUES('book','digest',1)");
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_continuation_permits VALUES('next','epoch','job','lease',4,'worker','now')"));
  db.exec('DELETE FROM serial_pilot_oracle_revocations');
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_continuation_permits VALUES('next','epoch','job','wrong',4,'worker','now')"));
  db.exec("UPDATE stable_source_revision SET revision=2");
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_continuation_permits VALUES('next','epoch','job','lease',4,'worker','now')"));
  db.exec("UPDATE stable_source_revision SET revision=1; UPDATE continuous_daily_write_evidence SET marker='wrong'");
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_continuation_permits VALUES('next','epoch','job','lease',4,'worker','now')"));
  db.exec("UPDATE continuous_daily_write_evidence SET marker='marker'; INSERT INTO serial_pilot_continuation_permits VALUES('next','epoch','job','lease',4,'worker','now'); UPDATE stable_recovery_epochs SET state='REVIEW' WHERE epoch_id='epoch'");
  assert.throws(()=>db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase) VALUES('book','next','HELD','SERIAL_CONTINUATION')"));
  db.exec("UPDATE stable_recovery_epochs SET state='ARMED' WHERE epoch_id='epoch'; UPDATE sync_jobs SET serial_lease_generation=5,lease_token='renewed' WHERE job_id='job'");
  assert.throws(()=>db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase) VALUES('book','next','HELD','SERIAL_CONTINUATION')"),'separately committed permit cannot use stale lease');
  db.exec("UPDATE sync_jobs SET serial_lease_generation=4,lease_token='lease' WHERE job_id='job'");
  assert.throws(()=>db.exec("INSERT INTO serial_pilot_continuation_permits VALUES('duplicate','epoch','job','lease',4,'worker','now')"));
  for(const name of required.filter(name=>name!=='serial_continuation_claim_insert')){
   const saved=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name).sql;
   db.exec('DROP TRIGGER '+name);
   assert.throws(()=>db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase) VALUES('book','next','HELD','SERIAL_CONTINUATION')"),'missing '+name+' must reject acquisition');
   db.exec(saved);
  }
  db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase) VALUES('book','next','HELD','SERIAL_CONTINUATION')");
  assert.throws(()=>db.exec("INSERT OR REPLACE INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('book','next','HELD')"));
  const rowid=db.prepare("SELECT rowid FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().rowid;
  assert.throws(()=>db.exec("INSERT OR REPLACE INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('other','next','HELD')"));
  assert.throws(()=>db.prepare("INSERT OR REPLACE INTO stable_workbook_claims(rowid,spreadsheet_id,operation_token,state) VALUES(?,'other','other','HELD')").run(rowid));
  db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state) VALUES('other','other','HELD')");
  assert.throws(()=>db.exec("UPDATE OR REPLACE stable_workbook_claims SET spreadsheet_id='book' WHERE spreadsheet_id='other'"));
  assert.throws(()=>db.exec("UPDATE OR REPLACE stable_workbook_claims SET operation_token='next' WHERE spreadsheet_id='other'"));
  assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET spreadsheet_id='third' WHERE spreadsheet_id='book'"));
  assert.throws(()=>db.exec("UPDATE stable_workbook_claims SET phase='OPERATION' WHERE operation_token='next'"));
  assert.throws(()=>db.exec("DELETE FROM stable_workbook_claims WHERE operation_token='next'"));
  db.exec("INSERT INTO serial_pilot_oracle_revocations VALUES('book','digest',1)");
  assert.throws(()=>db.exec("DELETE FROM stable_workbook_claims WHERE operation_token='next'"));
  assert.equal(db.prepare("SELECT operation_token FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().operation_token,'next');
  const deleteTrigger=db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_continuation_claim_delete'").get().sql;
  db.exec("DROP TRIGGER serial_continuation_claim_delete; DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'; DELETE FROM serial_pilot_oracle_revocations; UPDATE sync_jobs SET serial_lease_generation=5 WHERE job_id='job'");db.exec(deleteTrigger);
  assert.throws(()=>db.exec("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase) VALUES('book','next','HELD','SERIAL_CONTINUATION')"),'old permit cannot be reused after lease generation changes');
  db.exec("INSERT INTO serial_pilot_continuation_authorizations VALUES('renewed-token','epoch','job','lease',5,'first','worker','now'); INSERT INTO serial_pilot_continuation_permits VALUES('renewed-token','epoch','job','lease',5,'worker','now'); INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,phase) VALUES('book','renewed-token','HELD','SERIAL_CONTINUATION')");
  assert.equal(db.prepare("SELECT operation_token FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().operation_token,'renewed-token');
 }finally{db.close();}
});
