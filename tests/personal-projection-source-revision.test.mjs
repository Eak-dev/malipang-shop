import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const migration=readFileSync(new URL('../migrations/0035_personal_projection_source_revision.sql',import.meta.url),'utf8');
function setup(apply=true){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=OFF');
  for(const n of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^\d+.*\.sql$/.test(x)&&Number(x.slice(0,4))<35).sort())db.exec(readFileSync(new URL(`../migrations/${n}`,import.meta.url),'utf8'));
  insert(db,'personal_a','msg_a');insert(db,'personal_b','msg_b');if(apply)db.exec(migration);return db;
}
function insert(db,id,message,rowid){
  const fields=`personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,created_at,updated_at,version`;
  const values=[id,message,'line','PERSONAL_USE','fixture',10000,'SHOP_BANK','2026-10-01','CONFIRMED','then','now',1];
  if(rowid===undefined)db.prepare(`INSERT INTO owner_personal_transactions(${fields}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(...values);
  else db.prepare(`INSERT INTO owner_personal_transactions(rowid,${fields}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(rowid,...values);
}
const revision=(db,id)=>db.prepare('SELECT revision,state FROM personal_projection_source_revisions WHERE personal_use_id=?').get(id);
const business=db=>db.prepare(`SELECT rowid,personal_use_id,message_id,description,version FROM owner_personal_transactions ORDER BY personal_use_id`).all().map(x=>({...x}));
test('Wrangler splitter preserves all personal revision triggers and nested CASE',()=>{
  const {unstable_splitSqlQuery}=createRequire(import.meta.url)('wrangler'),statements=unstable_splitSqlQuery(migration),triggers=statements.filter(s=>/^CREATE TRIGGER\b/i.test(s));
  assert.equal(triggers.length,5);for(const trigger of triggers)assert.match(trigger,/\bEND\s*$/);assert.equal(statements.filter(s=>/^END$/i.test(s)).length,0);
});
test('bootstrap is idempotent and missing evidence is never silently recreated as tracked',()=>{
  const db=setup();try{
    assert.deepEqual({...revision(db,'personal_a')},{revision:1,state:'TRACKED'});assert.equal(db.prepare('SELECT count(*) n FROM personal_projection_admissions').get().n,2);
    db.exec(`DELETE FROM personal_projection_source_revisions WHERE personal_use_id='personal_a'`);db.exec(migration);assert.equal(revision(db,'personal_a'),undefined);
    db.exec(`UPDATE owner_personal_transactions SET description='changed' WHERE personal_use_id='personal_a'`);assert.deepEqual({...revision(db,'personal_a')},{revision:1,state:'REVIEW'});
  }finally{db.close();}
});
test('edit and revert change the monotonic revision even without a version bump',()=>{
  const db=setup();try{
    db.exec(`UPDATE owner_personal_transactions SET description='changed' WHERE personal_use_id='personal_a'; UPDATE owner_personal_transactions SET description='fixture' WHERE personal_use_id='personal_a'`);
    assert.deepEqual({...revision(db,'personal_a')},{revision:3,state:'TRACKED'});assert.equal(db.prepare(`SELECT version FROM owner_personal_transactions WHERE personal_use_id='personal_a'`).get().version,1);
  }finally{db.close();}
});
test('delete/reinsert of an identity retains admission and forces REVIEW',()=>{
  const db=setup();try{
    const seq=db.prepare(`SELECT sequence FROM personal_projection_admissions WHERE personal_use_id='personal_a'`).get().sequence;
    db.exec(`DELETE FROM owner_personal_transactions WHERE personal_use_id='personal_a'`);insert(db,'personal_a','msg_new');
    assert.equal(revision(db,'personal_a').state,'REVIEW');assert.equal(db.prepare(`SELECT sequence FROM personal_projection_admissions WHERE personal_use_id='personal_a'`).get().sequence,seq);
  }finally{db.close();}
});
test('REPLACE conflicts preserve ordinary business outcomes and invalidate displaced identities',()=>{
  const scenarios=[
    db=>db.prepare(`INSERT OR REPLACE INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,created_at,updated_at,version) VALUES('personal_c','msg_a','line','PERSONAL_USE','replacement',10000,'SHOP_BANK','2026-10-01','CONFIRMED','then','now',1)`).run(),
    db=>db.exec(`UPDATE OR REPLACE owner_personal_transactions SET message_id='msg_a' WHERE personal_use_id='personal_b'`),
    db=>db.exec(`UPDATE OR REPLACE owner_personal_transactions SET personal_use_id='personal_a' WHERE personal_use_id='personal_b'`),
    db=>db.exec(`UPDATE OR REPLACE owner_personal_transactions SET rowid=(SELECT rowid FROM owner_personal_transactions WHERE personal_use_id='personal_a') WHERE personal_use_id='personal_b'`),
    db=>{const rid=db.prepare(`SELECT rowid FROM owner_personal_transactions WHERE personal_use_id='personal_a'`).get().rowid;db.prepare(`INSERT OR REPLACE INTO owner_personal_transactions(rowid,personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,created_at,updated_at,version) VALUES(?,'personal_c','msg_c','line','PERSONAL_USE','replacement',10000,'SHOP_BANK','2026-10-01','CONFIRMED','then','now',1)`).run(rid);}
  ];
  for(const op of scenarios){const plain=setup(false),tracked=setup();try{
    let a='ok',b='ok';try{op(plain)}catch(e){a=e.code||e.message}try{op(tracked)}catch(e){b=e.code||e.message}
    assert.equal(b,a);assert.deepEqual(business(tracked),business(plain));if(b==='ok')assert.ok(revision(tracked,'personal_a').revision>1);
  }finally{plain.close();tracked.close();}}
});
test('automatic rowid with existing minus one is conservative without changing business rows',()=>{
  const plain=setup(false),tracked=setup();try{
    insert(plain,'personal_negative','msg_negative',-1);insert(tracked,'personal_negative','msg_negative',-1);
    insert(plain,'personal_new','msg_new');insert(tracked,'personal_new','msg_new');
    assert.deepEqual(business(tracked),business(plain));assert.equal(revision(tracked,'personal_new').state,'REVIEW');assert.ok(revision(tracked,'personal_negative').revision>1);
  }finally{plain.close();tracked.close();}
});
test('ignored collision may increase revision but cannot change the business row',()=>{
  const db=setup();try{
    const before=business(db);db.exec(`INSERT OR IGNORE INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,created_at,updated_at,version) VALUES('personal_a','msg_a','line','PERSONAL_USE','ignored',10000,'SHOP_BANK','2026-10-01','CONFIRMED','then','now',1)`);
    assert.deepEqual(business(db),before);assert.ok(revision(db,'personal_a').revision>1);
  }finally{db.close();}
});
test('foreign-key NO ACTION failures roll back both business rows and revisions',()=>{
  const scenarios=[
    db=>db.exec(`DELETE FROM owner_personal_transactions WHERE personal_use_id='personal_a'`),
    db=>db.exec(`UPDATE OR REPLACE owner_personal_transactions SET message_id='msg_a' WHERE personal_use_id='personal_b'`),
    db=>db.exec(`INSERT OR REPLACE INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,created_at,updated_at,version) VALUES('personal_c','msg_a','line','PERSONAL_USE','replacement',10000,'SHOP_BANK','2026-10-01','CONFIRMED','then','now',1)`)
  ];
  for(const op of scenarios){const plain=setup(false),tracked=setup();try{
    for(const db of [plain,tracked])db.exec(`INSERT INTO owner_personal_transaction_audit(audit_id,personal_use_id,actor_employee_id,action,before_json,after_json,created_at) VALUES('audit','personal_a','actor','CREATE_DRAFT','{}','{}','now')`);
    const before=business(tracked),ra={...revision(tracked,'personal_a')},rb={...revision(tracked,'personal_b')};let a='ok',b='ok';try{op(plain)}catch(e){a=e.code||e.message}try{op(tracked)}catch(e){b=e.code||e.message}
    assert.notEqual(a,'ok');assert.equal(b,a);assert.deepEqual(business(tracked),before);assert.deepEqual(business(tracked),business(plain));assert.deepEqual({...revision(tracked,'personal_a')},ra);assert.deepEqual({...revision(tracked,'personal_b')},rb);
  }finally{plain.close();tracked.close();}}
});
test('exhausted revision aborts the business write instead of losing change evidence',()=>{
  const db=setup();try{
    db.exec(`UPDATE personal_projection_source_revisions SET revision=9007199254740991 WHERE personal_use_id='personal_a'`);
    assert.throws(()=>db.exec(`UPDATE owner_personal_transactions SET description='changed' WHERE personal_use_id='personal_a'`));
    assert.equal(db.prepare(`SELECT description FROM owner_personal_transactions WHERE personal_use_id='personal_a'`).get().description,'fixture');
  }finally{db.close();}
});
