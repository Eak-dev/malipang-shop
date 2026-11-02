import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {readRawSourceProof,rawSourceStillMatches,rawProjectionValuesMatch}=require('../dist/sheets/raw-source-proof.js');
const {buildExpenseRawSheetValues,buildPersonalUseRawSheetValues}=require('../dist/sheets/sync.js');
const {digestLedgerCell}=require('../dist/sheets/ledger-stable-journal.js');
const {inspectRawRecovery}=require('../dist/sheets/raw-recovery-inspection.js');
class Statement{constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}bind(...args){this.args=args;return this}async first(){return this.db.prepare(this.sql).get(...this.args)??null}}
class D1{constructor(db){this.db=db}prepare(sql){return new Statement(this.db,sql)}}
function fixture(){
  const db=new DatabaseSync(':memory:');for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^\d+.*\.sql$/.test(x)).sort())db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,updated_at,version,trace_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('exp_fixture','msg','line','fixture',10000,'transfer','SHOP_BANK','ingredients','2026-10-01','CONFIRMED','then','now',2,'trace-a');
  db.prepare(`INSERT INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,created_at,updated_at,version,trace_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('personal_fixture','msg2','line','PERSONAL_USE','fixture',11000,'SHOP_BANK','2026-10-01','CONFIRMED','then','now',2,'trace-a');
  return{db,env:{DB:new D1(db)},close(){db.close()}};
}
function addDocument(db,id,expense='exp_fixture'){
  db.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,updated_at,expense_id,vendor_name,document_number,order_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(id,`msg_${id}`,'line','INVOICE','CONFIRMED','then','now',expense,'Vendor','INV-1','ORD-1');
}
test('RAW proof reuses full existing expense projection and detects every projected field',async()=>{
  const f=fixture();try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),source=f.db.prepare('SELECT * FROM expense_events WHERE expense_id=?').get('exp_fixture');
    assert.deepEqual(proof.values,buildExpenseRawSheetValues(source,null).map(x=>x??null));assert.equal(await rawSourceStillMatches(f.env,proof),true);
    const cells=proof.values.map(entered=>({entered,formula:null,note:null,hasValidation:false}));assert.equal(rawProjectionValuesMatch(proof,cells),true);
    cells[8].entered='different';assert.equal(rawProjectionValuesMatch(proof,cells),false);cells[8].entered=proof.values[8];cells[2].formula='="fixture"';assert.equal(rawProjectionValuesMatch(proof,cells),false);
    assert.equal(await rawSourceStillMatches(f.env,{...proof,values:proof.values.map((v,i)=>i===2?'tampered':v)}),false);
    f.db.prepare(`UPDATE expense_events SET trace_id='trace-b' WHERE expense_id='exp_fixture'`).run();assert.equal(await rawSourceStillMatches(f.env,proof),false);
    f.db.prepare(`UPDATE expense_events SET trace_id='trace-a',version=3 WHERE expense_id='exp_fixture'`).run();assert.equal(await rawSourceStillMatches(f.env,proof),false);
  }finally{f.close();}
});
test('document projection and provenance changes invalidate an unchanged expense version',async()=>{
  const f=fixture();try{
    addDocument(f.db,'doc1');
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2);assert.equal(proof.values[12],'doc1');assert.equal(proof.values[14],'Vendor');
    f.db.prepare(`UPDATE expense_documents SET vendor_name='Other' WHERE document_id='doc1'`).run();assert.equal(await rawSourceStillMatches(f.env,proof),false);
    f.db.prepare(`UPDATE expense_documents SET vendor_name='Vendor' WHERE document_id='doc1'`).run();addDocument(f.db,'doc2');assert.equal(await rawSourceStillMatches(f.env,proof),false);
    await assert.rejects(readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),/DOCUMENT_AMBIGUOUS/);
  }finally{f.close();}
});
test('one primary document is stable; changed fields or a second primary hold',async()=>{
  const f=fixture();try{
    addDocument(f.db,'doc1');addDocument(f.db,'doc2');
    const link=f.db.prepare(`INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES(?,?,?,?,?,?)`);
    link.run('link1','exp_fixture','doc1','PRIMARY_PURCHASE_DOCUMENT','MANUAL','then');
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2);assert.equal(proof.values[12],'doc1');
    f.db.prepare(`UPDATE expense_documents SET document_number='INV-2' WHERE document_id='doc1'`).run();assert.equal(await rawSourceStillMatches(f.env,proof),false);
    f.db.prepare(`UPDATE expense_documents SET document_number='INV-1' WHERE document_id='doc1'`).run();link.run('link2','exp_fixture','doc2','PRIMARY_PURCHASE_DOCUMENT','MANUAL','then');
    assert.equal(await rawSourceStillMatches(f.env,proof),false);await assert.rejects(readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),/DOCUMENT_AMBIGUOUS/);
  }finally{f.close();}
});
test('postimage treats a cleared empty string as blank and rejects mismatched null or formulas',async()=>{
  const f=fixture();try{
    f.db.prepare(`UPDATE expense_events SET trace_id='' WHERE expense_id='exp_fixture'`).run();
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),cells=proof.values.map(entered=>({entered,formula:null,note:null,hasValidation:false}));
    cells[9].entered=null;assert.equal(rawProjectionValuesMatch(proof,cells),true);
    const nullIndex=proof.values.findIndex(v=>v===null);assert.ok(nullIndex>=0);cells[nullIndex].entered='';assert.equal(rawProjectionValuesMatch(proof,cells),false);
    cells[nullIndex].entered=null;cells[9].formula='=""';assert.equal(rawProjectionValuesMatch(proof,cells),false);
  }finally{f.close();}
});
test('personal-use proof covers full 15 columns including metadata and timestamps',async()=>{
  const f=fixture();try{
    const proof=await readRawSourceProof(f.env,'PERSONAL_USE','personal_fixture',2),source=f.db.prepare('SELECT * FROM owner_personal_transactions WHERE personal_use_id=?').get('personal_fixture');
    assert.deepEqual(proof.values,buildPersonalUseRawSheetValues(source).map(x=>x??null));assert.equal(await rawSourceStillMatches(f.env,proof),true);
    f.db.prepare(`UPDATE owner_personal_transactions SET trace_id='trace-b' WHERE personal_use_id='personal_fixture'`).run();assert.equal(await rawSourceStillMatches(f.env,proof),false);
  }finally{f.close();}
});
test('wrong identity, missing source, status and version do not authorize writes',async()=>{
  const f=fixture();try{
    await assert.rejects(readRawSourceProof(f.env,'EXPENSE','other',2),/PROOF_INVALID/);
    await assert.rejects(readRawSourceProof(f.env,'EXPENSE','exp_missing',2),/SOURCE_UNAVAILABLE/);
    await assert.rejects(readRawSourceProof(f.env,'EXPENSE','exp_fixture',3),/VERSION_OR_STATUS/);
  }finally{f.close();}
});
test('ambiguous-write inspection never authorizes retry or releases REVIEW',async()=>{
  const f=fixture();try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),identity={kind:'EXPENSE',sheetId:7,entityId:proof.entityId},witness={metadataId:44,metadataKey:'E',sheetId:7,dimension:'ROWS',startIndex:1,endIndex:2,visibility:'DOCUMENT'};
    const rows=[['Expense_ID'],[proof.entityId]],cells=proof.values.map(entered=>({entered,formula:null,note:null,hasValidation:false}));
    const oldValues=proof.values.map((v,i)=>i===2?'old description':v),baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(oldValues[i]);
    const inspect=()=>inspectRawRecovery(f.env,proof,identity,witness,44,rows,cells,baseline);
    assert.deepEqual(await inspect(),{status:'REVIEW',observation:'MATCHES_DESIRED'});
    cells[2].entered='old description';assert.deepEqual(await inspect(),{status:'REVIEW',observation:'MATCHES_BASELINE'});
    cells[3].entered=999;assert.deepEqual(await inspect(),{status:'REVIEW',observation:'DIFFERS'});
    cells[3].note='manual';assert.deepEqual(await inspect(),{status:'REVIEW',observation:'UNAVAILABLE'});cells[3].note=null;
    rows.push([proof.entityId]);assert.deepEqual(await inspect(),{status:'REVIEW',observation:'UNAVAILABLE'});rows.pop();
    cells[0].entered='different';assert.deepEqual(await inspect(),{status:'REVIEW',observation:'UNAVAILABLE'});cells[0].entered=proof.entityId;
    assert.deepEqual(await inspectRawRecovery(f.env,proof,identity,witness,45,rows,cells,baseline),{status:'REVIEW',observation:'UNAVAILABLE'});
    f.db.prepare(`UPDATE expense_events SET trace_id='changed' WHERE expense_id='exp_fixture'`).run();assert.deepEqual(await inspect(),{status:'REVIEW',observation:'SOURCE_CHANGED_OR_UNAVAILABLE'});
  }finally{f.close();}
});
