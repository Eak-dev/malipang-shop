import {cutoverReadySql} from './helpers/cutover-ready.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),route=require('../dist/sheets/continuous-daily-route.js'),cutover=require('../dist/sheets/continuous-daily-cutover.js'),sourceReader=require('../dist/sheets/stable-expense-source.js'),claims=require('../dist/sheets/stable-workbook-claim.js'),{writeCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-writer.js'),{cancelCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-cancellation.js'),{ledgerCarrierFormulas,ledgerCarrierMarker,decodeLedgerCarrier,ledgerCarrierDisplay,rawCarrierHeaders,detailCarrierHeaders}=require('../dist/sheets/atomic-expense-ledger-template.js');
const notice=require('../dist/sheets/stable-edit-notice.js'),health=require('../dist/sheets/continuous-report-health.js'),{verifyReviewedLedgerProjection}=require('../dist/sheets/continuous-ledger-positive-recovery.js');
// Test-only stub: lifecycle tests simulate an already admitted readiness gate.
// The real, currently fail-closed gate is covered in continuous-notice-readiness.test.mjs.
const simulatedReadiness=require('../dist/sheets/continuous-notice-readiness.js');
simulatedReadiness.noticeReadinessFingerprint=async()=> 'f'.repeat(64);
simulatedReadiness.noticeReadinessReady=async()=>true;
simulatedReadiness.noticeReadinessSql='(? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL)';
function fixture(projection='EXPENSE_RAW'){
 const h=expenseSqlite(),old={grid:client.getSheetGridInfo,formula:client.batchGetSheetFormulaValues,effective:client.batchGetSheetEffectiveSerialValues,write:client.batchUpdateSpreadsheetWithReply,activated:route.assertContinuousDailyActivated,target:route.continuousDailyTarget,cutover:cutover.chooseContinuousDailyCutover,source:sourceReader.readStableExpenseSource,reviewSource:sourceReader.readReviewedLedgerExpenseSource,claim:claims.stableWorkbookClaimOwned,paused:notice.stableNoticePaused,health:health.readContinuousReportHealth},prepare=h.DB.prepare,batch=h.DB.batch;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run,all=s.all;s.run=async function(){return{...await run.call(this),success:true}};s.all=async function(){return{...await all.call(this),success:true}};return s};h.DB.batch=async function(s){return(await batch.call(this,s)).map(r=>({...r,success:true}))};
 Object.assign(h.env,{APP_ENV:'test',RUNTIME_MODE:'shadow',STABLE_PHASE1_ENABLED:'true',STABLE_CANCELLATION_PREIMAGE_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'daily_new',CONTINUOUS_DAILY_SHEET_ID:'8',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'9',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'10',GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'daily_old',SHEET_EXPENSE_RAW:'raw_old',SHEET_PURCHASE_DETAILS:'detail_old'});
 h.sqlite.exec(`UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'; INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim-token','HELD','now','now'); INSERT INTO continuous_daily_cutovers(spreadsheet_id,legacy_sheet_id,legacy_sheet_name,continuous_sheet_id,continuous_sheet_name,raw_sheet_id,raw_sheet_name,detail_sheet_id,detail_sheet_name,claim_token,source_revision,state,prepared_at) SELECT 'book',7,'daily_old',8,'daily_new',9,'raw_new',10,'detail_new','claim-token',revision,'PREPARED','now' FROM stable_source_revision WHERE singleton=1; ${cutoverReadySql('claim-token')} UPDATE continuous_daily_cutovers SET state='ACTIVE',activated_at='now' WHERE spreadsheet_id='book'; INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_test','message','owner','=literal',10000,'transfer','SHOP_BANK','ingredients','2026-10-09','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_test',1,'fixture','PROCESSING','now','2099-01-01T00:00:00.000Z','lease'); INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_test','DAILY',8,'daily_new',1,'${'a'.repeat(64)}','daily-token','IN_FLIGHT','now'); UPDATE stable_projection_writes SET state='VERIFIED' WHERE projection='DAILY';`);
 const source={expense:{...h.sqlite.prepare('SELECT * FROM expense_events').get()},links:[],documents:[],items:[],revision:h.sqlite.prepare('SELECT revision FROM stable_source_revision').get().revision,digest:'a'.repeat(64),fingerprint:'same'};
 if(projection==='DETAIL'){source.links=[{relation_type:'PRIMARY_PURCHASE_DOCUMENT',document_id:'doc_1'}];source.documents=[{document_id:'doc_1',document_type:'RECEIPT',vendor_name:'shop',document_date:'2026-10-09'}];source.items=[{item_id:'item_1',document_id:'doc_1',expense_id:'exp_test',description:'item',quantity:1,line_total_satang:10000}];}
 route.continuousDailyTarget=()=>({sheet:'daily_new',sheetId:8});route.assertContinuousDailyActivated=async()=>({sheet:'daily_new',sheetId:8});cutover.chooseContinuousDailyCutover=async()=>({status:'CONTINUOUS',sheet:'daily_new',sheetId:8});sourceReader.readStableExpenseSource=async()=>source;sourceReader.readReviewedLedgerExpenseSource=async()=>source;claims.stableWorkbookClaimOwned=async()=>true;notice.stableNoticePaused=async()=>true;health.readContinuousReportHealth=async()=>'OK';
 let len=6;const empty=()=>Array(26).fill(null),f=Array.from({length:len},empty),e=Array.from({length:len},empty),sheetId=projection==='DETAIL'?10:9;
 (projection==='DETAIL'?detailCarrierHeaders:[...rawCarrierHeaders,'Sales_Addback_Basis']).forEach((x,i)=>{f[0][i]=e[0][i]=x});
 for(let r=2;r<=len;r++){Object.assign(f[r-1],ledgerCarrierFormulas(projection,r));f[r-1][25]=e[r-1][25]=ledgerCarrierMarker(r);}
 let writes=0,mode='ok';client.getSheetGridInfo=async()=>({sheetId,rowCount:len,columnCount:26});client.batchGetSheetFormulaValues=async()=>[f.map(r=>r.slice())];client.batchGetSheetEffectiveSerialValues=async()=>[e.map(r=>r.slice())];
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before)=>{if(mode==='race')f[1][17]='manual';await before();if(requests[0].appendCells){const cells=requests[0].appendCells.rows[0].values,fr=empty(),er=empty();for(let c=0;c<26;c++){const v=cells[c]?.userEnteredValue;if(v?.formulaValue)fr[c]=v.formulaValue;else if(v?.stringValue)fr[c]=er[c]=v.stringValue}const decoded=decodeLedgerCarrier(fr[25]);ledgerCarrierDisplay(decoded).forEach((v,c)=>{er[c]=v});if(mode==='append-addback-race')fr[17]=er[17]='ACCUMULATED_CASH';if(mode==='append-extra-race')fr[projection==='DETAIL'?20:18]=er[projection==='DETAIL'?20:18]='unexpected';f.push(fr);e.push(er);len++;writes++;if(mode==='timeout')throw Error('lost response');return{replies:[{}]};}const change=requests[0].findReplace,i=change.range.startRowIndex;assert.equal(change.range.startColumnIndex,25);if(f[i][25]!==change.find)return{replies:[{findReplace:{}}]};writes++;f[i][25]=e[i][25]=change.replacement;const decoded=decodeLedgerCarrier(change.replacement);ledgerCarrierDisplay(decoded).forEach((v,c)=>{e[i][c]=v});if(mode==='timeout')throw Error('lost response');return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]}};
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:1,traceId:'fixture'};
 const cancelled={...job,entityVersion:2};
 return {...h,f,e,source,job,cancelled,readActualReviewedSource:()=>old.reviewSource(h.env,job,'claim-token',projection,projection==='DETAIL'?'exp_test|item_1':'exp_test'),run:()=>writeCarrierLedgerUnderClaim(h.env,job,'lease','claim-token',source,projection,projection==='DETAIL'?'item_1':undefined),prepareCancel(){h.sqlite.exec("UPDATE sync_jobs SET status='COMPLETED' WHERE job_id='job'; UPDATE expense_events SET status='CANCELLED',version=2,updated_at='2026-11-15T00:00:00.000Z' WHERE expense_id='exp_test'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('cancel','EXPENSE','exp_test',2,'fixture','PROCESSING','now','2099-01-01T00:00:00.000Z','lease')")},cancel:()=>cancelCarrierLedgerUnderClaim(h.env,cancelled,'lease','claim-token',projection,projection==='DETAIL'?'item_1':undefined),writes:()=>writes,setMode:x=>{mode=x},unmockGate(){route.continuousDailyTarget=old.target;route.assertContinuousDailyActivated=old.activated;h.env.CONTINUOUS_RAW_SHEET_ID='999'},close(){Object.assign(client,{getSheetGridInfo:old.grid,batchGetSheetFormulaValues:old.formula,batchGetSheetEffectiveSerialValues:old.effective,batchUpdateSpreadsheetWithReply:old.write});route.continuousDailyTarget=old.target;route.assertContinuousDailyActivated=old.activated;cutover.chooseContinuousDailyCutover=old.cutover;sourceReader.readStableExpenseSource=old.source;sourceReader.readReviewedLedgerExpenseSource=old.reviewSource;claims.stableWorkbookClaimOwned=old.claim;notice.stableNoticePaused=old.paused;health.readContinuousReportHealth=old.health;h.close()}};
}
for(const projection of ['EXPENSE_RAW','DETAIL'])test(`${projection} carrier append verifies values, marker, journal and preimage`,async()=>{const h=fixture(projection);try{
 await h.run();assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare('SELECT state FROM stable_projection_writes WHERE projection=?').get(projection).state,'VERIFIED');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_expense_projection_preimages').get().n,1);await h.run();assert.equal(h.writes(),1);
}finally{h.close()}});
test('unacknowledged append remains IN_FLIGHT and replay does not write',async()=>{const h=fixture();try{
 h.setMode('timeout');await assert.rejects(h.run(),/lost response/);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='EXPENSE_RAW'").get().state,'IN_FLIGHT');await assert.rejects(h.run(),/LEDGER_AUTH_IN_FLIGHT/);assert.equal(h.writes(),1);
}finally{h.close()}});
test('owner addback below markers is preserved and append occurs after it',async()=>{const h=fixture();try{
 h.f[2][17]=h.e[2][17]='ACCUMULATED_CASH';await h.run();assert.equal(h.f[2][17],'ACCUMULATED_CASH');assert.ok(decodeLedgerCarrier(h.f[3][25]));
}finally{h.close()}});
test('real isolation gate blocks experimental ledger writer',async()=>{const h=fixture();try{h.unmockGate();await assert.rejects(h.run(),/CONTINUOUS_DAILY_NOT_READY/);assert.equal(h.writes(),0)}finally{h.close()}});
for(const projection of ['EXPENSE_RAW','DETAIL'])test(`${projection} cancellation changes only unique carrier and verifies displayed status`,async()=>{const h=fixture(projection);try{
 await h.run();h.prepareCancel();await h.cancel();assert.equal(h.writes(),2);const value=decodeLedgerCarrier(h.f[1][25]);assert.equal(value.status,'CANCELLED');assert.equal(h.e[1][projection==='DETAIL'?16:7],'CANCELLED');if(projection==='DETAIL')assert.equal(h.e[1][19],'2026-11-15T00:00:00.000Z');assert.equal(h.sqlite.prepare('SELECT state FROM stable_expense_cancellation_writes').get().state,'VERIFIED');await assert.rejects(h.cancel(),/LEDGER_CANCEL_PRIOR_REVIEW/);assert.equal(h.writes(),2);
}finally{h.close()}});
test('unknown cancellation response retains IN_FLIGHT and cannot blindly replay',async()=>{const h=fixture();try{
 await h.run();h.prepareCancel();h.setMode('timeout');await assert.rejects(h.cancel(),/lost response/);assert.equal(h.sqlite.prepare('SELECT state FROM stable_expense_cancellation_writes').get().state,'IN_FLIGHT');await assert.rejects(h.cancel(),/LEDGER_CANCEL_PRIOR_REVIEW/);assert.equal(h.writes(),2);
}finally{h.close()}});
test('manually changed RAW addback is preserved when cancellation succeeds',async()=>{const h=fixture();try{
 await h.run();h.prepareCancel();h.f[1][17]=h.e[1][17]='ACCUMULATED_CASH';await h.cancel();assert.equal(h.f[1][17],'ACCUMULATED_CASH');assert.equal(h.e[1][17],'ACCUMULATED_CASH');assert.equal(h.e[1][7],'CANCELLED');assert.equal(h.writes(),2);
}finally{h.close()}});
test('RAW addback edited just before dispatch is never overwritten',async()=>{const h=fixture();try{
 await h.run();h.prepareCancel();h.setMode('race');await assert.rejects(h.cancel(),/LEDGER_CANCEL_PRE_DISPATCH_CHANGED/);assert.equal(h.f[1][17],'manual');assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare('SELECT state FROM stable_expense_cancellation_writes').get().state,'IN_FLIGHT');
}finally{h.close()}});
for(const projection of ['EXPENSE_RAW','DETAIL'])test(`${projection} expands with appendCells, verifies preimage, and cancels appended carrier`,async()=>{const h=fixture(projection);try{
 const ownerCol=projection==='DETAIL'?20:17;h.f[5][ownerCol]=h.e[5][ownerCol]='owner';await h.run();assert.equal(h.writes(),1);assert.ok(decodeLedgerCarrier(h.f[6][25]));assert.match(h.f[6][0],/ROW\(\)/);h.prepareCancel();await h.cancel();assert.equal(h.e[6][projection==='DETAIL'?16:7],'CANCELLED');assert.equal(h.f[5][ownerCol],'owner');assert.equal(h.writes(),2);
}finally{h.close()}});
test('unknown appendCells response remains IN_FLIGHT without another append',async()=>{const h=fixture();try{
 h.f[5][17]=h.e[5][17]='owner';h.setMode('timeout');await assert.rejects(h.run(),/lost response/);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='EXPENSE_RAW'").get().state,'IN_FLIGHT');await assert.rejects(h.run(),/LEDGER_AUTH_IN_FLIGHT/);assert.equal(h.writes(),1);
}finally{h.close()}});
test('owner addback inserted during overflow append never yields a trusted preimage',async()=>{const h=fixture();try{
 h.f[5][17]=h.e[5][17]='owner';h.setMode('append-addback-race');await assert.rejects(h.run(),/LEDGER_CARRIER_READBACK_UNCERTAIN/);assert.equal(h.f[6][17],'ACCUMULATED_CASH');assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='EXPENSE_RAW'").get().state,'IN_FLIGHT');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_expense_projection_preimages').get().n,0);
}finally{h.close()}});
test('a fabricated valid-looking other carrier is rejected without a trusted journal',async()=>{const h=fixture();try{
 await h.run();const forged=decodeLedgerCarrier(h.f[1][25]);forged.expenseId='exp_other';forged.values[0]='exp_other';const encoded=require('../dist/sheets/atomic-expense-ledger-template.js').encodeLedgerCarrier(forged);h.f[2][25]=h.e[2][25]=encoded;ledgerCarrierDisplay(forged).forEach((v,c)=>{h.e[2][c]=v});await assert.rejects(h.run(),/LEDGER_AUTH_JOURNAL/);assert.equal(h.writes(),1);
}finally{h.close()}});
test('erasing a verified carrier is held even if its old marker is restored',async()=>{const h=fixture();try{
 const marker=h.f[1][25];await h.run();h.f[1][25]=h.e[1][25]=marker;for(let c=0;c<17;c++)h.e[1][c]='';await assert.rejects(h.run(),/LEDGER_AUTH_MISSING/);assert.equal(h.writes(),1);
}finally{h.close()}});

