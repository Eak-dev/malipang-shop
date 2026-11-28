import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';

test('round membership seals before processing; each result and the close are immutable',()=>{
 const h=expenseSqlite(),d=h.sqlite;
 try{
  assert.throws(()=>d.exec("INSERT INTO serial_pilot_rounds VALUES('bad',NULL,0,'CLOSED','now','then','bad')"));
  d.exec("INSERT INTO serial_pilot_rounds VALUES('round',NULL,2,'PREPARING','now',NULL,NULL)");
  assert.throws(()=>d.exec("INSERT OR REPLACE INTO serial_pilot_rounds(rowid,round_id,recovery_of,selected_count,state,created_at) VALUES((SELECT rowid FROM serial_pilot_rounds WHERE round_id='round'),'replacement',NULL,0,'PREPARING','now')"));
  assert.throws(()=>d.exec("INSERT OR REPLACE INTO serial_pilot_rounds VALUES('round',NULL,0,'PREPARING','now',NULL,NULL)"));
  assert.throws(()=>d.exec("INSERT INTO serial_pilot_rounds VALUES('recovery','round',0,'PREPARING','now',NULL,NULL)"));
  const item=d.prepare('INSERT INTO serial_pilot_round_items VALUES(?,?,?)');
  item.run('round',0,'job-a');
  assert.throws(()=>d.exec("INSERT OR REPLACE INTO serial_pilot_round_items(rowid,round_id,ordinal,job_id) VALUES((SELECT rowid FROM serial_pilot_round_items WHERE job_id='job-a'),'round',1,'job-other')"));
  assert.throws(()=>item.run('round',1,'job-a'));
  assert.throws(()=>d.exec("UPDATE serial_pilot_rounds SET state='OPEN' WHERE round_id='round'"));
  item.run('round',1,'job-b');
  assert.throws(()=>item.run('round',2,'job-c'));
  d.exec("UPDATE serial_pilot_rounds SET state='OPEN' WHERE round_id='round'");
  assert.throws(()=>item.run('round',0,'job-c'));
  assert.throws(()=>d.exec("UPDATE serial_pilot_round_items SET job_id='other' WHERE job_id='job-a'"));
  assert.throws(()=>d.exec("DELETE FROM serial_pilot_round_items WHERE job_id='job-a'"));
  const result=d.prepare('INSERT INTO serial_pilot_round_results VALUES(?,?,?,?,?)');
  result.run('round','job-a','RECONCILE','uncertain',null);
  assert.throws(()=>d.exec("UPDATE serial_pilot_rounds SET state='CLOSED',closed_at='later',reason='held' WHERE round_id='round'"));
  assert.throws(()=>result.run('round','job-a','VERIFIED','changed',null));
  result.run('round','job-b','NOT_STARTED','not admitted',null);
  d.exec("UPDATE serial_pilot_rounds SET state='CLOSED',closed_at='later',reason='held' WHERE round_id='round'");
  assert.throws(()=>d.exec("UPDATE serial_pilot_round_results SET category='VERIFIED' WHERE job_id='job-a'"));
  assert.throws(()=>d.exec("UPDATE serial_pilot_rounds SET reason='other' WHERE round_id='round'"));
  assert.throws(()=>d.exec("DELETE FROM serial_pilot_rounds WHERE round_id='round'"));
  d.exec("INSERT INTO serial_pilot_rounds VALUES('empty','round',0,'PREPARING','now',NULL,NULL); UPDATE serial_pilot_rounds SET state='OPEN' WHERE round_id='empty'; UPDATE serial_pilot_rounds SET state='CLOSED',closed_at='later',reason='empty' WHERE round_id='empty'");
 }finally{h.close();}
});

