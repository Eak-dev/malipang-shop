import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readdirSync,readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);
const {LedgerStableJournal,digestLedgerCell,baselineMatches}=require('../dist/sheets/ledger-stable-journal.js');
const {projectExistingLedgerShadow}=require('../dist/sheets/ledger-stable-projector.js');
const auth=require('../dist/sheets/google-auth.js');
const {RAW_PROJECTION_HEADERS}=require('../dist/sheets/raw-projection.js');
const original={token:auth.getGoogleAccessToken,fetch:globalThis.fetch};
test.afterEach(()=>{auth.getGoogleAccessToken=original.token;globalThis.fetch=original.fetch});
const expenseFields=[1,2,3,4,5,6,7],personalFields=[1,2,3,4,5,6,13,14],detailFields=[2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,18,19];
const hashes=(fields,c='a')=>Object.fromEntries(fields.map(i=>[String(i),c.repeat(64)]));
class Statement{
  constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}bind(...args){this.args=args;return this}
  async first(){return this.db.prepare(this.sql).get(...this.args)??null}
  async run(){return{meta:{changes:Number(this.db.prepare(this.sql).run(...this.args).changes)}}}
}
class D1{constructor(db){this.db=db}prepare(sql){return new Statement(this.db,sql)}}
function fixture(){
  const db=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^\d+.*\.sql$/.test(x)).sort())db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.exec("CREATE TABLE ledger_stable_uat_guard(marker TEXT); INSERT INTO ledger_stable_uat_guard VALUES('synthetic');");
  const env={DB:new D1(db),RUNTIME_MODE:'shadow',GOOGLE_SPREADSHEET_ID:'uat',SHEETS_LEDGER_UAT_SPREADSHEET_ID:'uat',SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID:'production',SHEETS_LEDGER_UAT_DATABASE_MARKER:'synthetic',SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE:'true'};
  const expense={kind:'EXPENSE',id:'exp_fixture',version:2,status:'CONFIRMED',transactionDate:'2026-10-01',description:'fixture',amountSatang:10000,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'ingredients',updatedAt:'now'};
  db.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(expense.id,'msg','line',expense.description,expense.amountSatang,expense.paymentKey,expense.sourceWallet,expense.category,expense.transactionDate,expense.status,'then',expense.updatedAt,expense.version);
  const baseline=hashes(expenseFields);
  db.prepare(`INSERT INTO ledger_stable_identity_journal(spreadsheet_id,sheet_name,kind,scope,entity_key,metadata_id,state,source_version,projected_version,baseline_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'VERIFIED',?,?,?,?,?)`).run('uat','raw','EXPENSE','CORE',expense.id,42,1,1,JSON.stringify(baseline),'then','then');
  return{db,env,expense,baseline,close(){db.close()}};
}
const token='synthetic_token_123456';
test('digests are type-aware and verify every requested field',async()=>{
  const a=await digestLedgerCell(1),b=await digestLedgerCell('1');assert.notEqual(a,b);
  assert.equal(await baselineMatches({'2':a},{'2':1}),true);
  assert.equal(await baselineMatches({'2':a},{'2':'1'}),false);
  assert.equal(await baselineMatches({'2':a},{'2':1,'3':1}),false);
});
test('verified identity transitions exactly once and retains no row address',async()=>{
  const h=fixture();try{
    const j=new LedgerStableJournal(h.env,'raw',h.expense);
    assert.equal(await j.beginUpdate(42,1,h.baseline,token),true);
    assert.equal(await j.beginUpdate(42,1,h.baseline,'another_token_123456'),false);
    assert.equal(await j.finish(42,'wrong_token_123456',hashes(expenseFields,'c')),false);
    assert.equal(await j.finish(42,token,hashes(expenseFields,'c')),true);
    assert.deepEqual({...h.db.prepare(`SELECT state,projected_version,intent_token FROM ledger_stable_identity_journal`).get()},{state:'VERIFIED',projected_version:2,intent_token:null});
    assert.equal(h.db.prepare(`PRAGMA table_info(ledger_stable_identity_journal)`).all().some(x=>/row_number|row_index/.test(x.name)),false);
  }finally{h.close()}
});
test('stale baseline, changed source and unexpected versions fail closed',async()=>{
  const h=fixture();try{
    const j=new LedgerStableJournal(h.env,'raw',h.expense);
    assert.equal(await j.beginUpdate(42,1,hashes(expenseFields,'f'),token),false);
    h.db.prepare(`UPDATE expense_events SET description='changed without version bump'`).run();
    assert.equal(await j.beginUpdate(42,1,h.baseline,token),false);
    h.db.prepare(`UPDATE expense_events SET description='fixture'`).run();
    assert.equal(await j.beginUpdate(42,2,h.baseline,token),false);
    assert.equal(await j.beginUpdate(42,1,h.baseline,token),true);
    h.db.prepare(`UPDATE expense_events SET amount_satang=99999`).run();
    assert.equal(await j.finish(42,token,hashes(expenseFields,'c')),false);
    assert.equal(h.db.prepare(`SELECT state FROM ledger_stable_identity_journal`).get().state,'IN_FLIGHT');
  }finally{h.close()}
});
test('unknown outcomes stay REVIEW and cannot be reclaimed',async()=>{
  const h=fixture();try{
    const j=new LedgerStableJournal(h.env,'raw',h.expense);
    assert.equal(await j.beginUpdate(42,1,h.baseline,token),true);
    assert.equal(await j.hold(42,token),true);
    assert.equal(await j.finish(42,token,hashes(expenseFields,'c')),false);
    assert.equal(await j.beginUpdate(42,1,h.baseline,token),false);
  }finally{h.close()}
});
test('competing updates reserve only one intent',async()=>{
  const h=fixture();try{
    const j=new LedgerStableJournal(h.env,'raw',h.expense);
    const results=await Promise.all([j.beginUpdate(42,1,h.baseline,token),j.beginUpdate(42,1,h.baseline,'synthetic_token_abcdef')]);
    assert.deepEqual(results.sort(),[false,true]);
    assert.equal(h.db.prepare(`SELECT state FROM ledger_stable_identity_journal`).get().state,'IN_FLIGHT');
  }finally{h.close()}
});
test('no production access or unsafe baseline metadata',async()=>{
  const h=fixture();try{
    const j=new LedgerStableJournal({...h.env,RUNTIME_MODE:'production'},'raw',h.expense);
    await assert.rejects(j.beginUpdate(42,1,h.baseline,token),/DISABLED/);
    const shadow=new LedgerStableJournal(h.env,'raw',h.expense);
    await assert.rejects(shadow.beginUpdate(42,1,{'8':'message_id'},token),/BASELINE_INVALID/);
    await assert.rejects(shadow.beginUpdate(42,1,{'14':'a'.repeat(64)},token),/BASELINE_INVALID/);
    await assert.rejects(shadow.beginUpdate(42,1,{'01':'a'.repeat(64)},token),/BASELINE_INVALID/);
    h.db.exec('DROP TABLE ledger_stable_uat_guard');
    await assert.rejects(shadow.beginUpdate(42,1,h.baseline,token),/UAT_DATABASE_UNVERIFIED/);
  }finally{h.close()}
});
test('migration retries safely and metadata identity is unique across tabs',()=>{
  const h=fixture();try{
    const migration=readFileSync(new URL('../migrations/0025_ledger_stable_identity_journal.sql',import.meta.url),'utf8');h.db.exec(migration);
    assert.throws(()=>h.db.prepare(`INSERT INTO ledger_stable_identity_journal(spreadsheet_id,sheet_name,kind,scope,entity_key,metadata_id,state,source_version,projected_version,baseline_json,created_at,updated_at) VALUES('uat','other','PERSONAL_USE','CORE','personal_b',42,'VERIFIED',1,1,'{}','now','now')`).run(),/UNIQUE/);
    assert.equal(h.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{h.close()}
});
test('personal-use source is version and full-value guarded',async()=>{
  const h=fixture();try{
    const p={kind:'PERSONAL_USE',id:'personal_fixture',version:2,status:'CONFIRMED',transactionDate:'2026-10-02',description:'private',amountSatang:12300,transactionType:'PERSONAL_USE',sourceWallet:'SHOP_BANK',updatedAt:'now'};
    h.db.prepare(`INSERT INTO owner_personal_transactions(personal_use_id,message_id,line_user_id,transaction_type,description,amount_satang,source_wallet,transaction_date,status,created_at,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(p.id,'msg2','line',p.transactionType,p.description,p.amountSatang,p.sourceWallet,p.transactionDate,p.status,'then',p.updatedAt,p.version);
    const baseline=hashes(personalFields);
    h.db.prepare(`INSERT INTO ledger_stable_identity_journal(spreadsheet_id,sheet_name,kind,scope,entity_key,metadata_id,state,source_version,projected_version,baseline_json,created_at,updated_at) VALUES('uat','personal','PERSONAL_USE','CORE',?,43,'VERIFIED',1,1,?,'then','then')`).run(p.id,JSON.stringify(baseline));
    const j=new LedgerStableJournal(h.env,'personal',p);
    h.db.prepare(`UPDATE owner_personal_transactions SET source_wallet='CASH_DRAWER' WHERE personal_use_id=?`).run(p.id);
    assert.equal(await j.beginUpdate(43,1,baseline,token),false);
    h.db.prepare(`UPDATE owner_personal_transactions SET source_wallet='SHOP_BANK' WHERE personal_use_id=?`).run(p.id);
    assert.equal(await j.beginUpdate(43,1,baseline,token),true);
    assert.equal(await j.finish(43,token,hashes(personalFields,'b')),true);
  }finally{h.close()}
});
test('purchase item, parent, document, sibling aggregate and first-item order are guarded',async()=>{
  const h=fixture();try{
    h.db.prepare(`INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,updated_at,vendor_name,legal_vendor_name,document_number,order_id,document_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('doc_a','docmsg','line','receipt','CONFIRMED','then','now','vendor','legal','receipt1',null,'2026-10-01');
    h.db.prepare(`INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES(?,?,?,?,?,?)`).run('link_a','exp_fixture','doc_a','PRIMARY_PURCHASE_DOCUMENT','MANUAL','then');
    const insert=h.db.prepare(`INSERT INTO expense_document_items(item_id,document_id,expense_id,description,quantity,unit,unit_price_satang,discount_satang,line_total_satang,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run('item_a','doc_a','exp_fixture','first',1,'piece',3000,0,3000,'a','now');
    insert.run('item_b','doc_a','exp_fixture','second',2,'piece',3000,0,6000,'b','now');
    const proof={kind:'PURCHASE_DETAILS',id:'exp_fixture',version:2,status:'CONFIRMED',transactionDate:'2026-10-01',description:'fixture',amountSatang:10000,category:'ingredients',branchId:null,createdAt:'then',updatedAt:'now',documentId:'doc_a',documentType:'receipt',documentDate:'2026-10-01',vendorName:'vendor',legalVendorName:'legal',documentNumber:'receipt1',orderId:null,documentUpdatedAt:'now',itemId:'item_a',itemDescription:'first',quantity:1,unit:'piece',unitPriceSatang:3000,discountSatang:0,lineTotalSatang:3000,itemUpdatedAt:'now',validItemCount:2,totalLineSatang:9000,firstItemId:'item_a'};
    const baseline=hashes(detailFields);
    h.db.prepare(`INSERT INTO ledger_stable_identity_journal(spreadsheet_id,sheet_name,kind,scope,entity_key,metadata_id,state,source_version,projected_version,baseline_json,created_at,updated_at) VALUES('uat','details','PURCHASE_DETAILS','ITEM','exp_fixture|item_a',43,'VERIFIED',1,1,?,'then','then')`).run(JSON.stringify(baseline));
    const j=new LedgerStableJournal(h.env,'details',proof);
    h.db.prepare(`UPDATE expense_document_items SET line_total_satang=6500 WHERE item_id='item_b'`).run();
    assert.equal(await j.beginUpdate(43,1,baseline,token),false,'sibling adjustment changed without parent version');
    h.db.prepare(`UPDATE expense_document_items SET line_total_satang=6000 WHERE item_id='item_b'`).run();
    h.db.prepare(`UPDATE expense_document_items SET created_at='0' WHERE item_id='item_b'`).run();
    assert.equal(await j.beginUpdate(43,1,baseline,token),false,'first item changed');
    h.db.prepare(`UPDATE expense_document_items SET created_at='b' WHERE item_id='item_b'`).run();
    assert.equal(await j.beginUpdate(43,1,baseline,token),true);
    h.db.prepare(`UPDATE expense_documents SET vendor_name='changed' WHERE document_id='doc_a'`).run();
    assert.equal(await j.finish(43,token,hashes(detailFields,'b')),false,'document changed without version bump');
  }finally{h.close()}
});
test('existing RAW update checks journal, source, pre-dispatch and postimage before VERIFIED',async()=>{
  const h=fixture();try{
    const prior={1:'2026-10-01',2:'old fixture',3:100,4:'transfer',5:'SHOP_BANK',6:'ingredients',7:'CONFIRMED'},baseline={};
    for(const i of expenseFields)baseline[String(i)]=await digestLedgerCell(prior[i]);
    h.db.prepare(`UPDATE ledger_stable_identity_journal SET baseline_json=? WHERE entity_key='exp_fixture'`).run(JSON.stringify(baseline));
    let written=false,calls=0;auth.getGoogleAccessToken=async()=> 'synthetic';globalThis.fetch=async()=>{calls++;written=true;return new Response(JSON.stringify({totalUpdatedRows:1,responses:[{}]}))};
    const identity={kind:'EXPENSE',sheetId:42,entityId:h.expense.id}, witness={metadataId:42,metadataKey:'E',sheetId:42,dimension:'ROWS',startIndex:1,endIndex:2,visibility:'DOCUMENT'};
    const makeCells=()=>Array.from({length:17},()=>({entered:null,formula:null,note:null,hasValidation:false}));
    const probe={async read(){const expected=makeCells(),observed=makeCells();for(const i of expenseFields){expected[i].entered=prior[i];observed[i].entered=i===2&&written?'fixture':prior[i]}return{witness,identityRows:[[...RAW_PROJECTION_HEADERS.EXPENSE],['exp_fixture']],guard:{fields:expenseFields,expected,observed}}}};
    const values=['exp_fixture','2026-10-01','fixture',100,'transfer','SHOP_BANK','ingredients','CONFIRMED',...Array(9).fill(null)];
    assert.equal(await projectExistingLedgerShadow(h.env,'raw',h.expense,identity,42,1,values,token,probe),'VERIFIED');
    const row=h.db.prepare(`SELECT state,projected_version,baseline_json FROM ledger_stable_identity_journal WHERE entity_key='exp_fixture'`).get();
    assert.equal(row.state,'VERIFIED');assert.equal(row.projected_version,2);assert.equal(JSON.parse(row.baseline_json)['2'],await digestLedgerCell('fixture'));assert.equal(calls,1);
  }finally{h.close()}
});
test('partial patch cannot mark an entire CORE projection as a newer version',async()=>{
  const h=fixture();try{
    let calls=0;globalThis.fetch=async()=>{calls++;throw Error('must not dispatch')};
    const identity={kind:'EXPENSE',sheetId:42,entityId:h.expense.id},witness={metadataId:42,metadataKey:'E',sheetId:42,dimension:'ROWS',startIndex:1,endIndex:2,visibility:'DOCUMENT'};
    const cells=()=>Array.from({length:17},()=>({entered:null,formula:null,note:null,hasValidation:false}));
    const probe={async read(){return{witness,identityRows:[[...RAW_PROJECTION_HEADERS.EXPENSE],['exp_fixture']],guard:{fields:[2],expected:cells(),observed:cells()}}}};
    const values=['exp_fixture','2026-10-01','fixture',100,'transfer','SHOP_BANK','ingredients','CONFIRMED',...Array(9).fill(null)];
    assert.equal(await projectExistingLedgerShadow(h.env,'raw',h.expense,identity,42,1,values,token,probe),'REVIEW');
    const row=h.db.prepare(`SELECT state,projected_version FROM ledger_stable_identity_journal WHERE entity_key='exp_fixture'`).get();
    assert.equal(row.state,'VERIFIED');assert.equal(row.projected_version,1);assert.equal(calls,0);
  }finally{h.close()}
});
test('manual edit after preflight, source race or unknown response holds without replay',async()=>{
  for(const scenario of ['manual','source','unknown']){
    const h=fixture();try{
      const prior={1:'2026-10-01',2:'old fixture',3:100,4:'transfer',5:'SHOP_BANK',6:'ingredients',7:'CONFIRMED'},baseline={};
      for(const i of expenseFields)baseline[String(i)]=await digestLedgerCell(prior[i]);
      h.db.prepare(`UPDATE ledger_stable_identity_journal SET baseline_json=? WHERE entity_key='exp_fixture'`).run(JSON.stringify(baseline));
      let reads=0,written=false,calls=0;auth.getGoogleAccessToken=async()=> 'synthetic';globalThis.fetch=async()=>{calls++;written=true;if(scenario==='source')h.db.prepare(`UPDATE expense_events SET description='changed'`).run();return new Response(scenario==='unknown'?'invalid-json':JSON.stringify({totalUpdatedRows:1,responses:[{}]}))};
      const identity={kind:'EXPENSE',sheetId:42,entityId:h.expense.id},witness={metadataId:42,metadataKey:'E',sheetId:42,dimension:'ROWS',startIndex:1,endIndex:2,visibility:'DOCUMENT'};
      const cells=()=>Array.from({length:17},()=>({entered:null,formula:null,note:null,hasValidation:false}));
      const probe={async read(){reads++;const expected=cells(),observed=cells(),old=scenario==='manual'&&reads===2?'manual':'old fixture';for(const i of expenseFields){expected[i].entered=i===2?old:prior[i];observed[i].entered=i===2?(written?'fixture':old):prior[i]}return{witness,identityRows:[[...RAW_PROJECTION_HEADERS.EXPENSE],['exp_fixture']],guard:{fields:expenseFields,expected,observed}}}};
      const values=['exp_fixture','2026-10-01','fixture',100,'transfer','SHOP_BANK','ingredients','CONFIRMED',...Array(9).fill(null)];
      assert.equal(await projectExistingLedgerShadow(h.env,'raw',h.expense,identity,42,1,values,token,probe),'REVIEW');
      assert.equal(h.db.prepare(`SELECT state FROM ledger_stable_identity_journal WHERE entity_key='exp_fixture'`).get().state,'REVIEW');
      assert.equal(calls,scenario==='manual'?0:1);
    }finally{h.close()}
  }
});
