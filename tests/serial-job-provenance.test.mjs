import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
const migration=readFileSync(new URL('../migrations-draft/0069_serial_job_provenance_draft.sql',import.meta.url),'utf8');
const sourceMigration=readFileSync(new URL('../migrations-draft/0070_serial_source_provenance_draft.sql',import.meta.url),'utf8');
function setup(){const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE sync_jobs(job_id TEXT PRIMARY KEY,entity_type TEXT NOT NULL,entity_key TEXT NOT NULL,entity_version INTEGER NOT NULL,status TEXT NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,lease_token TEXT,lease_until TEXT,UNIQUE(entity_type,entity_key,entity_version)); CREATE TABLE continuous_daily_post_cutover_expenses(spreadsheet_id,expense_id); CREATE TABLE continuous_daily_cutovers(spreadsheet_id,state); CREATE TABLE expense_events(expense_id TEXT PRIMARY KEY,message_id TEXT UNIQUE,version INTEGER,status TEXT); INSERT INTO continuous_daily_cutovers VALUES('book','ACTIVE'); INSERT INTO expense_events VALUES('old','m-old',1,'CONFIRMED'),('new','m-new',1,'CONFIRMED'),('drift','m-drift',1,'CONFIRMED'); INSERT INTO continuous_daily_post_cutover_expenses VALUES('book','old'),('book','new'),('book','drift'); CREATE TRIGGER continuous_daily_post_no_delete BEFORE DELETE ON continuous_daily_post_cutover_expenses BEGIN SELECT RAISE(ABORT,'retained'); END; CREATE TRIGGER continuous_daily_post_no_update BEFORE UPDATE ON continuous_daily_post_cutover_expenses BEGIN SELECT RAISE(ABORT,'immutable'); END; CREATE TRIGGER continuous_daily_post_no_replace BEFORE INSERT ON continuous_daily_post_cutover_expenses WHEN 0 BEGIN SELECT RAISE(ABORT,'collision'); END; CREATE TRIGGER continuous_daily_record_post_cutover AFTER INSERT ON expense_events BEGIN SELECT 1; END;");return db;}
const add=(db,id,key,extra='')=>db.exec(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,status${extra?',serial_provenance_version':''}) VALUES('${id}','EXPENSE','${key}',1,'PENDING'${extra?',1':''})`);
test('default-off keeps legacy jobs unknown and preserves existing conflict behavior',()=>{const db=setup();try{
 add(db,'legacy','old');db.exec(migration);add(db,'off','new');
 db.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='x' WHERE job_id='off'; UPDATE sync_jobs SET status='PENDING',attempt_count=0,lease_token=NULL WHERE job_id='off'");
 assert.equal(db.prepare("SELECT serial_provenance_version FROM sync_jobs WHERE job_id='legacy'").get().serial_provenance_version,0);
 assert.throws(()=>add(db,'invalid','bad','1'));assert.throws(()=>db.exec("INSERT INTO serial_job_provenance_activation VALUES(1,'book','now')"));
 db.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,status) VALUES('dup','EXPENSE','new',1,'PENDING') ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING");
}finally{db.close();}});
test('active draft requires monotonic same-row lease generations and fences legacy laundering',()=>{const db=setup();try{
 add(db,'legacy','old');db.exec(migration);db.exec("DROP TRIGGER serial_job_provenance_not_ready");
 assert.throws(()=>db.exec("INSERT INTO serial_job_provenance_activation VALUES(1,'book','now')"),'partial 0069 cannot activate');
 db.exec(sourceMigration);db.exec("DROP TRIGGER serial_source_provenance_not_ready");const ns='a'.repeat(32),key=`exp_${ns}_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
 db.prepare("INSERT INTO serial_source_provenance_activation VALUES(1,'book',?,'now')").run(ns);
 db.prepare("INSERT INTO expense_events(expense_id,message_id,version,status,serial_source_namespace) VALUES(?, 'm-tagged',1,'WAITING_CONFIRM',?)").run(key,ns);
 db.prepare("UPDATE expense_events SET status='CONFIRMED' WHERE expense_id=?").run(key);
 db.prepare("INSERT INTO continuous_daily_post_cutover_expenses VALUES('book',?)").run(key);
 db.exec("INSERT INTO serial_job_provenance_activation VALUES(1,'book','now')");assert.throws(()=>add(db,'legacy-source','new','1'));
 db.exec('SAVEPOINT drift; DROP TRIGGER serial_source_job_birth_guard');assert.throws(()=>add(db,'missing-guard',key,'1'));db.exec('ROLLBACK TO drift; RELEASE drift');
 add(db,'new',key,'1');
 assert.throws(()=>db.exec("UPDATE sync_jobs SET serial_provenance_version=1 WHERE job_id='legacy'"));
 assert.throws(()=>db.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='old' WHERE job_id='new'"));
 db.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='new',serial_lease_generation=serial_lease_generation+1 WHERE job_id='new'; UPDATE sync_jobs SET status='PENDING',attempt_count=0,lease_token=NULL WHERE job_id='new'");
 assert.equal(db.prepare("SELECT serial_lease_generation FROM sync_jobs WHERE job_id='new'").get().serial_lease_generation,1);
 assert.throws(()=>db.exec("UPDATE sync_jobs SET serial_lease_generation=0 WHERE job_id='new'"));
 assert.throws(()=>db.exec("INSERT OR REPLACE INTO sync_jobs(job_id,entity_type,entity_key,entity_version,status) VALUES('legacy','EXPENSE','changed',1,'PENDING')"));
 assert.throws(()=>db.exec("INSERT OR REPLACE INTO sync_jobs(job_id,entity_type,entity_key,entity_version,status) VALUES('legacy','PERSONAL_USE','changed',1,'PENDING')"));
 assert.throws(()=>db.exec("DELETE FROM sync_jobs WHERE job_id='legacy'"));
 assert.throws(()=>db.exec("UPDATE sync_jobs SET entity_key='changed' WHERE job_id='new'"));
 db.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,status) VALUES('personal','PERSONAL_USE','personal',1,'PENDING'); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,status) VALUES('personal-duplicate','PERSONAL_USE','personal',1,'PENDING') ON CONFLICT(entity_type,entity_key,entity_version) DO NOTHING; UPDATE sync_jobs SET status='PROCESSING',lease_token='x' WHERE job_id='personal'; DELETE FROM sync_jobs WHERE job_id='personal'");
 db.exec('DROP TRIGGER serial_job_provenance_update_guard');assert.throws(()=>add(db,'drift','drift','1'));
}finally{db.close();}});

test('synthetic partial 0069 and 0070 column migrations are detectable and cannot be treated as ready',()=>{
 for(const [table,column,sql] of [['sync_jobs','serial_provenance_version',migration],['expense_events','serial_source_namespace',sourceMigration]]){
  const db=setup();try{
   const alter=sql.match(new RegExp(`^ALTER TABLE ${table} ADD COLUMN ${column}[^;]*;`,'m'))?.[0];assert.ok(alter);
   // This is a SQLite transaction simulation, not evidence of D1 deployment atomicity.
   db.exec('BEGIN');db.exec(alter);db.exec('ROLLBACK');
   assert.ok(!db.prepare(`PRAGMA table_info(${table})`).all().some(x=>x.name===column));
   db.exec(alter);assert.throws(()=>db.exec(sql),/duplicate column/i,'plain retry cannot be treated as a forward fix');
   assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN ('serial_job_provenance_activation','serial_source_provenance_activation')").get().n,0);
   assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name IN ('serial_job_provenance_not_ready','serial_source_provenance_not_ready')").get().n,0);
   // No marker or guard exists: callers must treat this shape as UNKNOWN.
  }finally{db.close();}
 }
});
