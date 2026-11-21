import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url);
const {encodePublicationCarrier:encode,decodePublicationCarrier:decode,publicationTransition:transition,publicationTransitionRequest:request,publicationEmptyMarker:empty,publicationStageRequest:stageRequest,publicationBootstrapRequests,verifyEmptyPublicationColumn,verifyPublicationColumn:verify,dailyPublicationStateFormula}=require('../dist/sheets/continuous-publication-template.js');
const {atomicDailyRowFormulas,encodeAtomicDailyPayload,decodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js');
const {insertContinuousDailyRowRequests}=require('../dist/sheets/append-daily-template.js');
const {executePublicationIntent,recoverPublicationIntent}=require('../dist/sheets/continuous-publication-executor.js');
const {readReviewedPublicationSource}=require('../dist/sheets/continuous-publication-reviewed-source.js');
const staged={expenseId:'exp_fixture',version:1,nonce:'a'.repeat(32),state:'STAGED',detailCount:0};
const published={...staged,nonce:'b'.repeat(32),state:'PUBLISHED'};
const revoked={...staged,version:2,nonce:'c'.repeat(32),state:'REVOKED'};
test('publication marker is canonical and rejects malformed values',()=>{
 assert.deepEqual(decode(encode(staged)),staged);
 for(const value of ['',encode(staged)+'␟x',encode(staged).replace('␟1␟','␟01␟'),encode(staged).replace('STAGED','OTHER')])assert.equal(decode(value),null);
 assert.throws(()=>encode({...staged,expenseId:'exp_bad*'}),/PUBLICATION_CARRIER_INVALID/);
});
test('bootstrap reserves unique markers in an explicitly new hidden tab and requires exact readback',()=>{
 const markers=[empty(2,'a'.repeat(32)),empty(3,'b'.repeat(32))],requests=publicationBootstrapRequests(7,'publication',markers),rows=[['Publication_Marker'],...markers.map(x=>[x])];
 assert.equal(requests[0].addSheet.properties.hidden,true);assert.equal(requests[0].addSheet.properties.gridProperties.rowCount,3);
 assert.equal(verifyEmptyPublicationColumn(rows,rows,markers),true);assert.equal(verifyEmptyPublicationColumn(rows,rows.slice(0,2),markers),false);
 assert.throws(()=>publicationBootstrapRequests(7,'publication',[empty(2,'a'.repeat(32)),empty(3,'a'.repeat(32))]),/BOOTSTRAP_INVALID/);
});
test('transitions are monotonic and stale requests cannot republish after revoke',()=>{
 assert.deepEqual(transition(staged,published),{find:encode(staged),replacement:encode(published)});
 assert.equal(transition(published,revoked).replacement,encode(revoked));
 assert.equal(transition(staged,revoked).replacement,encode(revoked));
 for(const [a,b] of [[published,staged],[revoked,published],[staged,{...published,nonce:staged.nonce}],[published,{...revoked,version:3}]])assert.throws(()=>transition(a,b),/PUBLICATION_TRANSITION_INVALID/);
 const cas=request(7,4,staged,published).findReplace;
 assert.deepEqual(cas.range,{sheetId:7,startRowIndex:3,endRowIndex:4,startColumnIndex:0,endColumnIndex:1});
 assert.equal(cas.matchEntireCell,true);assert.equal(cas.find,encode(staged));assert.equal(cas.replacement,encode(published));
 const unused=empty(4,'d'.repeat(32));assert.equal(stageRequest(7,4,unused,staged).findReplace.find,unused);
 assert.throws(()=>stageRequest(7,3,unused,staged),/PUBLICATION_TARGET_INVALID/);
});
test('positive readback rejects missing, changed, malformed and duplicate markers',()=>{
 const marker=encode(published),good=[['Publication_Marker'],[marker],[empty(3,'d'.repeat(32))],[empty(4,'e'.repeat(32))],[empty(5,'f'.repeat(32))]];
 assert.equal(verify(good,good,5,published,2),true);
 assert.equal(verify([['Publication_Marker']],[['Publication_Marker']],5,published,2),false);
 const changed=good.map(row=>row.slice());changed[1]=['changed'];assert.equal(verify(good,changed,5,published,2),false);
 const duplicate=good.map(row=>row.slice());duplicate[2]=[marker];assert.equal(verify(duplicate,duplicate,5,published,2),false);
 const malformed=good.map(row=>row.slice());malformed[2]=['PUB1␟bad'];assert.equal(verify(malformed,malformed,5,published,2),false);
 assert.equal(verify(good,good,5,published,3),false);
});
test('opt-in publication ties the marker to exact carrier version and shifts only through Z',()=>{
 const data={expenseId:'exp_fixture',postingYear:2026,postingMonth:11,postingDay:15,description:'fixture',amountColumn:'H',amountSatang:123,category:'ingredients',wallet:'บัญชีร้าน',operationMarker:'INSERT_'+'a'.repeat(32),publicationVersion:1};
 assert.deepEqual(decodeAtomicDailyPayload(encodeAtomicDailyPayload(data)),data);
 assert.throws(()=>encodeAtomicDailyPayload({...data,operationMarker:undefined}),/PUBLICATION_VERSION/);
 const state=dailyPublicationStateFormula(5,"pub's tab",1000);assert.match(state,/'pub''s tab'!\$A\$2:\$A\$1000/);assert.match(state,/COUNTIF\(/);assert.match(state,/"REVOKED"/);assert.match(state,/NA\(\)/);
 const legacy=atomicDailyRowFormulas(5),visible=atomicDailyRowFormulas(5,{sheet:'pub',rows:1000});assert.equal(legacy[25],undefined);assert.match(visible[0],/\$Z5="PUBLISHED"/);assert.match(visible[25],/COUNTIF\(/);
 const old=insertContinuousDailyRowRequests(7,5,1000,encodeAtomicDailyPayload(data)),next=insertContinuousDailyRowRequests(7,5,1000,encodeAtomicDailyPayload(data),{sheet:'pub',rows:1000});
 assert.equal(old[0].insertRange.range.endColumnIndex,25);assert.equal(next[0].insertRange.range.endColumnIndex,26);assert.equal(next[1].updateCells.rows[0].values.length,26);
});
test('publication journal holds unknown writes and requires complete verified projections',()=>{
 const h=expenseSqlite(),db=h.sqlite;
 try{
  db.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_fixture','msg','owner','fixture',100,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_fixture',1,'trace','PROCESSING','now','2099-01-01T00:00:00.000Z','lease-token'); INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim-token','HELD','now','now')");
  const insert=db.prepare("INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at) VALUES(?,'book','exp_fixture',7,'pub',2,?,1,(SELECT revision FROM stable_source_revision WHERE singleton=1),?,'claim-token','lease-token',?,?,?,0,?,?,'IN_FLIGHT','now','now')");
  insert.run('stage-operation','STAGE','a'.repeat(64),'EMPTY','d'.repeat(32),staged.nonce,empty(2,'d'.repeat(32)),encode(staged));
  assert.throws(()=>insert.run('another-operation','STAGE','a'.repeat(64),'EMPTY','d'.repeat(32),staged.nonce,empty(2,'d'.repeat(32)),encode(staged)),/UNIQUE/);
  db.exec("UPDATE continuous_publication_intents SET state='VERIFIED',updated_at='later' WHERE transition_id='stage-operation'");
  db.prepare("INSERT INTO continuous_publication_markers(spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,version,state,marker,transition_id,created_at,updated_at) VALUES('book','exp_fixture',7,'pub',2,1,'STAGED',?,'stage-operation','now','now')").run(encode(staged));
  insert.run('publish-operation','PUBLISH','a'.repeat(64),'STAGED',staged.nonce,published.nonce,encode(staged),encode(published));
  assert.throws(()=>db.exec("UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='publish-operation'"),/complete source and projections/);
  for(const [projection,sheetId] of [['DAILY',8],['EXPENSE_RAW',9]])db.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_fixture',?,?,?,1,?,'claim-token','IN_FLIGHT','now')").run(projection,sheetId,projection,'a'.repeat(64));
  db.exec("UPDATE stable_projection_writes SET state='VERIFIED' WHERE entity_id='exp_fixture'; UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='publish-operation'");
  db.prepare("UPDATE continuous_publication_markers SET state='PUBLISHED',marker=?,transition_id='publish-operation',updated_at='later' WHERE entity_id='exp_fixture'").run(encode(published));
  assert.throws(()=>db.exec("DELETE FROM continuous_publication_markers WHERE entity_id='exp_fixture'"),/retained/);
  assert.throws(()=>db.prepare("UPDATE continuous_publication_markers SET state='REVOKED',version=2,marker=?,transition_id='publish-operation' WHERE entity_id='exp_fixture'").run(encode(revoked)),/transition invalid/);
 }finally{h.close();}
});
test('publication guard rejects wrong item identities even when the number matches',()=>{
 const h=expenseSqlite(),db=h.sqlite;
 try{
  db.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_fixture','msg','owner','fixture',100,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1); INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at) VALUES('doc','doc-msg','owner','receipt','CONFIRMED','now'); INSERT INTO expense_document_items(item_id,document_id,expense_id,description,created_at,updated_at) VALUES('item-a','doc','exp_fixture','a','now','now'),('item-b','doc','exp_fixture','b','now','now'); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_fixture',1,'trace','PROCESSING','now','2099-01-01T00:00:00.000Z','lease-token'); INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim-token','HELD','now','now')");
  const s={...staged,detailCount:2},p={...published,detailCount:2};
  const intent=db.prepare("INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at) VALUES(?,'book','exp_fixture',7,'pub',2,?,1,(SELECT revision FROM stable_source_revision WHERE singleton=1),?,'claim-token','lease-token',?,?,?,2,?,?,'IN_FLIGHT','now','now')");
  intent.run('stage-operation','STAGE','a'.repeat(64),'EMPTY','d'.repeat(32),s.nonce,empty(2,'d'.repeat(32)),encode(s));
  db.exec("UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='stage-operation'");
  db.prepare("INSERT INTO continuous_publication_markers(spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,version,state,marker,transition_id,created_at,updated_at) VALUES('book','exp_fixture',7,'pub',2,1,'STAGED',?,'stage-operation','now','now')").run(encode(s));
  intent.run('publish-operation','PUBLISH','a'.repeat(64),'STAGED',s.nonce,p.nonce,encode(s),encode(p));
  const projection=db.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE',?,?,7,'target',1,?,'claim-token','IN_FLIGHT','now')");
  for(const [id,kind] of [['exp_fixture','DAILY'],['exp_fixture','EXPENSE_RAW'],['exp_fixture|item-a','DETAIL'],['exp_fixture|item-wrong','DETAIL']])projection.run(id,kind,'a'.repeat(64));
  db.exec("UPDATE stable_projection_writes SET state='VERIFIED'");
  assert.throws(()=>db.exec("UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='publish-operation'"),/complete source and projections/);
 }finally{h.close();}
});
test('executor holds ambiguous writes and recovers only exact positive postimage',async()=>{
 let column=[['Publication_Marker'],[empty(2,'d'.repeat(32))],[empty(3,'e'.repeat(32))]],posts=0,commits=0,persisted=0;
 const intent={sheetId:7,row:2,rows:3,before:column[1][0],after:staged};
 const io={read:async()=>({formula:column.map(r=>r.slice()),effective:column.map(r=>r.slice())}),guard:async()=>true,persist:async()=>{persisted++;return true;},dispatch:async()=>{posts++;column[1]=[encode(staged)];throw Error('lost ACK');},commit:async()=>{commits++;return true;}};
 await assert.rejects(executePublicationIntent(intent,io),/OUTCOME_UNKNOWN/);
 assert.equal(posts,1);assert.equal(persisted,1);assert.equal(commits,0);
 await recoverPublicationIntent(intent,io);assert.equal(posts,1);assert.equal(commits,1);
 column[1]=[intent.before];await assert.rejects(recoverPublicationIntent(intent,io),/POSTIMAGE_UNVERIFIED/);assert.equal(posts,1);assert.equal(commits,1);
 column[1]=[encode(staged)];column[2]=[encode(staged)];await assert.rejects(recoverPublicationIntent(intent,io),/POSTIMAGE_UNVERIFIED/);assert.equal(commits,1);
});
test('executor does not dispatch when source guard changes after durable intent',async()=>{
 const column=[['Publication_Marker'],[empty(2,'d'.repeat(32))],[empty(3,'e'.repeat(32))]],intent={sheetId:7,row:2,rows:3,before:column[1][0],after:staged};let calls=0,posts=0;
 const io={read:async()=>({formula:column,effective:column}),guard:async()=>++calls===1,persist:async()=>true,dispatch:async()=>{posts++;},commit:async()=>true};
 await assert.rejects(executePublicationIntent(intent,io),/DISPATCH_UNVERIFIED/);assert.equal(posts,0);
});
test('Undo lost ACK never repeats revoke and only its exact revoked postimage recovers',async()=>{
 let column=[['Publication_Marker'],[encode(published)],[empty(3,'e'.repeat(32))]],posts=0,commits=0;
 const intent={sheetId:7,row:2,rows:3,before:encode(published),after:revoked};
 const io={read:async()=>({formula:column.map(r=>r.slice()),effective:column.map(r=>r.slice())}),guard:async()=>true,persist:async()=>true,dispatch:async()=>{posts++;column[1]=[encode(revoked)];throw Error('lost ACK');},commit:async()=>{commits++;return true;}};
 await assert.rejects(executePublicationIntent(intent,io),/OUTCOME_UNKNOWN/);assert.equal(posts,1);
 column[1]=[encode(published)];await assert.rejects(recoverPublicationIntent(intent,io),/POSTIMAGE_UNVERIFIED/);assert.equal(commits,0);
 column[1]=[encode(revoked)];await recoverPublicationIntent(intent,io);assert.equal(posts,1);assert.equal(commits,1);
});
test('review guard permits only positive exact recovery after expired lease under original epoch and claim',async()=>{
 const h=expenseSqlite(),db=h.sqlite;
 try{
  db.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_fixture','msg','owner','fixture',100,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_fixture',1,'trace','PROCESSING','now','2099-01-01T00:00:00.000Z','lease-token'); INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,created_at,updated_at) VALUES('book','claim-token','HELD','stamp','identity','now','now')");
  db.prepare("INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at) VALUES('stage-operation','book','exp_fixture',7,'pub',2,'STAGE',1,(SELECT revision FROM stable_source_revision WHERE singleton=1),?,'claim-token','lease-token','EMPTY',?,?,0,?,?,'IN_FLIGHT','now','now')").run('a'.repeat(64),'d'.repeat(32),staged.nonce,empty(2,'d'.repeat(32)),encode(staged));
  db.exec("UPDATE sync_jobs SET status='REVIEW',lease_until='2000-01-01T00:00:00.000Z'; UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION'");
  assert.throws(()=>db.exec("UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='stage-operation'"),/complete source and projections/);
  db.exec("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-123','book','ARMED','EXPENSE','exp_fixture',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token','epoch-123','ADMITTED','now')");
  let marker=empty(2,'d'.repeat(32)),posts=0,commits=0;const intent={sheetId:7,row:2,rows:2,before:marker,after:staged};
  const io={read:async()=>({formula:[['Publication_Marker'],[marker]],effective:[['Publication_Marker'],[marker]]}),guard:async()=>true,commit:async()=>{db.prepare("INSERT INTO continuous_publication_review_evidence(transition_id,source_revision,source_digest,created_at) VALUES('stage-operation',(SELECT revision FROM stable_source_revision WHERE singleton=1),?,'now')").run('a'.repeat(64));db.exec("UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='stage-operation'");commits++;return true;},dispatch:async()=>{posts++;}};
  await assert.rejects(recoverPublicationIntent(intent,io),/POSTIMAGE_UNVERIFIED/);assert.equal(commits,0);
  marker=encode(staged);await recoverPublicationIntent(intent,io);assert.equal(commits,1);assert.equal(posts,0);
  assert.equal(db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'REVIEW');
 }finally{h.close();}
});
test('review source reader requires exact publication intent, epoch, target, revision and fingerprint',async()=>{
 const h=expenseSqlite(),db=h.sqlite,env={...h.env,GOOGLE_SPREADSHEET_ID:'book'};
 try{
  db.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_fixture','msg','owner','fixture',100,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_fixture',1,'trace','PROCESSING','now','2099-01-01T00:00:00.000Z','lease-token'); INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,created_at,updated_at) VALUES('book','claim-token','HELD','stamp','identity','now','now')");
  const expense=db.prepare("SELECT * FROM expense_events WHERE expense_id='exp_fixture'").get(),digest=createHash('sha256').update(JSON.stringify({expense,links:[],documents:[],items:[]})).digest('hex');
  db.prepare("INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at) VALUES('stage-operation','book','exp_fixture',7,'pub',2,'STAGE',1,(SELECT revision FROM stable_source_revision WHERE singleton=1),?,'claim-token','lease-token','EMPTY',?,?,0,?,?,'IN_FLIGHT','now','now')").run(digest,'d'.repeat(32),staged.nonce,empty(2,'d'.repeat(32)),encode(staged));
  db.exec("UPDATE sync_jobs SET status='REVIEW',lease_until='2000-01-01T00:00:00.000Z'; UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-123','book','ARMED','EXPENSE','exp_fixture',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token','epoch-123','ADMITTED','now')");
  const batch=env.DB.batch.bind(env.DB);env.DB.batch=async statements=>(await batch(statements)).map(x=>({...x,success:true}));
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:1},target={sheetId:7,sheetName:'pub',row:2};
  const read=()=>readReviewedPublicationSource(env,job,'claim-token','stage-operation',target);
  const source=await read();assert.equal(source?.digest,digest);assert.equal(source?.kind,'STAGE');
  assert.equal(await readReviewedPublicationSource(env,job,'claim-token','wrong-operation',target),null);
  assert.equal(await readReviewedPublicationSource(env,job,'claim-token','stage-operation',{...target,row:3}),null);
  db.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_other','other-msg','owner','unrelated',100,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1)");const unrelated=await read();assert.equal(unrelated?.digest,digest);assert.ok(unrelated.revision>source.revision);
  db.exec("UPDATE expense_events SET description='changed' WHERE expense_id='exp_fixture'");assert.equal(await read(),null);
 }finally{h.close();}
});
test('review source reader checks cancelled source for exact REVOKE intent',async()=>{
 const h=expenseSqlite(),db=h.sqlite,env={...h.env,GOOGLE_SPREADSHEET_ID:'book'};
 try{
  db.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_fixture','msg','owner','fixture',100,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_fixture',1,'trace','PROCESSING','now','2099-01-01T00:00:00.000Z','lease-token'); INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,created_at,updated_at) VALUES('book','claim-token','HELD','stamp','identity','now','now')");
  const insert=db.prepare("INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at) VALUES(?,'book','exp_fixture',7,'pub',2,?,1,(SELECT revision FROM stable_source_revision WHERE singleton=1),?,'claim-token','lease-token',?,?,?,0,?,?,'IN_FLIGHT','now','now')");
  insert.run('stage-operation','STAGE','a'.repeat(64),'EMPTY','d'.repeat(32),staged.nonce,empty(2,'d'.repeat(32)),encode(staged));
  db.exec("UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='stage-operation'");
  db.prepare("INSERT INTO continuous_publication_markers(spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,version,state,marker,transition_id,created_at,updated_at) VALUES('book','exp_fixture',7,'pub',2,1,'STAGED',?,'stage-operation','now','now')").run(encode(staged));
  insert.run('publish-operation','PUBLISH','a'.repeat(64),'STAGED',staged.nonce,published.nonce,encode(staged),encode(published));
  for(const [projection,sheetId] of [['DAILY',8],['EXPENSE_RAW',9]])db.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_fixture',?,?,?,1,?,'claim-token','IN_FLIGHT','now')").run(projection,sheetId,projection,'a'.repeat(64));
  db.exec("UPDATE stable_projection_writes SET state='VERIFIED'; UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='publish-operation'");
  db.prepare("UPDATE continuous_publication_markers SET state='PUBLISHED',marker=?,transition_id='publish-operation' WHERE entity_id='exp_fixture'").run(encode(published));
  db.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_fixture'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('undo','EXPENSE','exp_fixture',2,'trace','PROCESSING','now','2099-01-01T00:00:00.000Z','lease-token')");
  const expense=db.prepare("SELECT * FROM expense_events WHERE expense_id='exp_fixture'").get(),digest=createHash('sha256').update(JSON.stringify({expense,links:[],documents:[],items:[]})).digest('hex');
  db.prepare("INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at) VALUES('revoke-operation','book','exp_fixture',7,'pub',2,'REVOKE',2,(SELECT revision FROM stable_source_revision WHERE singleton=1),?,'claim-token','lease-token','PUBLISHED',?,?,0,?,?,'IN_FLIGHT','now','now')").run(digest,published.nonce,revoked.nonce,encode(published),encode(revoked));
  db.exec("UPDATE sync_jobs SET status='REVIEW',lease_until=NULL,lease_token=NULL WHERE entity_version=2; UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-123','book','ARMED','EXPENSE','exp_fixture',2,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token','epoch-123','ADMITTED','now')");
  const batch=env.DB.batch.bind(env.DB);env.DB.batch=async statements=>(await batch(statements)).map(x=>({...x,success:true}));
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_fixture',entityVersion:2},target={sheetId:7,sheetName:'pub',row:2};
  const read=()=>readReviewedPublicationSource(env,job,'claim-token','revoke-operation',target);
  assert.equal((await read())?.digest,digest);assert.equal((await read())?.kind,'REVOKE');
  db.exec("UPDATE expense_events SET description='changed' WHERE expense_id='exp_fixture'");assert.equal(await read(),null);
 }finally{h.close();}
});
