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
const {projectRawFullShadow}=require('../dist/sheets/raw-full-projection-shadow.js');
const auth=require('../dist/sheets/google-auth.js');
const client=require('../dist/sheets/client.js');
const {FullRawIdentityIntent}=require('../dist/sheets/full-raw-identity-intent.js');
const {ExpenseProjectionRuntimeJournal}=require('../dist/sheets/expense-projection-runtime-journal.js');
class Statement{constructor(db,sql){this.db=db;this.sql=sql;this.args=[]}bind(...args){this.args=args;return this}async first(){return this.db.prepare(this.sql).get(...this.args)??null}async run(){return{meta:{changes:Number(this.db.prepare(this.sql).run(...this.args).changes)}}}}
class D1{constructor(db){this.db=db}prepare(sql){return new Statement(this.db,sql)}}
function fixture(){
  const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(x=>/^\d+.*\.sql$/.test(x)).sort())db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
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
test('full metadata adapter checks complete baseline and postimage yet remains REVIEW',async()=>{
  const f=fixture(),oldFetch=globalThis.fetch,oldToken=auth.getGoogleAccessToken;try{
    Object.assign(f.env,{RUNTIME_MODE:'shadow',SHEETS_LEDGER_FULL_PROJECTION_UAT:'true',SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE:'true',GOOGLE_SPREADSHEET_ID:'uat',SHEETS_LEDGER_UAT_SPREADSHEET_ID:'uat',SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID:'production'});
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),identity={kind:'EXPENSE',sheetId:7,entityId:proof.entityId},witness={metadataId:44,metadataKey:'E',sheetId:7,dimension:'ROWS',startIndex:1,endIndex:2,visibility:'DOCUMENT'};
    const rows=[['Expense_ID'],[proof.entityId]],cells=proof.values.map(entered=>({entered,formula:null,note:null,hasValidation:false}));cells[2].entered='old description';
    const baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(cells[i].entered);
    let begins=0,holds=0,dispatches=0,canDispatch=true;
    const intents={async begin(){begins++;return true},async canDispatch(){return canDispatch},async hold(){holds++}};
    const probe={async read(){const observed=cells.map(c=>({...c}));return{witness,identityRows:rows,guard:{fields:[1],observed,expected:observed}}}};
    auth.getGoogleAccessToken=async()=> 'synthetic-token';globalThis.fetch=async(_url,init)=>{dispatches++;const body=JSON.parse(init.body);assert.equal(body.valueInputOption,'RAW');assert.equal(body.data[0].dataFilter.developerMetadataLookup.metadataId,44);assert.equal(body.data[0].values[0][0],null);for(let i=1;i<17;i++)cells[i].entered=proof.values[i]===''?null:proof.values[i];return new Response(JSON.stringify({totalUpdatedRows:1,responses:[{}]}))};
    const run=()=>projectRawFullShadow(f.env,proof,identity,44,baseline,'synthetic_token_123456',probe,intents);
    assert.deepEqual(await run(),{status:'REVIEW',observation:'READBACK_MATCHED'});assert.equal(begins,1);assert.equal(dispatches,1);assert.equal(holds,1);
    cells[2].entered='old description';canDispatch=false;
    assert.deepEqual(await run(),{status:'REVIEW',observation:'UNVERIFIED'});assert.equal(dispatches,1);assert.equal(holds,2);
    canDispatch=true;globalThis.fetch=async()=>{dispatches++;throw Error('unknown delivery')};
    assert.deepEqual(await run(),{status:'REVIEW',observation:'UNVERIFIED'});assert.equal(dispatches,2);assert.equal(holds,3);
    const observed=cells.map(c=>({...c})),request={identity,witness,identityRows:rows,values:proof.values,guard:{fields:Array.from({length:16},(_,i)=>i+1),observed,expected:observed},baselineHashes:baseline};
    globalThis.fetch=async()=>new Response('{sensitive sentinel invalid JSON',{status:200});
    await assert.rejects(client.writeRawFullByMetadataUat(f.env,request,async()=>{}),e=>e.name==='SheetsMutationOutcomeUnknownError'&&!e.message.includes('sentinel'));
    globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.error(new Error('sensitive sentinel stream'))}}),{status:200});
    await assert.rejects(client.writeRawFullByMetadataUat(f.env,request,async()=>{}),e=>e.name==='SheetsMutationOutcomeUnknownError'&&!e.message.includes('sentinel'));
    f.env.RUNTIME_MODE='production';assert.deepEqual(await run(),{status:'REVIEW',observation:'UNVERIFIED'});assert.equal(dispatches,2);
  }finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldToken;f.close();}
});
async function installIntentFixture(f,baseline){
  Object.assign(f.env,{RUNTIME_MODE:'production',RAW_FULL_IDENTITY_WRITER_ENABLED:'true',EXPENSE_STABLE_PROJECTION_ENABLED:'true',DAILY_LEGACY_WRITER_GATE_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'uat',SHEET_EXPENSE_RAW:'raw',SHEET_EXPENSE_DAILY:'daily',SHEET_PURCHASE_DETAILS:'details'});
  f.db.exec(`INSERT INTO expense_projection_cutovers(spreadsheet_id,sheet_name,generation,state,admission_watermark,activated_at) VALUES('uat','daily','generation_123','ACTIVE',0,'now');
    INSERT INTO daily_legacy_writer_gates(spreadsheet_id,sheet_name,state,generation,updated_at) VALUES('uat','daily','HOLD','generation_123','now');
    INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_fixture',2,'synthetic','PROCESSING',1,'now','9999-01-01T00:00:00.000Z','lease_token_123456');`);
  f.db.prepare(`INSERT INTO full_raw_identity_intents(spreadsheet_id,sheet_name,expense_id,metadata_id,state,projected_version,baseline_json,source_version,source_revision,updated_at) VALUES('uat','raw','exp_fixture',44,'VERIFIED',1,?,1,1,'now')`).run(JSON.stringify(baseline));
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:2,traceId:'synthetic'},outer=new ExpenseProjectionRuntimeJournal(f.env,job,'lease_token_123456');
  const context=await outer.context();assert.ok(context);const outerToken=await outer.begin('RAW',context);assert.ok(outerToken);
  return {intent:new FullRawIdentityIntent(f.env,job,'lease_token_123456',outerToken,context),outer,outerToken,context};
}
test('canonical outer fence and inner baseline/lease are enforced in the same D1 statement',async()=>{
  const f=fixture();try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(proof.values[i]);
    const {intent}=await installIntentFixture(f,baseline),token='inner_token_123456';
    assert.equal(await intent.begin(proof,44,{...baseline,'1':'0'.repeat(64)},token),false);
    assert.equal(await intent.begin(proof,44,baseline,token),true);assert.equal(await intent.canDispatch(proof,44,token),true);
    f.db.exec(`UPDATE expense_projection_cutovers SET generation='other_generation'`);assert.equal(await intent.canDispatch(proof,44,token),false);f.db.exec(`UPDATE expense_projection_cutovers SET generation='generation_123'`);
    f.db.exec(`UPDATE sync_jobs SET lease_token='different_lease'`);assert.equal(await intent.canDispatch(proof,44,token),false);f.db.exec(`UPDATE sync_jobs SET lease_token='lease_token_123456'`);
    f.db.exec(`UPDATE full_raw_identity_intents SET metadata_id=45`);assert.equal(await intent.canDispatch(proof,44,token),false);f.db.exec(`UPDATE full_raw_identity_intents SET metadata_id=44`);
    f.db.exec(`UPDATE full_raw_identity_intents SET projected_version=99`);assert.equal(await intent.canDispatch(proof,44,token),false);f.db.exec(`UPDATE full_raw_identity_intents SET projected_version=1`);
    f.db.exec(`UPDATE full_raw_identity_intents SET baseline_json='{}'`);assert.equal(await intent.canDispatch(proof,44,token),false);f.db.prepare(`UPDATE full_raw_identity_intents SET baseline_json=?`).run(JSON.stringify(baseline));
    f.db.exec(`UPDATE expense_events SET trace_id='changed' WHERE expense_id='exp_fixture'; UPDATE expense_events SET trace_id='trace-a' WHERE expense_id='exp_fixture'`);
    assert.equal(await intent.canDispatch(proof,44,token),false);
    await intent.hold(44,token);assert.equal(f.db.prepare(`SELECT state FROM full_raw_identity_intents`).get().state,'REVIEW');assert.equal(await intent.begin(proof,44,baseline,token),false);
    assert.equal(f.db.prepare(`PRAGMA table_info(full_raw_identity_intents)`).all().some(r=>/row_number|row_index/.test(r.name)),false);
  }finally{f.close();}
});
test('real migration guard fails closed on missing trigger, index, outer intent, old mapping or gate',async()=>{
  for(const change of ['flag','outer','mapping','gate','trigger','index','other_projection']){const f=fixture();try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(proof.values[i]);
    const {intent,context}=await installIntentFixture(f,baseline);
    if(change==='flag')f.env.RAW_FULL_IDENTITY_WRITER_ENABLED='false';
    if(change==='outer')f.db.exec(`UPDATE expense_projection_runtime_intents SET state='REVIEW'`);
    if(change==='mapping')f.db.exec(`INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES('raw','exp_fixture',55)`);
    if(change==='gate')f.db.exec(`UPDATE daily_legacy_writer_gates SET state='OPEN'`);
    if(change==='trigger')f.db.exec(`DROP TRIGGER expense_projection_document_before_update`);
    if(change==='index')f.db.exec(`DROP INDEX idx_expense_documents_reference_key`);
    if(change==='other_projection')f.db.prepare(`INSERT INTO expense_projection_runtime_intents(spreadsheet_id,expense_id,source_version,source_revision,projection,state,operation_token,cutover_generation,admission_watermark,updated_at) VALUES('uat','exp_fixture',2,?,'DAILY','REVIEW','other_token_123456','generation_123',0,'now')`).run(context.revision);
    if(change==='flag')await assert.rejects(intent.begin(proof,44,baseline,'inner_token_123456'),/DISABLED/);
    else assert.equal(await intent.begin(proof,44,baseline,'inner_token_123456'),false);
    assert.equal(f.db.prepare(`SELECT state FROM full_raw_identity_intents`).get().state,'VERIFIED');
  }finally{f.close();}}
});