function holdLedgerReview(h,version){
 Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});
 h.sqlite.prepare("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-ledger','book','ARMED','EXPENSE','exp_test',?,'now','now')").run(version);
 h.sqlite.prepare("INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token','epoch-ledger','ADMITTED','now')").run();
 h.sqlite.exec("UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',notice_stamp='stamp',notice_identity='identity' WHERE spreadsheet_id='book'");
 h.sqlite.prepare("UPDATE sync_jobs SET status='REVIEW',lease_token=NULL,lease_until=NULL,last_error='STABLE_SYNC_REVIEW' WHERE entity_type='EXPENSE' AND entity_key='exp_test' AND entity_version=?").run(version);
}
function addLinkedCancelSource(h){h.sqlite.exec("INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at) VALUES('doc_linked','doc_message','owner','RECEIPT','CANCELLED','now'); INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES('link_1','exp_test','doc_linked','SUPPORTING_DOCUMENT','MANUAL','now'); INSERT INTO expense_document_items(item_id,document_id,description,created_at,updated_at) VALUES('item_linked','doc_linked','before','now','now')");}
function addOtherExpense(h){h.sqlite.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_other','other_message','owner','other',100,'transfer','SHOP_BANK','ingredients','2026-10-09','CONFIRMED','now',1)");}
for(const projection of ['EXPENSE_RAW','DETAIL'])test(`${projection} Undo recovery accepts unrelated prior source changes`,async()=>{const h=fixture(projection);try{
 await h.run();h.prepareCancel();addLinkedCancelSource(h);h.setMode('timeout');await assert.rejects(h.cancel(),/lost response/);holdLedgerReview(h,2);addOtherExpense(h);
 assert.equal(await verifyReviewedLedgerProjection(h.env,h.cancelled,'claim-token',projection,'CANCEL',projection==='DETAIL'?'item_1':undefined),true);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_expense_cancellation_writes').get().state,'VERIFIED');assert.equal(h.writes(),2);
 }finally{h.close();}});
for(const mutation of ["UPDATE expense_events SET description='changed' WHERE expense_id='exp_test'","UPDATE expense_documents SET status='CHANGED' WHERE document_id='doc_linked'","UPDATE expense_document_items SET description='changed' WHERE item_id='item_linked'","DELETE FROM expense_document_links WHERE link_id='link_1'"])test(`RAW Undo recovery refuses changed target or linked source: ${mutation.split(' ')[1]}`,async()=>{const h=fixture();try{
 await h.run();h.prepareCancel();addLinkedCancelSource(h);h.setMode('timeout');await assert.rejects(h.cancel(),/lost response/);holdLedgerReview(h,2);h.sqlite.exec(mutation);
 assert.equal(await verifyReviewedLedgerProjection(h.env,h.cancelled,'claim-token','EXPENSE_RAW','CANCEL'),false);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_expense_cancellation_writes').get().state,'IN_FLIGHT');assert.equal(h.writes(),2);
 }finally{h.close();}});
test('RAW Undo recovery refuses a target mutation between source snapshot and CAS',async()=>{const h=fixture();try{
 await h.run();h.prepareCancel();addLinkedCancelSource(h);h.setMode('timeout');await assert.rejects(h.cancel(),/lost response/);holdLedgerReview(h,2);
 let checks=0;notice.stableNoticePaused=async()=>{if(++checks===2)h.sqlite.exec("UPDATE expense_document_items SET description='racing' WHERE item_id='item_linked'");return true;};
 await assert.rejects(verifyReviewedLedgerProjection(h.env,h.cancelled,'claim-token','EXPENSE_RAW','CANCEL'),/LEDGER_POSITIVE_VERIFY_UNCERTAIN/);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_expense_cancellation_writes').get().state,'IN_FLIGHT');assert.equal(h.writes(),2);
 }finally{h.close();}});
test('RAW Undo recovery safely retries read-only after an unrelated source races the CAS',async()=>{const h=fixture();try{
 await h.run();h.prepareCancel();h.setMode('timeout');await assert.rejects(h.cancel(),/lost response/);holdLedgerReview(h,2);
 let checks=0;notice.stableNoticePaused=async()=>{if(++checks===2)addOtherExpense(h);return true;};
 await assert.rejects(verifyReviewedLedgerProjection(h.env,h.cancelled,'claim-token','EXPENSE_RAW','CANCEL'),/LEDGER_POSITIVE_VERIFY_UNCERTAIN/);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_expense_cancellation_writes').get().state,'IN_FLIGHT');
 assert.equal(await verifyReviewedLedgerProjection(h.env,h.cancelled,'claim-token','EXPENSE_RAW','CANCEL'),true);assert.equal(h.writes(),2);
 }finally{h.close();}});
for(const projection of ['EXPENSE_RAW','DETAIL'])for(const mode of ['REPLACE','APPEND'])test(`${projection} ${mode} lost confirmation ACK verifies exact positive readback without releasing review`,async()=>{const h=fixture(projection);try{
 if(mode==='APPEND'){const col=projection==='DETAIL'?20:17;h.f[5][col]=h.e[5][col]='owner-input';}
 h.setMode('timeout');await assert.rejects(h.run(),/lost response/);holdLedgerReview(h,1);
 const proof=h.sqlite.prepare("SELECT * FROM continuous_ledger_write_evidence WHERE projection=? AND operation_kind='CONFIRM'").get(projection),actual=decodeLedgerCarrier(h.f[proof.target_row-1][25]);
 assert.equal(proof.write_mode,mode);assert.equal(actual.writeMarker,proof.marker);assert.equal(await verifyReviewedLedgerProjection(h.env,h.job,'claim-token',projection,'CONFIRM',projection==='DETAIL'?'item_1':undefined),true);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_projection_writes WHERE projection=?').get(projection).state,'VERIFIED');
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.sqlite.prepare("SELECT state FROM stable_recovery_epochs WHERE epoch_id='epoch-ledger'").get().state,'ARMED');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');assert.equal(h.writes(),1);
 assert.equal(await verifyReviewedLedgerProjection(h.env,h.job,'claim-token',projection,'CONFIRM',projection==='DETAIL'?'item_1':undefined),true);assert.equal(h.writes(),1);
 h.f[proof.target_row-1][25]='tampered';assert.equal(await verifyReviewedLedgerProjection(h.env,h.job,'claim-token',projection,'CONFIRM',projection==='DETAIL'?'item_1':undefined),false);
 }finally{h.close();}});
