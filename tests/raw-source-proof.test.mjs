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
const {FullRawAppendIntent}=require('../dist/sheets/full-raw-append-intent.js');
const {auditLegacyExpenseRawEnrollment}=require('../dist/sheets/legacy-raw-enrollment-audit.js');
const {ExpenseProjectionRuntimeJournal}=require('../dist/sheets/expense-projection-runtime-journal.js');
const {RAW_PROJECTION_HEADERS}=require('../dist/sheets/raw-projection.js');
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
    const rows=[[...RAW_PROJECTION_HEADERS.EXPENSE],[proof.entityId]],cells=proof.values.map(entered=>({entered,formula:null,note:null,hasValidation:false}));
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
    const rows=[[...RAW_PROJECTION_HEADERS.EXPENSE],[proof.entityId]],cells=proof.values.map(entered=>({entered,formula:null,note:null,hasValidation:false}));cells[2].entered='old description';
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
  Object.assign(f.env,{RUNTIME_MODE:'production',EXPENSE_GENERATION_WORKER_ENABLED:'true',RAW_FULL_IDENTITY_WRITER_ENABLED:'true',EXPENSE_STABLE_PROJECTION_ENABLED:'true',DAILY_LEGACY_WRITER_GATE_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'uat',SHEET_EXPENSE_RAW:'raw',SHEET_EXPENSE_DAILY:'daily',SHEET_PURCHASE_DETAILS:'details'});
  f.db.exec(`INSERT INTO expense_projection_cutovers(spreadsheet_id,sheet_name,generation,state,admission_watermark,activated_at) VALUES('uat','daily','generation_123','ACTIVE',0,'now');
    INSERT INTO daily_legacy_writer_gates(spreadsheet_id,sheet_name,state,generation,updated_at) VALUES('uat','daily','HOLD','generation_123','now');
    INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_fixture',2,'synthetic','PROCESSING',1,'now','9999-01-01T00:00:00.000Z','lease_token_123456');`);
  f.db.prepare(`INSERT INTO full_raw_identity_intents(spreadsheet_id,sheet_name,expense_id,metadata_id,state,projected_version,projected_revision,baseline_json,source_version,source_revision,updated_at) VALUES('uat','raw','exp_fixture',44,'VERIFIED',1,1,?,1,1,'now')`).run(JSON.stringify(baseline));
  // Model a source revision newer than the already projected baseline without
  // changing the synthetic source values used by the proof.
  f.db.exec("UPDATE expense_events SET trace_id=trace_id WHERE expense_id='exp_fixture'");
  const revision=f.db.prepare("SELECT revision FROM expense_projection_source_revisions WHERE expense_id='exp_fixture'").get().revision,generationLease={generation:'generation_123',revision,token:'generation_token_123456'};
  f.db.prepare("INSERT INTO expense_projection_generation_jobs(spreadsheet_id,cutover_generation,expense_id,source_version,source_revision,state,lease_token,lease_until,created_at,updated_at) VALUES('uat','generation_123','exp_fixture',2,?,'IN_FLIGHT','generation_token_123456','9999-01-01T00:00:00.000Z','now','now')").run(revision);
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:2,traceId:'synthetic'},outer=new ExpenseProjectionRuntimeJournal(f.env,job,'lease_token_123456',generationLease);
  const context=await outer.context();assert.ok(context);const outerToken=await outer.begin('RAW',context);assert.ok(outerToken);
  return {intent:new FullRawIdentityIntent(f.env,job,'lease_token_123456',outerToken,context,generationLease),outer,outerToken,context,generationLease};
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
    f.db.exec(`UPDATE full_raw_identity_intents SET projected_revision=99`);assert.equal(await intent.canDispatch(proof,44,token),false);f.db.exec(`UPDATE full_raw_identity_intents SET projected_revision=1`);
    f.db.exec(`UPDATE full_raw_identity_intents SET baseline_json='{}'`);assert.equal(await intent.canDispatch(proof,44,token),false);f.db.prepare(`UPDATE full_raw_identity_intents SET baseline_json=?`).run(JSON.stringify(baseline));
    f.db.exec(`UPDATE expense_events SET trace_id='changed' WHERE expense_id='exp_fixture'; UPDATE expense_events SET trace_id='trace-a' WHERE expense_id='exp_fixture'`);
    assert.equal(await intent.canDispatch(proof,44,token),false);
    await intent.hold(44,token);assert.equal(f.db.prepare(`SELECT state FROM full_raw_identity_intents`).get().state,'REVIEW');assert.equal(await intent.begin(proof,44,baseline,token),false);
    assert.equal(f.db.prepare(`PRAGMA table_info(full_raw_identity_intents)`).all().some(r=>/row_number|row_index/.test(r.name)),false);
  }finally{f.close();}
});
test('RAW identity allows a higher source revision at the same expense version and rejects nonmonotonic preimages',async()=>{const f=fixture(),oldFetch=globalThis.fetch,oldToken=auth.getGoogleAccessToken;try{const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(proof.values[i]);const {intent,context}=await installIntentFixture(f,baseline),token='inner_token_123456';assert.ok(context.revision>1);const set=f.db.prepare('UPDATE full_raw_identity_intents SET projected_version=?,projected_revision=?');set.run(2,context.revision);assert.equal(await intent.begin(proof,44,baseline,token),false);set.run(3,context.revision-1);assert.equal(await intent.begin(proof,44,baseline,token),false);set.run(2,context.revision-1);assert.equal(await intent.begin(proof,44,baseline,token),true);assert.equal(await intent.canDispatch(proof,44,token),true);mockProductionRawProvider(proof);const result=await intent.finish(proof,{kind:'EXPENSE',sheetId:7,entityId:'exp_fixture'},44,token);assert.equal(result.status,'VERIFIED');const row=f.db.prepare('SELECT projected_version,projected_revision FROM full_raw_identity_intents').get();assert.equal(row.projected_version,2);assert.equal(row.projected_revision,context.revision);}finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldToken;f.close();}});
test('document-only edit verifies the new RAW postimage against an older baseline at the same expense version',async()=>{const f=fixture(),oldFetch=globalThis.fetch,oldToken=auth.getGoogleAccessToken;try{addDocument(f.db,'doc1');const previous=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),oldRevision=f.db.prepare("SELECT revision FROM expense_projection_source_revisions WHERE expense_id='exp_fixture'").get().revision,baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(previous.values[i]);f.db.exec("UPDATE expense_documents SET vendor_name='Updated vendor' WHERE document_id='doc1'");const next=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2);assert.equal(previous.values[14],'Vendor');assert.equal(next.values[14],'Updated vendor');const {intent,outer,outerToken,context}=await installIntentFixture(f,baseline),token='inner_token_123456';f.db.prepare('UPDATE full_raw_identity_intents SET projected_version=2,projected_revision=?').run(oldRevision);assert.ok(context.revision>oldRevision);assert.equal(await intent.begin(next,44,baseline,token),true);mockProductionRawProvider(next);const result=await intent.finish(next,{kind:'EXPENSE',sheetId:7,entityId:'exp_fixture'},44,token);assert.equal(result.status,'VERIFIED');const row=f.db.prepare('SELECT projected_version,projected_revision,baseline_json FROM full_raw_identity_intents').get();assert.equal(row.projected_version,2);assert.equal(row.projected_revision,context.revision);assert.equal(JSON.parse(row.baseline_json)['14'],await digestLedgerCell('Updated vendor'));assert.notEqual(JSON.parse(row.baseline_json)['14'],baseline['14']);assert.equal(await outer.verify('RAW',outerToken,context,result.evidenceDigest),true);assert.equal(await outer.complete(context),false);}finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldToken;f.close();}});
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
function mockProductionRawProvider(proof,options={}){
  let calls=0;auth.getGoogleAccessToken=async()=> 'synthetic-token';
  const metadata={metadataId:44,metadataKey:'E',visibility:'DOCUMENT',location:{dimensionRange:{sheetId:7,dimension:'ROWS',startIndex:1,endIndex:2}}};
  const values=proof.values.map(value=>value===null||value===''?{}:typeof value==='string'?{userEnteredValue:{stringValue:value}}:typeof value==='number'?{userEnteredValue:{numberValue:value}}:{userEnteredValue:{boolValue:value}});
  const grid={sheets:[{properties:{sheetId:7,title:'raw',gridProperties:{rowCount:2,columnCount:17}},data:[{rowData:[{values:RAW_PROJECTION_HEADERS.EXPENSE.map(h=>({userEnteredValue:{stringValue:h}}))},{values}]}]}]};
  globalThis.fetch=async(_url,init)=>{assert.equal(init.method,'GET');calls++;if(calls===2&&options.onGrid)await options.onGrid(grid);const payload=calls===2?grid:structuredClone(metadata);if(calls===3&&options.moveMetadata)payload.location.dimensionRange.startIndex=2;return new Response(JSON.stringify(payload));};
  return()=>calls;
}
test('inner finish requires fresh provider identity and complete readback, leaving outer intent open',async()=>{
  const f=fixture(),oldFetch=globalThis.fetch,oldToken=auth.getGoogleAccessToken;try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(proof.values[i]);
    const {intent,outer,outerToken,context}=await installIntentFixture(f,baseline),token='inner_token_123456',identity={kind:'EXPENSE',sheetId:7,entityId:'exp_fixture'};
    assert.equal(await intent.begin(proof,44,baseline,token),true);const calls=mockProductionRawProvider(proof);
    const result=await intent.finish(proof,identity,44,token);assert.equal(result.status,'VERIFIED');assert.match(result.evidenceDigest,/^[a-f0-9]{64}$/);assert.equal(calls(),3);
    const inner=f.db.prepare(`SELECT state,projected_version,operation_token FROM full_raw_identity_intents`).get();assert.equal(inner.state,'VERIFIED');assert.equal(inner.projected_version,2);assert.equal(inner.operation_token,null);
    assert.equal(f.db.prepare(`SELECT state FROM expense_projection_runtime_intents WHERE projection='RAW'`).get().state,'IN_FLIGHT');assert.equal(f.db.prepare(`SELECT status FROM sync_jobs`).get().status,'PROCESSING');
    assert.equal(await outer.verify('RAW',outerToken,context,'0'.repeat(64)),false);assert.equal(await outer.verify('RAW',outerToken,context,result.evidenceDigest),true);
  }finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldToken;f.close();}
});
test('inner finish holds on changed values, metadata movement, source ABA or missing guard trigger',async()=>{
  for(const mode of ['value','metadata','source_aba','trigger']){const f=fixture(),oldFetch=globalThis.fetch,oldToken=auth.getGoogleAccessToken;try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(proof.values[i]);
    const {intent}=await installIntentFixture(f,baseline),token='inner_token_123456',identity={kind:'EXPENSE',sheetId:7,entityId:'exp_fixture'};
    assert.equal(await intent.begin(proof,44,baseline,token),true);
    mockProductionRawProvider(proof,{moveMetadata:mode==='metadata',onGrid:grid=>{
      if(mode==='value')grid.sheets[0].data[0].rowData[1].values[2]={userEnteredValue:{stringValue:'changed'}};
      if(mode==='source_aba')f.db.exec(`UPDATE expense_events SET trace_id='changed'; UPDATE expense_events SET trace_id='trace-a'`);
      if(mode==='trigger')f.db.exec(`DROP TRIGGER expense_projection_link_before_update`);
    }});
    assert.deepEqual(await intent.finish(proof,identity,44,token),{status:mode==='source_aba'||mode==='trigger'?'UNKNOWN':'NOT_VERIFIED'});assert.equal(f.db.prepare(`SELECT state FROM full_raw_identity_intents`).get().state,'IN_FLIGHT');
  }finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldToken;f.close();}}
});
test('lost D1 finish acknowledgment cannot complete the outer projection',async()=>{
  const f=fixture(),oldFetch=globalThis.fetch,oldToken=auth.getGoogleAccessToken;try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(proof.values[i]);
    const {intent}=await installIntentFixture(f,baseline),token='inner_token_123456',identity={kind:'EXPENSE',sheetId:7,entityId:'exp_fixture'};
    assert.equal(await intent.begin(proof,44,baseline,token),true);mockProductionRawProvider(proof);
    const prepare=f.env.DB.prepare.bind(f.env.DB);f.env.DB.prepare=sql=>{
      const statement=prepare(sql);if(!sql.includes("UPDATE full_raw_identity_intents SET state='VERIFIED'"))return statement;
      return {bind(...args){const bound=statement.bind(...args);return{async first(){await bound.first();throw Error('synthetic lost acknowledgment');}}}};
    };
    assert.deepEqual(await intent.finish(proof,identity,44,token),{status:'UNKNOWN'});
    assert.equal(f.db.prepare(`SELECT state FROM full_raw_identity_intents`).get().state,'VERIFIED');
    assert.equal(f.db.prepare(`SELECT state FROM expense_projection_runtime_intents WHERE projection='RAW'`).get().state,'IN_FLIGHT');
    assert.equal(f.db.prepare(`SELECT status FROM sync_jobs`).get().status,'PROCESSING');
  }finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldToken;f.close();}
});
test('controller holds outer after unknown inner finish and reports an unconfirmed hold',async()=>{
  for(const holdFails of [false,true]){const f=fixture(),oldFetch=globalThis.fetch,oldToken=auth.getGoogleAccessToken;try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(proof.values[i]);
    const {intent}=await installIntentFixture(f,baseline),token='inner_token_123456',identity={kind:'EXPENSE',sheetId:7,entityId:'exp_fixture'};
    assert.equal(await intent.begin(proof,44,baseline,token),true);mockProductionRawProvider(proof);
    const prepare=f.env.DB.prepare.bind(f.env.DB);f.env.DB.prepare=sql=>{
      const statement=prepare(sql);
      if(sql.includes("UPDATE full_raw_identity_intents SET state='VERIFIED'"))return {bind(...args){const bound=statement.bind(...args);return{async first(){await bound.first();throw Error('lost inner acknowledgment');}}}};
      if(holdFails&&sql.includes("UPDATE expense_projection_runtime_intents SET state='REVIEW'"))return {bind(){return{async run(){throw Error('outer hold unavailable');}}}};
      return statement;
    };
    const outcome=await intent.finishOrHold(proof,identity,44,token);
    assert.deepEqual(outcome,{status:holdFails?'OUTER_HOLD_UNCONFIRMED':'OUTER_REVIEW_INNER_UNCERTAIN'});
    assert.equal(f.db.prepare(`SELECT state FROM full_raw_identity_intents`).get().state,'VERIFIED');
    assert.equal(f.db.prepare(`SELECT state FROM expense_projection_runtime_intents WHERE projection='RAW'`).get().state,holdFails?'IN_FLIGHT':'REVIEW');
    assert.equal(f.db.prepare(`SELECT status FROM sync_jobs`).get().status,'PROCESSING');
  }finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldToken;f.close();}}
});
test('controller returns evidence only after readback, and holds both intents on mismatch',async()=>{
  for(const mismatch of [false,true]){const f=fixture(),oldFetch=globalThis.fetch,oldToken=auth.getGoogleAccessToken;try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(proof.values[i]);
    const {intent,outer,outerToken,context}=await installIntentFixture(f,baseline),token='inner_token_123456',identity={kind:'EXPENSE',sheetId:7,entityId:'exp_fixture'};
    assert.equal(await intent.begin(proof,44,baseline,token),true);
    mockProductionRawProvider(proof,{onGrid:grid=>{if(mismatch)grid.sheets[0].data[0].rowData[1].values[2]={userEnteredValue:{stringValue:'changed'}};}});
    const result=await intent.finishOrHold(proof,identity,44,token);
    if(mismatch){assert.deepEqual(result,{status:'OUTER_REVIEW'});assert.equal(f.db.prepare(`SELECT state FROM full_raw_identity_intents`).get().state,'REVIEW');assert.equal(await outer.complete(context),false);}
    else{assert.equal(result.status,'INNER_VERIFIED_OUTER_IN_FLIGHT');assert.match(result.evidenceDigest,/^[0-9a-f]{64}$/);assert.equal(await outer.verify('RAW',outerToken,context,result.evidenceDigest),true);}
    assert.equal(f.db.prepare(`SELECT status FROM sync_jobs`).get().status,'PROCESSING');
  }finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldToken;f.close();}}
});
async function installAppendFixture(f,proof,keepExisting=false){
  const baseline={};for(let i=1;i<17;i++)baseline[String(i)]=await digestLedgerCell(proof.values[i]);
  const outer=await installIntentFixture(f,baseline);if(!keepExisting)f.db.exec('DELETE FROM full_raw_identity_intents');
  f.env.RAW_APPEND_WRITER_ENABLED='true';const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:proof.entityId,entityVersion:proof.version,traceId:'synthetic'};
  return {...outer,append:new FullRawAppendIntent(f.env,job,'lease_token_123456',outer.outerToken,outer.context,outer.generationLease)};
}
test('RAW append cannot acquire a sheet lock without the generation lease',async()=>{const f=fixture();try{const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),outer=await installAppendFixture(f,proof),job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:proof.entityId,entityVersion:proof.version,traceId:'synthetic'},append=new FullRawAppendIntent(f.env,job,'lease_token_123456',outer.outerToken,outer.context);await assert.rejects(append.acquire(proof,'append_token_123456'),/LEASE_REQUIRED/);assert.equal(f.db.prepare('SELECT count(*) n FROM full_raw_sheet_locks').get().n,0);}finally{f.close();}});
test('append reservation holds one RAW sheet, uses fixed metadata identity and never expires',async()=>{
  const f=fixture();try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),{append}=await installAppendFixture(f,proof),token='append_token_123456';
    assert.equal(await append.acquire(proof,token),true);assert.equal(await append.reserve(proof,44,token),true);assert.equal(await append.beginDispatch(proof,44,token),true);
    assert.equal(await append.hold(token),true);assert.equal(await append.acquire(proof,'second_token_123456'),false);
    assert.equal(f.db.prepare('SELECT state FROM full_raw_sheet_locks').get().state,'REVIEW');assert.equal(f.db.prepare('SELECT state FROM full_raw_append_intents').get().state,'REVIEW');
    for(const table of ['full_raw_sheet_locks','full_raw_append_intents'])assert.equal(f.db.prepare(`PRAGMA table_info(${table})`).all().some(r=>/row_number|row_index/.test(r.name)),false);
  }finally{f.close();}
});
test('two different expense append intents cannot acquire the same RAW sheet',async()=>{
  const f=fixture();try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),first=await installAppendFixture(f,proof);
    f.db.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,updated_at,version) VALUES('exp_second','msg_second','line','second',12000,'transfer','SHOP_BANK','ingredients','2026-10-01','CONFIRMED','then','now',1)`).run();
    f.db.exec(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('job2','EXPENSE','exp_second',1,'synthetic','PROCESSING',1,'now','9999-01-01T00:00:00.000Z','lease_token_654321')`);
    const secondProof=await readRawSourceProof(f.env,'EXPENSE','exp_second',1),job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_second',entityVersion:1,traceId:'synthetic'},revision=f.db.prepare("SELECT revision FROM expense_projection_source_revisions WHERE expense_id='exp_second'").get().revision,generationLease={generation:'generation_123',revision,token:'generation_token_654321'};
    f.db.prepare("INSERT INTO expense_projection_generation_jobs(spreadsheet_id,cutover_generation,expense_id,source_version,source_revision,state,lease_token,lease_until,created_at,updated_at) VALUES('uat','generation_123','exp_second',1,?,'IN_FLIGHT','generation_token_654321','9999-01-01T00:00:00.000Z','now','now')").run(revision);
    const outer=new ExpenseProjectionRuntimeJournal(f.env,job,'lease_token_654321',generationLease),ctx=await outer.context();assert.ok(ctx);const outerToken=await outer.begin('RAW',ctx);assert.ok(outerToken);const second=new FullRawAppendIntent(f.env,job,'lease_token_654321',outerToken,ctx,generationLease);
    const results=await Promise.all([first.append.acquire(proof,'append_token_first_123'),second.acquire(secondProof,'append_token_second_123')]);assert.equal(results.filter(Boolean).length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM full_raw_sheet_locks').get().n,1);
  }finally{f.close();}
});
test('existing identity, changed source revision, lost generation lease and disabled append stop reservation',async()=>{
  for(const mode of ['existing','source_aba','generation_expired','flag']){const f=fixture();try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),{append}=await installAppendFixture(f,proof,mode==='existing'),token='append_token_123456';
    if(mode==='flag')f.env.RAW_APPEND_WRITER_ENABLED='false';
    if(mode==='flag'){await assert.rejects(append.acquire(proof,token),/DISABLED/);assert.equal(f.db.prepare('SELECT count(*) n FROM full_raw_sheet_locks').get().n,0);continue;}
    assert.equal(await append.acquire(proof,token),true);
    if(mode==='source_aba')f.db.exec(`UPDATE expense_events SET trace_id='changed'; UPDATE expense_events SET trace_id='trace-a'`);
    if(mode==='generation_expired')f.db.exec("UPDATE expense_projection_generation_jobs SET lease_until='2000-01-01T00:00:00.000Z'");
    assert.equal(await append.reserve(proof,44,token),false);assert.equal(f.db.prepare('SELECT state FROM full_raw_sheet_locks').get().state,'HELD');
  }finally{f.close();}}
});
test('lost lock, reservation or dispatch acknowledgment never authorizes a later dispatch',async()=>{
  for(const stage of ['lock','reservation','dispatch']){const f=fixture();try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),{append}=await installAppendFixture(f,proof),token='append_token_123456';
    if(stage!=='lock')assert.equal(await append.acquire(proof,token),true);
    if(stage==='dispatch')assert.equal(await append.reserve(proof,44,token),true);
    const target=stage==='lock'?'INSERT INTO full_raw_sheet_locks':stage==='reservation'?'INSERT INTO full_raw_append_intents':"UPDATE full_raw_append_intents SET state='IN_FLIGHT'";
    const prepare=f.env.DB.prepare.bind(f.env.DB);f.env.DB.prepare=sql=>{const statement=prepare(sql);if(!sql.includes(target))return statement;return{bind(...args){const bound=statement.bind(...args);return{async run(){await bound.run();throw Error('synthetic lost acknowledgment');}}}};};
    const operation=stage==='lock'?()=>append.acquire(proof,token):stage==='reservation'?()=>append.reserve(proof,44,token):()=>append.beginDispatch(proof,44,token);
    await assert.rejects(operation(),/lost acknowledgment/);
    if(stage==='lock')assert.equal(await append.reserve(proof,44,token),false);
    if(stage==='reservation')assert.equal(await append.beginDispatch(proof,44,token),false);
    assert.equal(f.db.prepare('SELECT state FROM full_raw_sheet_locks').get().state,'HELD');
    assert.equal(await append.holdAndFenceOuter(token),stage==='lock'?'REVIEW_LOCAL_STATE_UNCERTAIN':'REVIEW');
    assert.equal(f.db.prepare(`SELECT state FROM expense_projection_runtime_intents WHERE projection='RAW'`).get().state,'REVIEW');
  }finally{f.close();}}
});
test('legacy enrollment audit requires one exact RAW row and never returns a row number or authorization',async()=>{
  const f=fixture();try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),blank=()=>({entered:null,formula:null,note:null,hasValidation:false});
    const rows=Array.from({length:4},()=>Array.from({length:20},blank));RAW_PROJECTION_HEADERS.EXPENSE.forEach((v,i)=>rows[0][i].entered=v);proof.values.forEach((v,i)=>rows[2][i].entered=v);
    const snapshot={sheetId:7,rowCount:4,columnCount:20,rows,hasProtectedRanges:false,hasMerges:false},audit=()=>auditLegacyExpenseRawEnrollment(f.env,proof,snapshot);
    assert.deepEqual(await audit(),{status:'REVIEW',observation:'SINGLE_MATCH'});
    rows[3][0].entered=proof.entityId;assert.deepEqual(await audit(),{status:'REVIEW',observation:'DUPLICATE'});rows[3][0].entered=null;
    rows[2][0].entered='other';assert.deepEqual(await audit(),{status:'REVIEW',observation:'MISSING'});rows[2][0].entered=proof.entityId;
    rows[2][3].entered=999;assert.deepEqual(await audit(),{status:'REVIEW',observation:'VALUES_DIFFER'});rows[2][3].entered=proof.values[3];
    rows[2][3].note='manual';assert.deepEqual(await audit(),{status:'REVIEW',observation:'SCHEMA_OR_ANNOTATION_UNSAFE'});rows[2][3].note=null;
    [rows[0][2],rows[0][3]]=[rows[0][3],rows[0][2]];assert.deepEqual(await audit(),{status:'REVIEW',observation:'SCHEMA_OR_ANNOTATION_UNSAFE'});[rows[0][2],rows[0][3]]=[rows[0][3],rows[0][2]];
    rows[3][0].formula='="exp_fixture"';assert.deepEqual(await audit(),{status:'REVIEW',observation:'SCHEMA_OR_ANNOTATION_UNSAFE'});rows[3][0].formula=null;
    f.db.exec(`UPDATE expense_events SET trace_id='changed' WHERE expense_id='exp_fixture'`);assert.deepEqual(await audit(),{status:'REVIEW',observation:'SOURCE_CHANGED_OR_UNAVAILABLE'});
  }finally{f.close();}
});
function mockAppendProvider(proof,options={}){
  let posts=0,gridReads=0,metadata=null;auth.getGoogleAccessToken=async()=> 'synthetic-token';
  const properties={sheetId:7,title:'raw',gridProperties:{rowCount:3,columnCount:17}},rows=[{values:RAW_PROJECTION_HEADERS.EXPENSE.map(h=>({userEnteredValue:{stringValue:h}}))},{},{}];
  const grid=()=>({sheets:[{properties:structuredClone(properties),data:[{rowData:structuredClone(rows)}]}]});
  globalThis.fetch=async(url,init)=>{
    const u=new URL(String(url));
    if(init.method==='POST'){
      posts++;const body=JSON.parse(init.body),range=body.requests[0].insertDimension.range;assert.equal(body.requests.length,3);
      if(options.onPost)options.onPost();
      rows.splice(range.startIndex,0,body.requests[1].updateCells.rows[0]);properties.gridProperties.rowCount++;
      metadata=body.requests[2].createDeveloperMetadata.developerMetadata;
      if(options.postMismatch)rows[range.startIndex].values[2]={userEnteredValue:{stringValue:'changed'}};
      if(options.lostResponse)throw Error('synthetic network lost response');
      if(options.malformedResponse)return new Response('{sensitive-sentinel malformed response');
      const returned=structuredClone(metadata);if(options.wrongMetadata)returned.metadataId++;
      return new Response(JSON.stringify({replies:[{},{},{createDeveloperMetadata:{developerMetadata:returned}}]}));
    }
    assert.equal(init.method,'GET');
    if(u.pathname.includes('/developerMetadata/'))return new Response(JSON.stringify(metadata));
    if(u.searchParams.get('fields')?.startsWith('sheets.properties'))return new Response(JSON.stringify({sheets:[{properties:structuredClone(properties)}]}));
    gridReads++;if(gridReads===2&&options.onFresh)options.onFresh(rows);
    return new Response(JSON.stringify(grid()));
  };
  return()=>({posts,gridReads});
}
test('production append controller sends at most once and verifies provider readback before holding',async()=>{
  for(const mode of ['success','lost','malformed','wrong_metadata','readback_mismatch','grid_changed','source_aba','source_during_post','generation_before_post','generation_during_post']){const f=fixture(),oldFetch=globalThis.fetch,oldToken=auth.getGoogleAccessToken;try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),{append}=await installAppendFixture(f,proof),token='append_token_123456';
    assert.equal(await append.acquire(proof,token),true);assert.equal(await append.reserve(proof,44,token),true);
    const state=mockAppendProvider(proof,{lostResponse:mode==='lost',malformedResponse:mode==='malformed',wrongMetadata:mode==='wrong_metadata',postMismatch:mode==='readback_mismatch',onPost:()=>{if(mode==='source_during_post')f.db.exec(`UPDATE expense_events SET trace_id='changed'`);if(mode==='generation_during_post')f.db.exec("UPDATE expense_projection_generation_jobs SET lease_token='different_generation_token'")},onFresh:rows=>{
      if(mode==='grid_changed')rows[2]={values:[{}, {}, {},{note:'new manual note'}]};
      if(mode==='source_aba')f.db.exec(`UPDATE expense_events SET trace_id='changed'; UPDATE expense_events SET trace_id='trace-a'`);
      if(mode==='generation_before_post')f.db.exec("UPDATE expense_projection_generation_jobs SET lease_token='different_generation_token'");
    }});
    const [first,second]=await Promise.all([append.dispatchOnce(proof,44,token,7),append.dispatchOnce(proof,44,token,7)]);
    assert.deepEqual(second,{status:'ALREADY_ATTEMPTED'});
    const expected=mode==='success'?'READBACK_MATCHED':['lost','malformed','wrong_metadata'].includes(mode)?'OUTCOME_UNKNOWN':mode==='readback_mismatch'||mode==='source_during_post'||mode==='generation_during_post'?'READBACK_UNVERIFIED':'NOT_DISPATCHED';
    assert.deepEqual(first,{status:'REVIEW',observation:expected});assert.equal(state().posts,mode==='grid_changed'||mode==='source_aba'||mode==='generation_before_post'?0:1);
    assert.equal(f.db.prepare('SELECT state FROM full_raw_sheet_locks').get().state,'REVIEW');assert.equal(f.db.prepare('SELECT state FROM full_raw_append_intents').get().state,'REVIEW');
    assert.equal(f.db.prepare(`SELECT state FROM expense_projection_runtime_intents WHERE projection='RAW'`).get().state,'REVIEW');assert.equal(f.db.prepare(`SELECT status FROM sync_jobs`).get().status,'PROCESSING');
    if(mode==='success'){
      const blank=()=>({entered:null,formula:null,note:null,hasValidation:false}),rows=Array.from({length:3},()=>Array.from({length:17},blank));RAW_PROJECTION_HEADERS.EXPENSE.forEach((h,i)=>rows[0][i].entered=h);
      const snapshot={sheetId:7,rowCount:3,columnCount:17,rows,hasProtectedRanges:false,hasMerges:false},identity={kind:'EXPENSE',sheetId:7,entityId:proof.entityId};
      await assert.rejects(client.sendRawProductionAppendBatch(f.env,proof,identity,44,snapshot,append,token),/PREFLIGHT_UNAVAILABLE/);assert.equal(state().posts,1);
    }
  }finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldToken;f.close();}}
});
test('fabricated prototype or overridden instance cannot bypass the private transport brand',async()=>{
  const f=fixture(),oldFetch=globalThis.fetch,oldToken=auth.getGoogleAccessToken;try{
    const proof=await readRawSourceProof(f.env,'EXPENSE','exp_fixture',2),{append}=await installAppendFixture(f,proof),token='append_token_123456',identity={kind:'EXPENSE',sheetId:7,entityId:'exp_fixture'};
    const blank=()=>({entered:null,formula:null,note:null,hasValidation:false}),rows=Array.from({length:3},()=>Array.from({length:17},blank));RAW_PROJECTION_HEADERS.EXPENSE.forEach((h,i)=>rows[0][i].entered=h);
    const snapshot={sheetId:7,rowCount:3,columnCount:17,rows,hasProtectedRanges:false,hasMerges:false};let posts=0;auth.getGoogleAccessToken=async()=> 'synthetic-token';globalThis.fetch=async(_url,init)=>{if(init.method==='POST')posts++;throw Error('unexpected request');};
    const fake=Object.create(FullRawAppendIntent.prototype);fake.authorizeProviderTransport=async()=>true;
    await assert.rejects(client.sendRawProductionAppendBatch(f.env,proof,identity,44,snapshot,fake,token),/PREFLIGHT_UNAVAILABLE/);
    append.authorizeProviderTransport=async()=>true;
    await assert.rejects(client.sendRawProductionAppendBatch(f.env,proof,identity,44,snapshot,append,token),/PREFLIGHT_UNAVAILABLE/);
    assert.equal(Reflect.set(FullRawAppendIntent,'authorizeTransport',async()=>true),false);assert.equal(posts,0);
  }finally{globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldToken;f.close();}
});
