import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';

test('daily category migration is retryable and allows only one pending request per expense',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE expense_events(expense_id TEXT PRIMARY KEY); CREATE TABLE employees(employee_id TEXT PRIMARY KEY);');
  const sql=readFileSync(new URL('../migrations/0021_daily_category_review.sql',import.meta.url),'utf8');
  db.exec(sql);db.exec(sql);
  db.exec("INSERT INTO expense_events VALUES('exp-test')");
  const insert=db.prepare('INSERT INTO daily_category_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
  insert.run('one','exp-test',10,1,'general','transport',1,'fingerprint','PENDING','now','now',null,null);
  assert.throws(()=>insert.run('two','exp-test',10,1,'general','rent',1,'fingerprint','PENDING','now','now',null,null));
  db.exec("UPDATE daily_category_requests SET status='STALE' WHERE request_id='one'");
  insert.run('two','exp-test',10,1,'general','rent',1,'fingerprint','PENDING','now','now',null,null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM daily_category_requests WHERE status='PENDING'").get().n,1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  db.close();
});