for(const projection of ['EXPENSE_RAW','DETAIL'])test(`${projection} positive recovery forwards its request policy to nested readers`,async()=>{const h=fixture(projection);try{
 h.setMode('timeout');await assert.rejects(h.run(),/lost response/);holdLedgerReview(h,1);
 const budget={},policy={kind:'continuous-expense',budget},seen=new Set();
 for(const name of ['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues']){const next=client[name];client[name]=async(...args)=>{assert.equal(args[2],policy,name);seen.add(name);return next(...args);};}
 const nextHealth=health.readContinuousReportHealth;health.readContinuousReportHealth=async(...args)=>{assert.equal(args[3],policy);seen.add('health');return nextHealth(...args);};
 const nextNotice=notice.stableNoticePaused;notice.stableNoticePaused=async(...args)=>{assert.equal(args[3],budget);seen.add('notice');return nextNotice(...args);};
 assert.equal(await verifyReviewedLedgerProjection(h.env,h.job,'claim-token',projection,'CONFIRM',projection==='DETAIL'?'item_1':undefined,'PAUSED',policy),true);
 assert.deepEqual([...seen].sort(),['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','health','notice'].sort());
 }finally{h.close();}});
for(const projection of ['EXPENSE_RAW','DETAIL'])test(`${projection} append rejects unexpected non-formula cells in normal readback`,async()=>{const h=fixture(projection);try{
 const ownerCol=projection==='DETAIL'?20:17;h.f[5][ownerCol]=h.e[5][ownerCol]='owner';h.setMode('append-extra-race');
 await assert.rejects(h.run(),/LEDGER_CARRIER_READBACK_UNCERTAIN/);assert.equal(h.sqlite.prepare('SELECT state FROM stable_projection_writes WHERE projection=?').get(projection).state,'IN_FLIGHT');assert.equal(h.writes(),1);
 }finally{h.close();}});
