import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';

const directory=new URL('../migrations/',import.meta.url);
const migration=readFileSync(new URL('0019_expense_linked_receipt_identity.sql',directory),'utf8');
const oldIndex=`CREATE UNIQUE INDEX idx_expense_document_invoice_duplicate ON expense_documents(legal_vendor_name,document_number) WHERE legal_vendor_name IS NOT NULL AND legal_vendor_name<>'' AND document_number IS NOT NULL AND document_number<>''`;
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  for(const name of readdirSync(directory).filter(name=>name.endsWith('.sql')&&name<'0019').sort())db.exec(readFileSync(new URL(name,directory),'utf8'));
  db.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at) VALUES('exp_fixture','event_fixture','fixture_actor','Synthetic',100,'cash','SHOP_BANK','general','2026-01-01','CONFIRMED','2026-01-01T00:00:00Z')`).run();
  function document(id,{expenseId='exp_fixture',referenceKey=null,orderId='ORDER-FIXTURE',number='INV-FIXTURE'}={}){
    db.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,expense_id,reference_key,order_id,legal_vendor_name,document_number,normalized_json) VALUES(?,?, 'fixture_actor','RECEIPT','WAITING_REVIEW','2026-01-01T00:00:00Z',?,?,?,?,?,'{"original":"immutable fixture"}')`)
      .run(id,`message_${id}`,expenseId,referenceKey,orderId,'Synthetic Legal Supplier',number);
  }
  document('primary');document('legacy_review',{expenseId:null,number:'INV-REVIEW'});
  const snapshot=()=>JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({name})=>[name,db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
  const integrity=()=>{assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);};
  return{db,document,snapshot,integrity,close(){integrity();db.close();}};
}

test('0019 applies and repeats without rewriting any business, evidence, audit or mapping row',()=>{
  const h=fixture();try{
    const before=h.snapshot();h.db.exec(migration);h.db.exec(migration);
    assert.equal(h.snapshot(),before);
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_expense_document_invoice_duplicate'").get().n,0);
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name='idx_expense_document_invoice_identity_v2'").get().n,1);
  }finally{h.close();}
});

test('0019 preserves old-code uniqueness for primary, review-only and unscoped documents',()=>{
  const h=fixture();try{
    h.db.exec(migration);
    for(const [index,values] of [
      {expenseId:'exp_fixture'},
      {expenseId:null},
      {expenseId:null,referenceKey:'ordinary_reference'},
      {expenseId:'exp_fixture',referenceKey:'receipt:linked:v1:synthetic'},
      {expenseId:null,referenceKey:'receipt:linked:v1:synthetic',orderId:''},
      {expenseId:null,referenceKey:'receipt:linked:v1:synthetic',orderId:null},
      {expenseId:null,referenceKey:'receipt:linked:v1:synthetic',orderId:'   '}
    ].entries())assert.throws(()=>h.document(`blocked_${index}`,values),/UNIQUE/);
    assert.throws(()=>h.document('duplicate_review',{expenseId:null,number:'INV-REVIEW'}),/UNIQUE/);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM expense_documents').get().n,2);
  }finally{h.close();}
});

test('0019 allows only scoped non-payable linked evidence while retaining reference and image uniqueness',()=>{
  const h=fixture();try{
    h.db.exec(migration);h.document('linked',{expenseId:null,referenceKey:'receipt:linked:v1:synthetic'});
    assert.throws(()=>h.document('duplicate_key',{expenseId:null,referenceKey:'receipt:linked:v1:synthetic'}),/UNIQUE/);
    h.db.prepare("UPDATE expense_documents SET image_hash='fixture_hash' WHERE document_id='primary'").run();
    assert.throws(()=>h.db.prepare("UPDATE expense_documents SET image_hash='fixture_hash' WHERE document_id='linked'").run(),/UNIQUE/);
    assert.throws(()=>h.db.prepare("UPDATE expense_documents SET expense_id='exp_fixture' WHERE document_id='linked'").run(),/UNIQUE/);
    const linked=h.db.prepare("SELECT legal_vendor_name,document_number,expense_id FROM expense_documents WHERE document_id='linked'").get();
    assert.deepEqual({...linked},{legal_vendor_name:'Synthetic Legal Supplier',document_number:'INV-FIXTURE',expense_id:null});
  }finally{h.close();}
});

test('0019 is restart-safe after creating the new index but before dropping the old index',()=>{
  const h=fixture();try{
    const before=h.snapshot();h.db.exec(migration.split('DROP INDEX')[0]);
    assert.throws(()=>h.document('not_yet_enabled',{expenseId:null,referenceKey:'receipt:linked:v1:synthetic'}),/UNIQUE/);
    h.db.exec(migration);assert.equal(h.snapshot(),before);
    h.document('linked',{expenseId:null,referenceKey:'receipt:linked:v1:synthetic'});
  }finally{h.close();}
});

test('0019 schema rollback works before new evidence; afterward fail closed and retain the forward-compatible index',()=>{
  for(const hasLinkedEvidence of [false,true]){
    const h=fixture();try{
      h.db.exec(migration);
      if(hasLinkedEvidence)h.document('linked',{expenseId:null,referenceKey:'receipt:linked:v1:synthetic'});
      const before=h.snapshot();
      if(hasLinkedEvidence){
        assert.throws(()=>h.db.exec(oldIndex),/UNIQUE/);
        assert.equal(h.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='idx_expense_document_invoice_identity_v2'").get().n,1);
      }else{
        h.db.exec(`${oldIndex}; DROP INDEX idx_expense_document_invoice_identity_v2;`);
        assert.throws(()=>h.document('still_blocked',{expenseId:null,referenceKey:'receipt:linked:v1:synthetic'}),/UNIQUE/);
        h.db.exec(migration);
      }
      assert.equal(h.snapshot(),before);
    }finally{h.close();}
  }
});
