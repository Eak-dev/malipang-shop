import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../migrations-draft/0072_serial_attested_handoff_draft.sql',import.meta.url),'utf8');
test('oracle fence and attested edge remain disabled and immutable in the local model',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(sql);const fence=()=>db.prepare("INSERT INTO serial_pilot_oracle_fence VALUES('book',?,1,'now')").run('a'.repeat(64));
  const edge=(nonce,b='b',c='c')=>db.prepare("INSERT INTO serial_pilot_attested_handoffs VALUES(?, 'round', ?, ?, 'book', 'epoch-b', 'epoch-c', 'claim', 'worker', 1, ?, 1, 'issued', 'expires', ?, ?, ?, 'now')").run(nonce,b,c,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64),'d'.repeat(64));
  assert.throws(fence);assert.throws(()=>edge('nonce'));db.exec('DROP TRIGGER serial_pilot_oracle_fence_not_ready; DROP TRIGGER serial_pilot_attested_handoff_not_ready');
  fence();edge('nonce');assert.throws(()=>edge('nonce'));assert.throws(()=>edge('other','b','other'));assert.throws(()=>edge('other','other','c'));
  assert.throws(()=>db.exec('UPDATE serial_pilot_oracle_fence SET generation=2'));assert.throws(()=>db.exec('DELETE FROM serial_pilot_oracle_fence'));
  assert.throws(()=>db.exec('UPDATE serial_pilot_attested_handoffs SET expires_at=\'changed\''));assert.throws(()=>db.exec('DELETE FROM serial_pilot_attested_handoffs'));
 }finally{db.close();}
});

test('mock notice release receipt is blocked by default and immutable',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(readFileSync(new URL('../migrations-draft/0073_serial_notice_release_draft.sql',import.meta.url),'utf8'));
  const add=(token,nonce)=>db.prepare("INSERT INTO serial_pilot_notice_release_receipts VALUES(?, 'book','round','b','c','epoch',?,'worker',1,?,1,'expires','SHA256_MALIPANG_NOTICE_POSTIMAGE_V1',?,'observed','released')").run(token,nonce,'a'.repeat(64),'b'.repeat(64));
  assert.throws(()=>add('token','nonce'));db.exec('DROP TRIGGER serial_pilot_notice_release_not_ready');add('token','nonce');
  assert.throws(()=>add('token','other'));assert.throws(()=>add('other','nonce'));
  assert.throws(()=>db.exec("UPDATE serial_pilot_notice_release_receipts SET observed_at='other'"));assert.throws(()=>db.exec('DELETE FROM serial_pilot_notice_release_receipts'));
 }finally{db.close();}
});

test('mock revocation is disabled by default and retained once recorded',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(sql);db.exec(readFileSync(new URL('../migrations-draft/0073_serial_notice_release_draft.sql',import.meta.url),'utf8'));
  db.exec('DROP TRIGGER serial_pilot_oracle_fence_not_ready');
  db.prepare("INSERT INTO serial_pilot_oracle_fence VALUES('book',?,1,'now')").run('a'.repeat(64));
  const revoke=()=>db.prepare("INSERT INTO serial_pilot_oracle_revocations VALUES('book',?,1,'now')").run('a'.repeat(64));
  assert.throws(revoke);db.exec('DROP TRIGGER serial_pilot_oracle_revoke_not_ready');revoke();assert.throws(revoke);
  db.prepare("INSERT INTO serial_pilot_oracle_fence VALUES('other',?,1,'now')").run('b'.repeat(64));
  assert.throws(()=>db.prepare("INSERT OR REPLACE INTO serial_pilot_oracle_revocations(rowid,spreadsheet_id,fence_digest,fence_generation,revoked_at) VALUES(1,'other',?,1,'now')").run('b'.repeat(64)));
  assert.equal(db.prepare("SELECT count(*) n FROM serial_pilot_oracle_revocations WHERE spreadsheet_id='book'").get().n,1);
  assert.throws(()=>db.exec("UPDATE serial_pilot_oracle_revocations SET revoked_at='other'"));assert.throws(()=>db.exec('DELETE FROM serial_pilot_oracle_revocations'));
 }finally{db.close();}
});

test('ledger receipts default closed and retain unique operation and item evidence',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(readFileSync(new URL('../migrations-draft/0075_serial_ledger_receipt_draft.sql',import.meta.url),'utf8'));
  const add=(token,entity,projection)=>db.prepare("INSERT INTO serial_pilot_ledger_stage_receipts VALUES(?,'epoch','book','job',?,?,1,'source',1,2,'sheet','before','payload','marker','worker','nonce','SHA256_MALIPANG_NOTICE_POSTIMAGE_V1',?,'observed','recorded')").run(token,entity,projection,'a'.repeat(64));
  assert.throws(()=>add('first','job','EXPENSE_RAW'));db.exec('DROP TRIGGER serial_ledger_stage_not_ready');add('first','job','EXPENSE_RAW');
  assert.throws(()=>add('first','job|one','DETAIL'));assert.throws(()=>add('second','job','EXPENSE_RAW'));
  add('second','job|one','DETAIL');assert.throws(()=>db.exec("UPDATE serial_pilot_ledger_stage_receipts SET entity_id='other'"));assert.throws(()=>db.exec('DELETE FROM serial_pilot_ledger_stage_receipts'));
 }finally{db.close();}
});

test('final receipts remain disabled and immutable in the local model',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(readFileSync(new URL('../migrations-draft/0076_serial_final_receipt_draft.sql',import.meta.url),'utf8'));
  const add=(token,epoch)=>db.prepare("INSERT INTO serial_pilot_final_receipts VALUES(?,?,'book','job','nonce','worker',1,'source','SHA256_MALIPANG_PROJECTION_SNAPSHOT_V1',?,'SHA256_MALIPANG_NOTICE_POSTIMAGE_V1',?,'provider','notice','recorded')").run(token,epoch,'a'.repeat(64),'b'.repeat(64));
  assert.throws(()=>add('first','epoch'));db.exec('DROP TRIGGER serial_final_receipt_not_ready');add('first','epoch');
  assert.throws(()=>add('first','other'));assert.throws(()=>add('other','epoch'));
  assert.throws(()=>db.exec("UPDATE serial_pilot_final_receipts SET notice_digest='other'"));assert.throws(()=>db.exec('DELETE FROM serial_pilot_final_receipts'));
 }finally{db.close();}
});