test('0068-only classification remains blocked when the initial barrier is removed',()=>{
 const d=new DatabaseSync(':memory:');try{
  d.exec('CREATE TABLE admin_audit(id TEXT, action TEXT, entity_key TEXT, reason TEXT, before_json TEXT, after_json TEXT)');
  d.exec(readFileSync(new URL('../migrations-draft/0068_serial_round_evidence.sql',import.meta.url),'utf8'));
  const sql="INSERT INTO serial_pilot_classification_evidence VALUES('round','job','PARKED','MOCK_ATTESTED_HANDOFF','next','namespace',1,'"+'a'.repeat(64)+"',1,'nonce','worker')";
  assert.throws(()=>d.exec(sql),/classification (not ready|not implemented)/);d.exec('DROP TRIGGER serial_classification_not_ready');assert.throws(()=>d.exec(sql),/classification not implemented/);
  assert.equal(d.prepare('SELECT count(*) n FROM serial_pilot_classification_evidence').get().n,0);
 }finally{d.close();}
});

test('classifier predicates match the migration guards including every placeholder',()=>{
 const migration=readFileSync(new URL('../migrations-draft/0078_serial_classification_draft.sql',import.meta.url),'utf8');
 const generated=readFileSync(new URL('../src/admin/serial-classification-predicates.ts',import.meta.url),'utf8');
 for(const [guard,exportName] of [['serial_classification_parked_guard','parkedClassificationPredicate'],['serial_classification_not_started_guard','notStartedClassificationPredicate']]){
  const begin=migration.indexOf(`CREATE TRIGGER ${guard} BEFORE INSERT`),start=migration.indexOf('AND NOT EXISTS(\n',begin)+'AND NOT EXISTS(\n'.length,end=migration.indexOf('\n) BEGIN SELECT RAISE',start);
  assert.ok(begin>=0&&start>begin&&end>start);
  const expected=migration.slice(start,end).replace(/NEW\.([a-z_]+)/g,(_match,name)=>`__FIELD_${name}__`);
  const literal=generated.match(new RegExp(`export const ${exportName}=(.*);`));assert.ok(literal);
  assert.equal(JSON.parse(literal[1]),expected);
  assert.ok(!/\bNEW\./.test(expected));
 }
});

test('mock mixed close refuses a separately committed VERIFIED label',()=>{
 const h=expenseSqlite(),d=h.sqlite;
 try{
  d.exec("DROP TRIGGER serial_pilot_fence_not_ready; INSERT INTO serial_pilot_round_fence_activation VALUES(1,'2000-01-01T00:00:00.000Z'); INSERT INTO serial_pilot_rounds VALUES('round',NULL,1,'PREPARING','now',NULL,NULL)");
  d.prepare('INSERT INTO serial_pilot_round_bindings VALUES(?,?,?)').run('round','book','a'.repeat(64));
  d.exec("INSERT INTO serial_pilot_round_items VALUES('round',0,'job'); UPDATE serial_pilot_rounds SET state='OPEN' WHERE round_id='round'; DROP TRIGGER serial_pilot_fence_result; INSERT INTO serial_pilot_round_results VALUES('round','job','VERIFIED','VERIFIED_RECEIPT',NULL)");
  d.exec('DROP TRIGGER serial_pilot_verified_close_chain; DROP TRIGGER serial_pilot_verified_close_guard; DROP TRIGGER serial_pilot_verified_close_journal; DROP TRIGGER serial_pilot_verified_close_mixed; DROP TRIGGER serial_pilot_verified_close_integrity');
  assert.throws(()=>d.exec("UPDATE serial_pilot_rounds SET state='CLOSED',closed_at='later',reason='MOCK_CLASSIFIED' WHERE round_id='round'"),/invalid round transition/);
  d.exec('DROP TRIGGER serial_pilot_verified_close_not_ready');
  assert.throws(()=>d.exec("UPDATE serial_pilot_rounds SET state='CLOSED',closed_at='later',reason='ALL_VERIFIED' WHERE round_id='round'"),/invalid round transition/);
  assert.equal(d.prepare("SELECT state FROM serial_pilot_rounds WHERE round_id='round'").get().state,'OPEN');
 }finally{h.close();}
});