for(const projection of ['EXPENSE_RAW','DETAIL'])test(`${projection} append positive recovery rejects unexpected non-formula cells`,async()=>{const h=fixture(projection);try{
 const ownerCol=projection==='DETAIL'?20:17,extraCol=projection==='DETAIL'?20:18;h.f[5][ownerCol]=h.e[5][ownerCol]='owner';h.setMode('timeout');await assert.rejects(h.run(),/lost response/);holdLedgerReview(h,1);
 const proof=h.sqlite.prepare("SELECT * FROM continuous_ledger_write_evidence WHERE projection=? AND operation_kind='CONFIRM'").get(projection);assert.equal(proof.write_mode,'APPEND');
 h.f[proof.target_row-1][extraCol]=h.e[proof.target_row-1][extraCol]='unexpected';
 assert.equal(await verifyReviewedLedgerProjection(h.env,h.job,'claim-token',projection,'CONFIRM',projection==='DETAIL'?'item_1':undefined),false);assert.equal(h.sqlite.prepare('SELECT state FROM stable_projection_writes WHERE projection=?').get(projection).state,'IN_FLIGHT');assert.equal(h.writes(),1);
 }finally{h.close();}});
test('reviewed RAW append refuses an owner addback entered before recovery',async()=>{const h=fixture('EXPENSE_RAW');try{
 h.f[5][17]=h.e[5][17]='owner-input';h.setMode('timeout');await assert.rejects(h.run(),/lost response/);holdLedgerReview(h,1);
 const proof=h.sqlite.prepare("SELECT * FROM continuous_ledger_write_evidence WHERE projection='EXPENSE_RAW' AND operation_kind='CONFIRM'").get();
 assert.equal(proof.write_mode,'APPEND');h.f[proof.target_row-1][17]=h.e[proof.target_row-1][17]=100;
 assert.equal(await verifyReviewedLedgerProjection(h.env,h.job,'claim-token','EXPENSE_RAW','CONFIRM'),false);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='EXPENSE_RAW'").get().state,'IN_FLIGHT');assert.equal(h.writes(),1);
 }finally{h.close();}});
