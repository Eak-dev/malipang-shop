import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {readDetailSourceProof,detailSourceStillMatches}=require('../dist/sheets/detail-source-proof.js');
class Statement{constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}bind(...args){this.args=args;return this}async first(){return this.db.prepare(this.sql).get(...this.args)??null}}
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^\d+.*\.sql$/.test(x)).sort())db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('exp_fixture','msg','line','purchase',10000,'transfer','SHOP_BANK','ingredients','2026-10-01','CONFIRMED','then','now',1);
  db.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,updated_at,expense_id,vendor_name,document_number) VALUES(?,?,?,?,?,?,?,?,?,?)`).run('doc1','docmsg','line','INVOICE','CONFIRMED','then','now','exp_fixture','Vendor','INV1');
  db.prepare(`INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES(?,?,?,?,?,?)`).run('link1','exp_fixture','doc1','PRIMARY_PURCHASE_DOCUMENT','MANUAL','then');
  db.prepare(`INSERT INTO expense_document_items(item_id,document_id,expense_id,description,quantity,line_total_satang,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run('item1','doc1','exp_fixture','first',1,4000,'a','now');
  db.prepare(`INSERT INTO expense_document_items(item_id,document_id,expense_id,description,quantity,line_total_satang,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`).run('item2','doc1','exp_fixture','second',2,5000,'b','now');
  return {db,env:{DB:{prepare:sql=>new Statement(db,sql)}},revision:()=>db.prepare("SELECT revision FROM expense_projection_source_revisions WHERE expense_id='exp_fixture'").get().revision,close:()=>db.close()};
}
test('detail source inventories all items in business order and detects same-total sibling changes',async()=>{const h=fixture();try{
  const proof=await readDetailSourceProof(h.env,'exp_fixture',1,h.revision());assert.deepEqual(proof.entries.map(x=>x.itemId),['item1','item2']);assert.equal(proof.entries[0].values[12],10);assert.equal(proof.entries[1].values[12],'');assert.equal(proof.entries[0].values[17],'D1:doc1');assert.equal(await detailSourceStillMatches(h.env,proof),true);
  h.db.prepare("UPDATE expense_document_items SET description='changed' WHERE item_id='item2'").run();assert.equal(await detailSourceStillMatches(h.env,proof),false);await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,proof.revision),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
}finally{h.close()}});
test('ambiguous documents, unowned siblings and missing line totals cannot form a source proof',async()=>{const h=fixture();try{
  h.db.prepare("UPDATE expense_document_items SET line_total_satang=NULL WHERE item_id='item2'").run();await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
  h.db.prepare("UPDATE expense_document_items SET line_total_satang=5000,expense_id=NULL WHERE item_id='item2'").run();await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
  h.db.prepare("UPDATE expense_document_items SET expense_id='exp_fixture' WHERE item_id='item2'").run();
  h.db.prepare("INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,expense_id) VALUES('doc2','other','line','INVOICE','CONFIRMED','then','exp_fixture')").run();
  h.db.prepare("INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES('link2','exp_fixture','doc2','PRIMARY_PURCHASE_DOCUMENT','MANUAL','then')").run();await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
}finally{h.close()}});
test('changed source, cancellation, absent source guard and malformed item hold',async()=>{const h=fixture();try{
  await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',2,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
  h.db.prepare("UPDATE expense_document_items SET description=' ' WHERE item_id='item1'").run();await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
  h.db.prepare("UPDATE expense_document_items SET description='first' WHERE item_id='item1'").run();h.db.exec('DROP TRIGGER expense_projection_item_update');await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
}finally{h.close()}});
test('oversized fields are rejected inside the SQL before they are returned',async()=>{const h=fixture();try{
  h.db.prepare("UPDATE expense_document_items SET description=? WHERE item_id='item1'").run('x'.repeat(2000));
  await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
}finally{h.close()}});
test('an empty source inventory is a snapshot, while orphan items and cancelled expense are held',async()=>{const h=fixture();try{
  h.db.prepare('DELETE FROM expense_document_items').run();h.db.prepare('DELETE FROM expense_document_links').run();
  const p=await readDetailSourceProof(h.env,'exp_fixture',1,h.revision());assert.deepEqual(p.entries,[]);
  h.db.prepare("INSERT INTO expense_document_items(item_id,document_id,expense_id,description,line_total_satang,created_at,updated_at) VALUES('orphan','doc1','exp_fixture','item',100,'now','now')").run();
  await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
  h.db.prepare("UPDATE expense_events SET status='CANCELLED' WHERE expense_id='exp_fixture'").run();await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
}finally{h.close()}});
test('more than the inventory limit is held rather than silently truncated',async()=>{const h=fixture();try{
  const stmt=h.db.prepare('INSERT INTO expense_document_items(item_id,document_id,expense_id,description,line_total_satang,created_at,updated_at) VALUES(?,?,?,?,?,?,?)');
  for(let i=0;i<499;i++)stmt.run(`extra_${i}`,'doc1','exp_fixture','item',1,'later','now');
  await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
}finally{h.close()}});
test('invalid dates and driver errors are held without leaking private input',async()=>{const h=fixture();try{
  h.db.prepare("UPDATE expense_events SET transaction_date='2026-02-30' WHERE expense_id='exp_fixture'").run();
  await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
  h.db.prepare("UPDATE expense_events SET transaction_date='2026-10-01' WHERE expense_id='exp_fixture'").run();
  h.db.prepare("UPDATE expense_documents SET document_date='2026-13-01' WHERE document_id='doc1'").run();
  await assert.rejects(readDetailSourceProof(h.env,'exp_fixture',1,h.revision()),/DETAIL_SOURCE_UNAVAILABLE_OR_INVALID/);
  const env={DB:{prepare(){throw Error('SECRET_PRIVATE_SENTINEL')}}};
  await assert.rejects(readDetailSourceProof(env,'exp_fixture',1,1),e=>e.message==='DETAIL_SOURCE_UNAVAILABLE_OR_INVALID'&&!String(e).includes('SECRET_PRIVATE_SENTINEL'));
}finally{h.close()}});
