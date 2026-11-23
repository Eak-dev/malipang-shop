import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const migration=readFileSync(new URL('../migrations/0070_serial_source_provenance_draft.sql',import.meta.url),'utf8');
function setup(){const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE expense_events(expense_id TEXT PRIMARY KEY,message_id TEXT UNIQUE,status TEXT,version INTEGER); CREATE TABLE sync_jobs(entity_type TEXT,entity_key TEXT)");db.exec(migration);return db;}
const namespace='a'.repeat(32),id=`exp_${namespace}_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
test('source namespace stays disabled and legacy inserts remain unchanged',()=>{const db=setup();try{
 db.exec("INSERT INTO expense_events(expense_id,message_id,status,version) VALUES('legacy','msg','WAITING_CONFIRM',1)");
 assert.throws(()=>db.prepare("INSERT INTO serial_source_provenance_activation VALUES(1,'book',?,'now')").run(namespace));
 assert.throws(()=>db.prepare("INSERT INTO expense_events VALUES(?,?,'WAITING_CONFIRM',1,?)").run(id,'tagged',namespace));
 assert.equal(db.prepare("SELECT serial_source_namespace FROM expense_events WHERE expense_id='legacy'").get().serial_source_namespace,null);
}finally{db.close();}});
test('opt-in text draft uses a fresh namespace and duplicate delivery retains one source',async()=>{
 const h=expenseSqlite(),{handleExpenseText}=createRequire(import.meta.url)('../dist/expense/service.js');try{
  h.sqlite.exec("DROP TRIGGER serial_source_provenance_not_ready; INSERT INTO serial_source_provenance_activation VALUES(1,'book','"+namespace+"','now')");
  Object.assign(h.env,{SERIAL_SOURCE_PROVENANCE_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});
  const event={source:{type:'user',userId:'synthetic'},message:{id:'message-source',type:'text',text:'ค่าไฟ transfer 1200'}};
  assert.equal(await handleExpenseText(h.env,event,'trace'), 'WAITING_CONFIRM');
  assert.equal(await handleExpenseText(h.env,event,'trace'), 'WAITING_CONFIRM');
  const rows=h.sqlite.prepare("SELECT expense_id,serial_source_namespace FROM expense_events WHERE message_id='message-source'").all();
  assert.equal(rows.length,1);assert.equal(rows[0].serial_source_namespace,namespace);assert.match(rows[0].expense_id,new RegExp('^exp_'+namespace+'_[a-f0-9-]{36}$'));
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM expense_audit_log WHERE expense_id=? AND action='CREATE_DRAFT'").get(rows[0].expense_id).n,1);
  assert.equal(rows[0].expense_id.length,73);assert.equal(h.queue.length,0);
 }finally{h.close();}
});
test('lost source batch acknowledgement preserves source and audit without replay',async()=>{
 const h=expenseSqlite(),{handleExpenseText}=createRequire(import.meta.url)('../dist/expense/service.js');try{
  h.sqlite.exec("DROP TRIGGER serial_source_provenance_not_ready; INSERT INTO serial_source_provenance_activation VALUES(1,'book','"+namespace+"','now')");
  Object.assign(h.env,{SERIAL_SOURCE_PROVENANCE_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});h.DB.failAfterCommit=true;
  const event={source:{type:'user',userId:'synthetic'},message:{id:'lost-source',type:'text',text:'ค่าไฟ transfer 1200'}};
  await assert.rejects(handleExpenseText(h.env,event,'trace'));h.DB.failAfterCommit=false;
  assert.equal(await handleExpenseText(h.env,event,'trace'),'WAITING_CONFIRM');
  const row=h.sqlite.prepare("SELECT expense_id FROM expense_events WHERE message_id='lost-source'").get();
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM expense_audit_log WHERE expense_id=? AND action='CREATE_DRAFT'").get(row.expense_id).n,1);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM expense_events WHERE message_id='lost-source'").get().n,1);
 }finally{h.close();}
});
test('scope drift after source batch is uncertain and retains its single audit',async()=>{
 const h=expenseSqlite(),{handleExpenseText}=createRequire(import.meta.url)('../dist/expense/service.js');try{
  h.sqlite.exec("DROP TRIGGER serial_source_provenance_not_ready; INSERT INTO serial_source_provenance_activation VALUES(1,'book','"+namespace+"','now')");
  Object.assign(h.env,{SERIAL_SOURCE_PROVENANCE_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book'});const batch=h.DB.batch.bind(h.DB);
  h.DB.batch=async statements=>{const result=await batch(statements);h.env.GOOGLE_SPREADSHEET_ID='other';return result;};
  const event={source:{type:'user',userId:'synthetic'},message:{id:'drift-source',type:'text',text:'ค่าไฟ transfer 1200'}};
  await assert.rejects(handleExpenseText(h.env,event,'trace'),/SERIAL_SOURCE_PROVENANCE_UNCERTAIN/);
  const row=h.sqlite.prepare("SELECT expense_id FROM expense_events WHERE message_id='drift-source'").get();
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM expense_audit_log WHERE expense_id=? AND action='CREATE_DRAFT'").get(row.expense_id).n,1);
 }finally{h.close();}
});
test('synthetic source birth is immutable and cannot be backfilled or replaced',()=>{const db=setup();try{
 db.exec("INSERT INTO expense_events(expense_id,message_id,status,version) VALUES('legacy','msg','WAITING_CONFIRM',1); DROP TRIGGER serial_source_provenance_not_ready");
 db.prepare("INSERT INTO serial_source_provenance_activation VALUES(1,'book',?,'now')").run(namespace);
 assert.throws(()=>db.prepare("INSERT INTO expense_events(expense_id,message_id,status,version) VALUES(?,?,'WAITING_CONFIRM',1)").run(id,'untagged'));
 assert.throws(()=>db.prepare("INSERT OR REPLACE INTO expense_events VALUES(?,?,'WAITING_CONFIRM',1,?)").run(id,'msg',namespace));
 assert.throws(()=>db.prepare("INSERT INTO expense_events(rowid,expense_id,message_id,status,version,serial_source_namespace) VALUES(1,?,?,'WAITING_CONFIRM',1,?)").run(id,'collision',namespace));
 assert.throws(()=>db.prepare("INSERT INTO expense_events VALUES(?,?,'WAITING_CONFIRM',1,?)").run(`exp_${namespace}_${'x'.repeat(36)}`,'bad',namespace));
 db.prepare("INSERT INTO expense_events VALUES(?,?,'WAITING_CONFIRM',1,?)").run(id,'tagged',namespace);
 assert.throws(()=>db.prepare("UPDATE expense_events SET serial_source_namespace=? WHERE expense_id='legacy'").run(namespace));
 assert.throws(()=>db.prepare('DELETE FROM expense_events WHERE expense_id=?').run(id));
 assert.throws(()=>db.prepare("INSERT OR REPLACE INTO expense_events(expense_id,message_id,status,version) VALUES(?,?,'WAITING_CONFIRM',1)").run(id,'replacement'));
 assert.throws(()=>db.prepare("UPDATE expense_events SET expense_id='changed' WHERE expense_id=?").run(id));
 db.prepare("UPDATE expense_events SET status='CONFIRMED' WHERE expense_id=?").run(id);
 assert.equal(db.prepare('SELECT serial_source_namespace FROM expense_events WHERE expense_id=?').get(id).serial_source_namespace,namespace);
}finally{db.close();}});