for(const projection of ['EXPENSE_RAW','DETAIL'])test(`${projection} lost cancellation ACK verifies exact positive readback and preserves addback`,async()=>{const h=fixture(projection);try{
 await h.run();h.prepareCancel();if(projection==='EXPENSE_RAW')h.f[1][17]=h.e[1][17]='owner-input';h.setMode('timeout');await assert.rejects(h.cancel(),/lost response/);holdLedgerReview(h,2);
 const proof=h.sqlite.prepare("SELECT * FROM continuous_ledger_write_evidence WHERE projection=? AND operation_kind='CANCEL'").get(projection),actual=decodeLedgerCarrier(h.f[proof.target_row-1][25]);assert.equal(actual.cancelMarker,proof.marker);
 assert.equal(await verifyReviewedLedgerProjection(h.env,h.cancelled,'claim-token',projection,'CANCEL',projection==='DETAIL'?'item_1':undefined),true);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_expense_cancellation_writes WHERE projection=?').get(projection).state,'VERIFIED');
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='cancel'").get().status,'REVIEW');assert.equal(h.writes(),2);
 assert.equal(await verifyReviewedLedgerProjection(h.env,h.cancelled,'claim-token',projection,'CANCEL',projection==='DETAIL'?'item_1':undefined),true);assert.equal(h.writes(),2);
 if(projection==='EXPENSE_RAW')assert.equal(h.f[1][17],'owner-input');
 }finally{h.close();}});
test('ledger Undo reverify after a crash rejects a changed linked item',async()=>{const h=fixture();try{
 await h.run();h.prepareCancel();addLinkedCancelSource(h);h.setMode('timeout');await assert.rejects(h.cancel(),/lost response/);holdLedgerReview(h,2);
 assert.equal(await verifyReviewedLedgerProjection(h.env,h.cancelled,'claim-token','EXPENSE_RAW','CANCEL'),true);
 h.sqlite.exec("UPDATE expense_document_items SET description='changed' WHERE item_id='item_linked'");
 assert.equal(await verifyReviewedLedgerProjection(h.env,h.cancelled,'claim-token','EXPENSE_RAW','CANCEL'),false);assert.equal(h.writes(),2);
 }finally{h.close();}});
for(const kind of ['CONFIRM','CANCEL'])for(const mode of ['absent','unaffected','notice'])test(`${kind} does not treat ${mode} as positive evidence or replay`,async()=>{const h=fixture();try{
 if(kind==='CANCEL'){await h.run();h.prepareCancel();}h.setMode('timeout');await assert.rejects(kind==='CANCEL'?h.cancel():h.run(),/lost response/);holdLedgerReview(h,kind==='CANCEL'?2:1);
 if(mode==='absent')h.f[1][25]=null;if(mode==='unaffected')h.f[2][0]='=tampered';if(mode==='notice')notice.stableNoticePaused=async()=>false;
 assert.equal(await verifyReviewedLedgerProjection(h.env,kind==='CANCEL'?h.cancelled:h.job,'claim-token','EXPENSE_RAW',kind),false);
 const table=kind==='CONFIRM'?'stable_projection_writes':'stable_expense_cancellation_writes';assert.equal(h.sqlite.prepare(`SELECT state FROM ${table} WHERE projection='EXPENSE_RAW'`).get().state,'IN_FLIGHT');
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.writes(),kind==='CANCEL'?2:1);
 }finally{h.close();}});
test('reviewed RAW cancellation detects a concurrent change to the owner addback',async()=>{const h=fixture();try{
 await h.run();h.prepareCancel();h.f[1][17]=h.e[1][17]='before';h.setMode('timeout');await assert.rejects(h.cancel(),/lost response/);holdLedgerReview(h,2);
 h.f[1][17]=h.e[1][17]='after';assert.equal(await verifyReviewedLedgerProjection(h.env,h.cancelled,'claim-token','EXPENSE_RAW','CANCEL'),false);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_expense_cancellation_writes WHERE projection='EXPENSE_RAW'").get().state,'IN_FLIGHT');assert.equal(h.writes(),2);
 }finally{h.close();}});
test('reviewed confirmation CAS rejects another uncertain projection created after provider read',async()=>{const h=fixture();try{
 h.setMode('timeout');await assert.rejects(h.run(),/lost response/);holdLedgerReview(h,1);let reads=0;
 notice.stableNoticePaused=async()=>{if(++reads===2)h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_test|item_race','DETAIL',10,'detail_new',1,?,'race-token','IN_FLIGHT','now')").run('a'.repeat(64));return true;};
 await assert.rejects(verifyReviewedLedgerProjection(h.env,h.job,'claim-token','EXPENSE_RAW','CONFIRM'));
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='EXPENSE_RAW'").get().state,'IN_FLIGHT');
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.writes(),1);
 }finally{h.close();}});
test('actual reviewed source reader is restricted to the exact held job and immutable evidence',async()=>{const h=fixture();try{
 h.setMode('timeout');await assert.rejects(h.run(),/lost response/);holdLedgerReview(h,1);
 const actual=await h.readActualReviewedSource();assert.equal(actual.expense.expense_id,'exp_test');assert.equal(actual.expense.status,'CONFIRMED');assert.match(actual.digest,/^[0-9a-f]{64}$/);
 h.sqlite.exec("UPDATE sync_jobs SET status='PENDING' WHERE job_id='job'");assert.equal(await h.readActualReviewedSource(),null);
 h.sqlite.exec("UPDATE sync_jobs SET status='REVIEW' WHERE job_id='job'; UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_test'");assert.equal(await h.readActualReviewedSource(),null);
 }finally{h.close();}});
for(const projection of ['EXPENSE_RAW','DETAIL'])test(`opt-in actual ${projection} confirm atomically commits handoff`,async()=>{const h=fixture(projection);try{
 Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true'});h.sqlite.exec("UPDATE stable_workbook_claims SET notice_stamp='stamp',notice_identity='identity' WHERE operation_token='claim-token'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-fixture','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token','epoch-fixture','ADMITTED','now')");await h.run();assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE operation_token='claim-token'").get().state,'VERIFIED');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_version=1").get().status,'PENDING');assert.equal(h.sqlite.prepare('SELECT operation_kind FROM continuous_normal_notice_handoffs').get().operation_kind,'CONFIRM');assert.equal(await verifyReviewedLedgerProjection(h.env,h.job,'claim-token',projection,'CONFIRM',projection==='DETAIL'?'item_1':undefined,'PAUSED',undefined,'HANDOFF'),true);
 }finally{h.close();}});
for(const projection of ['EXPENSE_RAW','DETAIL'])test(`opt-in actual ${projection} Undo atomically commits handoff`,async()=>{const h=fixture(projection);try{
 await h.run();h.prepareCancel();Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true'});h.sqlite.exec("UPDATE stable_workbook_claims SET operation_token='claim-token-cancel',notice_stamp='stamp',notice_identity='identity' WHERE operation_token='claim-token'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-fixture','book','ARMED','EXPENSE','exp_test',2,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-cancel','epoch-fixture','ADMITTED','now')");await cancelCarrierLedgerUnderClaim(h.env,h.cancelled,'lease','claim-token-cancel',projection,projection==='DETAIL'?'item_1':undefined);assert.equal(h.writes(),2);assert.equal(h.sqlite.prepare('SELECT state FROM stable_expense_cancellation_writes').get().state,'VERIFIED');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE entity_version=2").get().status,'PENDING');assert.equal(h.sqlite.prepare('SELECT operation_kind FROM continuous_normal_notice_handoffs').get().operation_kind,'CANCEL');assert.equal(await verifyReviewedLedgerProjection(h.env,h.cancelled,'claim-token-cancel',projection,'CANCEL',projection==='DETAIL'?'item_1':undefined,'PAUSED',undefined,'HANDOFF'),true);
 }finally{h.close();}});

test('only RAW post-ACK reads use the extended readback policy for confirm and Undo',async()=>{
 for(const projection of ['EXPENSE_RAW','DETAIL']){const h=fixture(projection),old={grid:client.getSheetGridInfo,formula:client.batchGetSheetFormulaValues,effective:client.batchGetSheetEffectiveSerialValues};let reads=[];try{
  for(const [key,name] of [['grid','getSheetGridInfo'],['formula','batchGetSheetFormulaValues'],['effective','batchGetSheetEffectiveSerialValues']])client[name]=async(...args)=>{reads.push({writes:h.writes(),extended:args[2]?.postWriteRead===true});return old[key](...args)};
  await h.run();assert.ok(reads.some(x=>x.writes===0));assert.ok(reads.some(x=>x.writes===1));assert.ok(reads.every(x=>x.extended===(projection==='EXPENSE_RAW'&&x.writes===1)));
  h.prepareCancel();reads=[];await h.cancel();assert.ok(reads.some(x=>x.writes===1));assert.ok(reads.some(x=>x.writes===2));assert.ok(reads.every(x=>x.extended===(projection==='EXPENSE_RAW'&&x.writes===2)));assert.equal(h.writes(),2);
 }finally{h.close();}}
});
