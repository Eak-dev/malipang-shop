import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),route=require('../dist/sheets/continuous-daily-route.js'),claimApi=require('../dist/sheets/stable-workbook-claim.js'),coverage=require('../dist/sheets/legacy-daily-coverage.js'),insertWriter=require('../dist/sheets/insert-daily-writer.js');
const {continuousDailyCutoverStatements}=require('../dist/sheets/continuous-daily-cutover.js'),{readStableExpenseSource}=require('../dist/sheets/stable-expense-source.js'),{continuousDailyHelperFormulas}=require('../dist/sheets/continuous-daily-plan.js'),{decodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js'),{insertDailyExpenseUnderClaim}=require('../dist/sheets/insert-daily-writer.js');
const {runStableExpenseJob}=require('../dist/sheets/stable-expense-job.js');
const {runStableExpenseCancellationJob}=require('../dist/sheets/stable-expense-cancellation-job.js');
const {pendingDailyCancellations,verifyDailyCarrierEvidence}=require('../dist/sheets/daily-carrier-auth.js');
const {matchesCommittedDailyInsert}=require('../dist/sheets/continuous-daily-write-evidence.js');
const {verifyReviewedDailyProjection}=require('../dist/sheets/continuous-daily-positive-recovery.js'),notice=require('../dist/sheets/stable-edit-notice.js');
const {cancelAtomicDailyCandidateUnderClaim}=require('../dist/sheets/atomic-daily-cancellation-candidate.js');
const {dispatchStablePhase1}=require('../dist/sheets/stable-phase1-dispatch.js');
const {rawCarrierHeaders,detailCarrierHeaders,ledgerCarrierFormulas,ledgerCarrierMarker,decodeLedgerCarrier,ledgerCarrierDisplay}=require('../dist/sheets/atomic-expense-ledger-template.js');

// Test-only stub: lifecycle tests simulate an already admitted readiness gate.
// The real, currently fail-closed gate is covered in continuous-notice-readiness.test.mjs.
// Lifecycle fixtures simulate an already admitted activation; activation-specific tests use the real guard below.
const activationModule=require('../dist/sheets/continuous-notice-activation.js'),assertNoticeActivationReal=activationModule.assertContinuousNoticeActivation;
activationModule.assertContinuousNoticeActivation=async()=>{};
const simulatedReadiness=require('../dist/sheets/continuous-notice-readiness.js');
simulatedReadiness.noticeReadinessFingerprint=async()=> 'f'.repeat(64);
simulatedReadiness.noticeReadinessReady=async()=>true;
simulatedReadiness.noticeReadinessSql='(? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL)';
async function fixture(preCutover=false,createAdmission=true,claim='claim'){
 const h=expenseSqlite(),names=['getSheetGridInfo','getSpreadsheetSheetProperties','getSheetCellNumberFormats','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheetWithReply'],saved=Object.fromEntries(names.map(k=>[k,client[k]])),originalRoute=route.continuousDailyTarget,originalOwned=claimApi.stableWorkbookClaimOwned,originalCoverage=coverage.readLegacyDailyCoverage,prepare=h.DB.prepare,batch=h.DB.batch;
 h.DB.prepare=function(sql){const stmt=prepare.call(this,sql),run=stmt.run,all=stmt.all;stmt.run=async function(){return{...await run.call(this),success:true};};stmt.all=async function(){return{...await all.call(this),success:true};};return stmt;};h.DB.batch=async function(stmts){return(await batch.call(this,stmts)).map(x=>({...x,success:true}));};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'รายวัน',SHEET_EXPENSE_RAW:'V52_EXPENSE_RAW',SHEET_PURCHASE_DETAILS:'รายละเอียดการซื้อ',APP_ENV:'test',RUNTIME_MODE:'shadow',STABLE_PHASE1_ENABLED:'true',STABLE_CANCELLATION_PREIMAGE_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'draft',CONTINUOUS_DAILY_SHEET_ID:'2',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'3',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'4'});
 h.sqlite.exec("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'");h.sqlite.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book',?,'HELD','now','now')").run(claim);
 const viewManifest=JSON.stringify([{sheetId:3,title:'raw_new',kind:'LEDGER'},{sheetId:4,title:'detail_new',kind:'LEDGER'},{sheetId:5,title:'V52_EXPENSE_RAW_ALL',kind:'VIEW'},{sheetId:6,title:'V52_PURCHASE_DETAIL_ALL',kind:'VIEW'}]);
 const reportFormula='=1+1',reportManifest=JSON.stringify([{sheetId:7,sheetName:'97_EXPENSE_CLEAN',row:2,column:1,after:createHash('sha256').update(reportFormula).digest('hex')}]);
 for(const stage of ['VIEWS','DAILY_J','REPORTS']){const manifest=stage==='VIEWS'?viewManifest:stage==='REPORTS'?reportManifest:'[{}]',hash=createHash('sha256').update(manifest).digest('hex');h.sqlite.prepare("INSERT INTO continuous_report_cutover_attempts(spreadsheet_id,stage,operation_token,manifest_digest,manifest_json,cell_count,state,created_at,updated_at) VALUES('book',?,?,?,?,?,'IN_FLIGHT','now','now')").run(stage,claim,hash,manifest,JSON.parse(manifest).length);h.sqlite.prepare("UPDATE continuous_report_cutover_attempts SET state='VERIFIED' WHERE stage=?").run(stage);}
 const createSource=()=>h.sqlite.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_test','message','owner','=literal',123,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_test',1,'fixture','PROCESSING',1,'now','2099-01-01T00:00:00.000Z','lease')");
 if(preCutover){createSource();h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");}
 const revision=h.sqlite.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').get().revision;
 await h.DB.batch(continuousDailyCutoverStatements(h.env,{book:'book',legacySheetId:1,legacySheetName:'รายวัน',continuousSheetId:2,continuousSheetName:'draft',rawSheetId:3,rawSheetName:'raw_new',detailSheetId:4,detailSheetName:'detail_new',claim,revision,mustBeCancelledOrAbsentExpenseIds:['exp_absent1','exp_absent2']}));
 if(!preCutover)createSource();else h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:1,traceId:'fixture'},source=await readStableExpenseSource(h.env,job,'lease',claim);assert.ok(source);
 if(preCutover&&createAdmission)h.sqlite.prepare("INSERT INTO continuous_daily_source_admissions(spreadsheet_id,expense_id,source_version,source_digest,provider_digest,source_revision,claim_token,admitted_at) VALUES('book','exp_test',1,?,?,?,?, 'now')").run(source.digest,'b'.repeat(64),source.revision,claim);
 let f=Array.from({length:8},()=>Array(29).fill(null)),e=Array.from({length:8},()=>Array(29).fill(null)),mode='ok',writes=0;
 const rawF=Array.from({length:6},()=>Array(26).fill(null)),rawE=Array.from({length:6},()=>Array(26).fill(null));
 const detailF=Array.from({length:6},()=>Array(26).fill(null)),detailE=Array.from({length:6},()=>Array(26).fill(null));
 [...rawCarrierHeaders,'Sales_Addback_Basis'].forEach((v,i)=>{rawF[0][i]=rawE[0][i]=v;});
 detailCarrierHeaders.forEach((v,i)=>{detailF[0][i]=detailE[0][i]=v;});
 for(let n=2;n<=6;n++){Object.assign(rawF[n-1],ledgerCarrierFormulas('EXPENSE_RAW',n));rawF[n-1][25]=rawE[n-1][25]=ledgerCarrierMarker(n);}
 for(let n=2;n<=6;n++){Object.assign(detailF[n-1],ledgerCarrierFormulas('DETAIL',n));detailF[n-1][25]=detailE[n-1][25]=ledgerCarrierMarker(n);}
 const reportFormulas=(await import('../scripts/combined-ledger-report-formulas.mjs')).combinedLedgerSpillFormulas({rawNew:'raw_new',detailNew:'detail_new',rawCombined:'V52_EXPENSE_RAW_ALL',detailCombined:'V52_PURCHASE_DETAIL_ALL',rawOldRows:1000,rawNewRows:6,detailOldRows:1000,detailNewRows:6});
 f[2][7]='เงินโอน';e[2][7]='เงินโอน';for(let n=4;n<=8;n++)Object.assign(f[n-1],continuousDailyHelperFormulas(n));
 for(const rows of [f,e])Object.assign(rows[3],{26:2026,27:11,28:1000});
 const legacy={grid:{sheetId:1,rowCount:10,columnCount:25},formula:[],effective:[],coverage:{status:'VERIFIED',legacyDebitSatang:0,openingSatang:100000,checkedRows:0,year:2026,month:11}};
 route.continuousDailyTarget=()=>({sheet:'draft',sheetId:2});claimApi.stableWorkbookClaimOwned=async()=>true;coverage.readLegacyDailyCoverage=async()=>legacy;
 client.getSheetGridInfo=async(_env,name)=>name==='raw_new'?{sheetId:3,rowCount:rawF.length,columnCount:26}:name==='detail_new'?{sheetId:4,rowCount:detailF.length,columnCount:26}:{sheetId:2,rowCount:f.length,columnCount:29};
 client.getSpreadsheetSheetProperties=async()=>[{sheetId:10,title:'V52_EXPENSE_RAW',rowCount:1000,columnCount:26},{sheetId:3,title:'raw_new',rowCount:rawF.length,columnCount:26},{sheetId:11,title:'รายละเอียดการซื้อ',rowCount:1000,columnCount:20},{sheetId:4,title:'detail_new',rowCount:detailF.length,columnCount:26},{sheetId:5,title:'V52_EXPENSE_RAW_ALL',rowCount:9999,columnCount:18},{sheetId:6,title:'V52_PURCHASE_DETAIL_ALL',rowCount:9999,columnCount:20},{sheetId:7,title:'97_EXPENSE_CLEAN',rowCount:4500,columnCount:8}];
 client.getSheetCellNumberFormats=async()=>[...Array.from({length:15},()=>({type:'NUMBER',pattern:'#,##0.00'})),null,{type:'DATE',pattern:mode==='bad-format'?'yyyy':'dd/MM/yyyy'}];
 client.batchGetSheetFormulaValues=async(_env,ranges)=>ranges.map(range=>range.includes("'รายวัน'!X")?[]:range.includes("'97_EXPENSE_CLEAN'!A2:A2")?[[reportFormula]]:range.includes("'V52_EXPENSE_RAW_ALL'!")?[[reportFormulas.raw]]:range.includes("'V52_PURCHASE_DETAIL_ALL'!")?[[reportFormulas.detail]]:range.includes("'raw_new'!")?rawF.map(r=>r.slice()):range.includes("'detail_new'!")?detailF.map(r=>r.slice()):f.map(r=>r.slice()));
 client.batchGetSheetEffectiveSerialValues=async(_env,ranges)=>ranges.map(range=>{
  if(range.includes("'รายวัน'!X"))return [];
  if(range.includes("'97_EXPENSE_CLEAN'!")){const header=['Date','Expense_ID / Legacy row','Description','Amount','Wallet','Category','Source','Sales_Addback_Basis'];return rawE[1][0]==='exp_test'?[header,[(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000,'exp_test','=literal',1.23,'SHOP_BANK','ingredients','V52_CONFIRMED','']]:[header];}
  if(range.includes("'V52_EXPENSE_RAW_ALL'!"))return [['Expense_ID'],...rawE.slice(1).map(r=>[r[0]])];
  if(range.includes("'V52_PURCHASE_DETAIL_ALL'!"))return [['Purchase_Item_ID','Expense_ID'],...detailE.slice(1).map(r=>[r[0],r[1]])];
  return range.includes("'raw_new'!")?rawE.map(r=>r.slice()):range.includes("'detail_new'!")?detailE.map(r=>r.slice()):e.map(r=>r.slice());
 });
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before)=>{
  await before();
  if(requests[0].findReplace?.range.sheetId===2){const x=requests[0].findReplace,i=x.range.startRowIndex;if(f[i][24]!==x.find)return{replies:[{findReplace:{}}]};assert.equal(x.matchEntireCell,true);assert.equal(x.includeFormulas,false);writes++;f[i][24]=e[i][24]=x.replacement;for(const c of [0,1,2,3,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20,21,22,23])e[i][c]='';return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};}
  if(requests[0].findReplace){const change=requests[0].findReplace,i=change.range.startRowIndex,ledgerF=change.range.sheetId===4?detailF:rawF,ledgerE=change.range.sheetId===4?detailE:rawE;if(ledgerF[i][25]!==change.find)return{replies:[{findReplace:{}}]};ledgerF[i][25]=ledgerE[i][25]=change.replacement;ledgerCarrierDisplay(decodeLedgerCarrier(change.replacement)).forEach((v,c)=>{ledgerE[i][c]=v});writes++;return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};}
  const index=requests[1].insertRange.range.startRowIndex,values=requests[2].updateCells.rows[0].values;
  assert.equal(index,4);assert.equal(requests[1].insertRange.range.endColumnIndex,25);writes++;
  const oldF=f.map(r=>r.slice()),oldE=e.map(r=>r.slice());f.push(Array(29).fill(null));e.push(Array(29).fill(null));
  for(let i=index;i<oldF.length;i++)for(let c=0;c<25;c++){f[i+1][c]=oldF[i][c];e[i+1][c]=oldE[i][c];}
  for(let i=index+1;i<f.length;i++)Object.assign(f[i],continuousDailyHelperFormulas(i+1));
  for(let c=0;c<25;c++){f[index][c]=values[c].userEnteredValue?.formulaValue??values[c].userEnteredValue?.stringValue??null;e[index][c]=null;}
  const payload=decodeAtomicDailyPayload(f[index][24]);assert.ok(payload);
  Object.assign(e[index],{0:2026,1:11,2:15,3:'=literal',7:1.23,8:1.23,9:998.77,18:998.77,20:(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000,21:'ingredients',22:'บัญชีร้าน',23:'MALIPANG_EXPENSE:exp_test',24:f[index][24]});
  if(mode==='timeout')throw Error('synthetic lost response');if(mode==='tamper')f[6][9]='=0';return{replies:[{},{},{}]};
 };
 return {...h,job,source,legacy,claim,formula:()=>f,effective:()=>e,writes:()=>writes,setMode:x=>{mode=x;},async run(){return insertDailyExpenseUnderClaim(h.env,job,'lease',claim,source,'draft',2);},close(){Object.assign(client,saved);route.continuousDailyTarget=originalRoute;claimApi.stableWorkbookClaimOwned=originalOwned;coverage.readLegacyDailyCoverage=originalCoverage;h.close();}};
}

test('inserts into first logical row after permanent anchor and verifies durable preimage',async()=>{const h=await fixture();try{
 await h.run();assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_expense_projection_preimages WHERE projection='DAILY'").get().n,1);
 await assert.rejects(h.run(),/DUPLICATE_ID/);assert.equal(h.writes(),1);
 }finally{h.close();}});
test('writer holds when legacy X formula evaluates to its expense ID',async()=>{const h=await fixture();try{
 const formula=client.batchGetSheetFormulaValues,effective=client.batchGetSheetEffectiveSerialValues;
 client.batchGetSheetFormulaValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[['=A1']]]:formula(env,ranges,policy);
 client.batchGetSheetEffectiveSerialValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[['MALIPANG_EXPENSE:exp_test']]]:effective(env,ranges,policy);
 await assert.rejects(h.run(),/INSERT_DAILY_LEGACY_ID_UNVERIFIED/);assert.equal(h.writes(),0);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes WHERE projection='DAILY'").get().n,0);
 }finally{h.close();}});
test('writer holds when legacy X literal and effective snapshots disagree',async()=>{const h=await fixture();try{
 const formula=client.batchGetSheetFormulaValues,effective=client.batchGetSheetEffectiveSerialValues;
 client.batchGetSheetFormulaValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[['MALIPANG_EXPENSE:exp_other']]]:formula(env,ranges,policy);
 client.batchGetSheetEffectiveSerialValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[]]:effective(env,ranges,policy);
 await assert.rejects(h.run(),/INSERT_DAILY_LEGACY_ID_UNVERIFIED/);assert.equal(h.writes(),0);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes WHERE projection='DAILY'").get().n,0);
 }finally{h.close();}});
test('writer holds a legacy X value beginning with # even when formula and effective values match',async()=>{const h=await fixture();try{
 const formula=client.batchGetSheetFormulaValues,effective=client.batchGetSheetEffectiveSerialValues;
 client.batchGetSheetFormulaValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[['#REF!']]]:formula(env,ranges,policy);
 client.batchGetSheetEffectiveSerialValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[['#REF!']]]:effective(env,ranges,policy);
 await assert.rejects(h.run(),/INSERT_DAILY_LEGACY_ID_UNVERIFIED/);assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes WHERE projection='DAILY'").get().n,0);
 }finally{h.close();}});
test('writer holds if legacy X formula result changes before dispatch or after write',async()=>{for(const phase of ['before','after']){const h=await fixture();try{
 const formula=client.batchGetSheetFormulaValues,effective=client.batchGetSheetEffectiveSerialValues;let reads=0;
 client.batchGetSheetFormulaValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[['=A1']]]:formula(env,ranges,policy);
 client.batchGetSheetEffectiveSerialValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[[++reads>=(phase==='before'?2:3)?'MALIPANG_EXPENSE:exp_test':'MALIPANG_EXPENSE:exp_other']]]:effective(env,ranges,policy);
 await assert.rejects(h.run(),phase==='before'?/INSERT_DAILY_PRE_DISPATCH_CHANGED/:/INSERT_DAILY_READBACK_UNCERTAIN/);
 assert.equal(h.writes(),phase==='before'?0:1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 }finally{h.close();}}});
test('lost response, format mismatch or shifted-formula tampering leaves intent in flight and does not retry',async()=>{for(const mode of ['timeout','tamper','bad-format']){const h=await fixture();try{
 h.setMode(mode);await assert.rejects(h.run());assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 await assert.rejects(h.run());assert.equal(h.writes(),1);
 }finally{h.close();}}});
test('lost daily insert keeps immutable evidence and a positive postimage proves the captured grid transform only',async()=>{const h=await fixture();try{
 h.setMode('timeout');await assert.rejects(h.run(),/synthetic lost response/);
 const evidence=h.sqlite.prepare("SELECT * FROM continuous_daily_write_evidence WHERE entity_id='exp_test'").get(),formula=h.formula(),effective=h.effective(),payload=formula[4][24],coords={sheetId:evidence.sheet_id,row:evidence.target_row,rowCount:evidence.before_rows,columnCount:evidence.before_columns};
 assert.equal(decodeAtomicDailyPayload(payload).operationMarker,evidence.marker);
 assert.equal(await matchesCommittedDailyInsert({formula,effective},coords,payload,evidence.before_digest,evidence.payload_digest),true);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE entity_id='exp_test'").get().state,'IN_FLIGHT');
 assert.throws(()=>h.sqlite.exec("UPDATE continuous_daily_write_evidence SET before_digest='"+'f'.repeat(64)+"'"),/immutable/);
 assert.throws(()=>h.sqlite.exec('DELETE FROM continuous_daily_write_evidence'),/retained/);
 formula[0][0]='changed';assert.equal(await matchesCommittedDailyInsert({formula,effective},coords,payload,evidence.before_digest,evidence.payload_digest),false);formula[0][0]=null;
 formula[6][9]='=0';assert.equal(await matchesCommittedDailyInsert({formula,effective},coords,payload,evidence.before_digest,evidence.payload_digest),false);formula[6][9]=continuousDailyHelperFormulas(7)[9];
 formula[4][24]='';assert.equal(await matchesCommittedDailyInsert({formula,effective},coords,payload,evidence.before_digest,evidence.payload_digest),false);formula[4][24]=payload;
 formula[5][24]=payload;assert.equal(await matchesCommittedDailyInsert({formula,effective},coords,payload,evidence.before_digest,evidence.payload_digest),false);formula[5][24]=null;
 assert.equal(await matchesCommittedDailyInsert({formula,effective},coords,payload,'f'.repeat(64),evidence.payload_digest),false);
 assert.equal(await matchesCommittedDailyInsert({formula,effective},coords,payload,evidence.before_digest,'f'.repeat(64)),false);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE entity_id='exp_test'").get().state,'IN_FLIGHT');
 }finally{h.close();}});
test('daily evidence cannot be forged without its exact journal and marker reservation',async()=>{const h=await fixture();try{
 assert.throws(()=>h.sqlite.prepare("INSERT INTO continuous_daily_write_evidence(spreadsheet_id,entity_id,sheet_id,sheet_name,source_version,source_digest,operation_token,marker,target_row,before_rows,before_columns,before_digest,payload_digest,created_at) VALUES('book','exp_fake',2,'draft',1,?,'claim',?,5,8,29,?,?, 'now')").run('a'.repeat(64),'INSERT_'+'a'.repeat(32),'b'.repeat(64),'c'.repeat(64)),/requires exact intent/);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM continuous_daily_write_evidence').get().n,0);
 }finally{h.close();}});
async function reviewedLostDaily(){
 const h=await fixture(false,true,'claim-token-recovery'),oldPaused=notice.stableNoticePaused;
 h.setMode('timeout');await assert.rejects(h.run(),/synthetic lost response/);
 h.env.STABLE_RECOVERY_GATE_ENABLED='true';h.env.STABLE_SHEETS_PACING_ENABLED='true';
 h.sqlite.prepare("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-recovery','book','ARMED','EXPENSE','exp_test',1,'now','now')").run();
 h.sqlite.prepare("INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES(?,'epoch-recovery','ADMITTED','now')").run(h.claim);
 h.sqlite.prepare("UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',notice_stamp='stamp',notice_identity='identity' WHERE operation_token=?").run(h.claim);
 h.sqlite.exec("UPDATE sync_jobs SET status='REVIEW',lease_token=NULL,lease_until=NULL,last_error='STABLE_SYNC_REVIEW' WHERE job_id='job'");
 notice.stableNoticePaused=async()=>true;
 return {...h,close(){notice.stableNoticePaused=oldPaused;h.close();}};
}
test('positive daily recovery verifies only exact projection and preserves REVIEW, epoch and notice',async()=>{const h=await reviewedLostDaily();try{
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),true);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_expense_projection_preimages WHERE projection='DAILY'").get().n,1);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'REVIEW');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_recovery_epochs WHERE epoch_id='epoch-recovery'").get().state,'ARMED');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").get(h.claim).state,'ADMITTED');
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');
 assert.equal(h.writes(),1);assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),true);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_expense_projection_preimages WHERE projection='DAILY'").get().n,1);assert.equal(h.writes(),1);
 h.formula()[4][24]='tampered';assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),false);
 }finally{h.close();}});
test('daily positive recovery forwards one request policy through all nested read paths',async()=>{const h=await reviewedLostDaily();try{
 const budget={},policy={kind:'continuous-expense',budget},seen=new Set();
 for(const [name,index] of [['getSheetGridInfo',2],['getSpreadsheetSheetProperties',1],['getSheetCellNumberFormats',4],['batchGetSheetFormulaValues',2],['batchGetSheetEffectiveSerialValues',2]]){
  const next=client[name];client[name]=async(...args)=>{assert.equal(args[index],policy,name);seen.add(name);return next(...args);};
 }
 const nextCoverage=coverage.readLegacyDailyCoverage;coverage.readLegacyDailyCoverage=async(...args)=>{assert.equal(args[4],policy);seen.add('legacy');return nextCoverage(...args);};
 const nextNotice=notice.stableNoticePaused;notice.stableNoticePaused=async(...args)=>{assert.equal(args[3],budget);seen.add('notice');return nextNotice(...args);};
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim,'PAUSED',policy),true);
 assert.deepEqual([...seen].sort(),['getSheetGridInfo','getSpreadsheetSheetProperties','getSheetCellNumberFormats','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','legacy','notice'].sort());
 }finally{h.close();}});
test('verified daily proof accepts only an exact durable ready notice and rejects spoofed style',async()=>{const h=await reviewedLostDaily(),oldStyle=notice.stableNoticeStyleFingerprint;try{
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),true);
 const style='a'.repeat(64),revision=h.sqlite.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').get().revision;
 h.sqlite.prepare("INSERT INTO continuous_review_notice_close(operation_token,spreadsheet_id,epoch_id,expense_id,source_version,projection,journal_entity,operation_kind,notice_identity,paused_stamp,next_stamp,style_digest,state,created_at,updated_at) VALUES(?,'book','epoch-recovery','exp_test',1,'DAILY','exp_test','CONFIRM','identity','stamp','next',?,'TIME_IN_FLIGHT','now','now')").run(h.claim,style);
 h.sqlite.prepare("UPDATE stable_workbook_claims SET notice_stamp='next' WHERE operation_token=?").run(h.claim);
 h.sqlite.prepare("UPDATE continuous_review_notice_close SET state='TIME_VERIFIED' WHERE operation_token=?").run(h.claim);
 h.sqlite.prepare("INSERT INTO continuous_notice_status_attempts(operation_token,spreadsheet_id,initial_ready_status,dispatch_ready_status,next_stamp,source_revision,created_at) VALUES(?,'book','พร้อมแก้ไข • มีรายการรอตรวจ','พร้อมแก้ไข • มีรายการรอตรวจ','next',?,'now')").run(h.claim,revision);
 h.sqlite.prepare("UPDATE continuous_review_notice_close SET state='STATUS_IN_FLIGHT',source_revision=? WHERE operation_token=?").run(revision,h.claim);
 notice.stableNoticeStyleFingerprint=async(_env,identity,status,stamp)=>identity==='identity'&&status==='พร้อมแก้ไข • มีรายการรอตรวจ'&&stamp==='next'?style:null;
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim,'REVIEW_READY'),false);
 h.sqlite.prepare("UPDATE continuous_review_notice_close SET state='STATUS_ACKED' WHERE operation_token=?").run(h.claim);
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim,'REVIEW_READY'),true);assert.equal(h.writes(),1);
 notice.stableNoticeStyleFingerprint=async()=> 'b'.repeat(64);assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim,'REVIEW_READY'),false);
 h.sqlite.prepare("UPDATE stable_workbook_claims SET notice_stamp='wrong' WHERE operation_token=?").run(h.claim);assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim,'REVIEW_READY'),false);
 }finally{notice.stableNoticeStyleFingerprint=oldStyle;h.close();}});
test('daily reverify after a crash rejects changed source, claim, operation or epoch',async()=>{for(const mode of ['source','claim','operation','epoch']){const h=await reviewedLostDaily();try{
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),true);
 if(mode==='source')h.sqlite.exec("UPDATE expense_events SET description='changed' WHERE expense_id='exp_test'");
 if(mode==='claim')h.sqlite.prepare("UPDATE stable_workbook_claims SET state='HELD' WHERE operation_token=?").run(h.claim);
 if(mode==='operation')h.sqlite.prepare("UPDATE stable_recovery_operations SET state='VERIFIED',verified_at='now' WHERE operation_token=?").run(h.claim);
 if(mode==='epoch')h.sqlite.exec("UPDATE stable_recovery_epochs SET state='REVIEW' WHERE epoch_id='epoch-recovery'; UPDATE stable_recovery_epochs SET state='CLOSED' WHERE epoch_id='epoch-recovery'");
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),false,mode);assert.equal(h.writes(),1);
 }finally{h.close();}}});
test('positive daily recovery holds when the same expense ID is present in legacy X',async()=>{const h=await reviewedLostDaily();try{
 const original=client.batchGetSheetFormulaValues;let legacyReads=0;
 client.batchGetSheetFormulaValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?(legacyReads++,[[['MALIPANG_EXPENSE:exp_test']]]):original(env,ranges,policy);
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),false);
 assert.equal(legacyReads,1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'REVIEW');assert.equal(h.writes(),1);
 }finally{h.close();}});
test('positive daily recovery holds for a legacy X formula evaluating to a duplicate or error',async()=>{for(const result of ['MALIPANG_EXPENSE:exp_test','#REF!','#LOADING!','#SPILL!','']){const h=await reviewedLostDaily();try{
 const formula=client.batchGetSheetFormulaValues,effective=client.batchGetSheetEffectiveSerialValues;
 client.batchGetSheetFormulaValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[['=A1']]]:formula(env,ranges,policy);
 client.batchGetSheetEffectiveSerialValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[[result]]]:effective(env,ranges,policy);
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),false,result);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');assert.equal(h.writes(),1);
 }finally{h.close();}}});
test('positive daily recovery holds if legacy X effective value changes while formula stays the same',async()=>{const h=await reviewedLostDaily();try{
 const formula=client.batchGetSheetFormulaValues,effective=client.batchGetSheetEffectiveSerialValues;let reads=0;
 client.batchGetSheetFormulaValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[['=A1']]]:formula(env,ranges,policy);
 client.batchGetSheetEffectiveSerialValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?[[[++reads===1?'MALIPANG_EXPENSE:exp_other':'MALIPANG_EXPENSE:exp_test']]]:effective(env,ranges,policy);
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),false);assert.equal(reads,2);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');assert.equal(h.writes(),1);
 }finally{h.close();}});
test('positive daily recovery holds if legacy X changes between checks',async()=>{const h=await reviewedLostDaily();try{
 const original=client.batchGetSheetFormulaValues;let legacyReads=0;
 client.batchGetSheetFormulaValues=async(env,ranges,policy)=>ranges.length===1&&ranges[0].includes("'รายวัน'!X")?(++legacyReads===1?[[]]:[[['MALIPANG_EXPENSE:exp_test']]]):original(env,ranges,policy);
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),false);
 assert.equal(legacyReads,2);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'REVIEW');assert.equal(h.writes(),1);
 }finally{h.close();}});
test('positive daily recovery never infers success from absence, changed formula, notice or changed source',async()=>{for(const mode of ['absent','formula','notice','source','race']){const h=await reviewedLostDaily();try{
 if(mode==='absent')h.formula()[4][24]=null;
 if(mode==='formula')h.formula()[6][9]='=0';
 if(mode==='notice')notice.stableNoticePaused=async()=>false;
 if(mode==='source')h.sqlite.exec("UPDATE expense_events SET description='changed' WHERE expense_id='exp_test'");
 if(mode==='race'){const getFormats=client.getSheetCellNumberFormats;client.getSheetCellNumberFormats=async(...args)=>{const r=await getFormats(...args);h.sqlite.exec("UPDATE expense_events SET description='raced' WHERE expense_id='exp_test'");return r;};}
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),false,mode);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'REVIEW');
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');assert.equal(h.writes(),1);
 }finally{h.close();}}});
test('actual 11-field daily writer carrier can be undone with verified readback and preserved formulas',async()=>{const h=await fixture(false,true,'claim-token-original');try{
 await h.run();const f=h.formula(),e=h.effective(),payload=f[4][24],before=f[4].slice();
 assert.equal(payload.split('␟').length,11);assert.match(decodeAtomicDailyPayload(payload).operationMarker,/^INSERT_[0-9a-f]{32}$/);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');
 h.sqlite.exec("UPDATE sync_jobs SET status='COMPLETED',lease_token=NULL,lease_until=NULL WHERE job_id='job'; UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_test'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('undo-job','EXPENSE','exp_test',2,'undo','PROCESSING','now','2099-01-01T00:00:00.000Z','undo-lease'); UPDATE stable_workbook_claims SET operation_token='cancel-token-next' WHERE spreadsheet_id='book'");
 const undo={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:2,traceId:'undo'};
 await cancelAtomicDailyCandidateUnderClaim(h.env,undo,'undo-lease','cancel-token-next','draft',2);
 assert.equal(h.writes(),2);assert.match(f[4][24],/^MPD1_CANCELLED_[0-9a-f]{64}$/);assert.equal(e[4][24],f[4][24]);
 for(let col=0;col<24;col++)assert.equal(f[4][col],before[col],`formula ${col} preserved`);
 for(const col of [0,1,2,3,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20,21,22,23])assert.equal(e[4][col],'');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_expense_cancellation_writes WHERE entity_id='exp_test' AND projection='DAILY'").get().state,'VERIFIED');
 assert.equal(await verifyDailyCarrierEvidence(h.env,'draft',2,29,f),true);
 }finally{h.close();}});
test('actual dispatcher and workbook claim hold an ambiguous daily write before positive recovery',async()=>{const h=await fixture(false,true,'claim-token-original'),oldBegin=notice.beginStableNotice,oldPaused=notice.stableNoticePaused;try{
 Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});
 h.sqlite.exec("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'; UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL,attempt_count=0 WHERE job_id='job'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-dispatch','book','ARMED','EXPENSE','exp_test',1,'now','now')");
 notice.beginStableNotice=async(env,token,_wait,authorized)=>{await authorized();const r=await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='stamp',notice_identity='identity' WHERE spreadsheet_id='book' AND operation_token=? AND state='HELD'").bind(token).run();assert.equal(r.meta.changes,1);};
 notice.stableNoticePaused=async()=>true;h.setMode('timeout');
 assert.equal(await dispatchStablePhase1(h.env,h.job),'REVIEW');assert.equal(h.writes(),1);
 const claim=h.sqlite.prepare("SELECT operation_token,state,phase FROM stable_workbook_claims WHERE spreadsheet_id='book'").get();assert.equal(claim.state,'REVIEW');assert.equal(claim.phase,'OPERATION');
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,claim.operation_token),true);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'REVIEW');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_recovery_epochs WHERE epoch_id='epoch-dispatch'").get().state,'ARMED');
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');assert.equal(h.writes(),1);
 }finally{notice.beginStableNotice=oldBegin;notice.stableNoticePaused=oldPaused;h.close();}});
test('carrier evidence rejects missing, altered, duplicate and unjournaled active rows',async()=>{const h=await fixture();try{
 await h.run();const rows=h.formula(),check=()=>verifyDailyCarrierEvidence(h.env,'draft',2,29,rows);assert.equal(await check(),true);
 const original=rows[4][24];rows[4][24]='';assert.equal(await check(),false);rows[4][24]=original;
 rows[4][24]=original.replace('␟123␟','␟124␟');assert.equal(await check(),false);rows[4][24]=original;
 rows.push(rows[4].slice());assert.equal(await check(),false);rows.pop();
 rows.push(Array(29).fill(null));rows.at(-1)[24]=original.replace('exp_test','exp_fake');assert.equal(await check(),false);
 }finally{h.close();}});
test('carrier evidence authenticates exact cancellation journal and rejects forged, missing or duplicate tombstones',async()=>{const h=await fixture();try{
 await h.run();const p=h.sqlite.prepare("SELECT preimage_digest FROM stable_expense_projection_preimages WHERE projection='DAILY'").get();
 h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_test'");
 h.sqlite.prepare("INSERT INTO stable_expense_cancellation_writes(spreadsheet_id,entity_type,entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state,created_at,updated_at) VALUES('book','EXPENSE','exp_test','DAILY',2,1,?,'cancel-token','IN_FLIGHT','now','now')").run(p.preimage_digest);
 h.sqlite.exec("UPDATE stable_expense_cancellation_writes SET state='VERIFIED' WHERE entity_id='exp_test'");
 const rows=h.formula(),tomb='MPD1_CANCELLED_'+createHash('sha256').update(JSON.stringify(['cancel-token'])).digest('hex'),check=()=>verifyDailyCarrierEvidence(h.env,'draft',2,29,rows);
 rows[4][24]=tomb;assert.equal(await check(),true);
 rows[4][24]='';assert.equal(await check(),false);rows[4][24]='MPD1_CANCELLED_'+'b'.repeat(64);assert.equal(await check(),false);rows[4][24]=tomb;
 rows.push(Array(29).fill(null));rows.at(-1)[24]=tomb;assert.equal(await check(),false);
 }finally{h.close();}});
test('an intact prior Undo with pending cancellation defers another insert before any write',async()=>{const h=await fixture();try{
 await h.run();h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_test'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('cancel','EXPENSE','exp_test',2,'cancel','PENDING','now'); INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_other','message2','owner','other',123,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('other','EXPENSE','exp_other',1,'fixture','PROCESSING','now','2099-01-01T00:00:00.000Z','lease2')");
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_other',entityVersion:1,traceId:'fixture'},source=await readStableExpenseSource(h.env,job,'lease2','claim'),pending=await pendingDailyCancellations(h.env,'draft',2,'claim');
 assert.deepEqual([...pending],['exp_test']);assert.equal(await verifyDailyCarrierEvidence(h.env,'draft',2,29,h.formula(),undefined,pending),true);
 await assert.rejects(insertDailyExpenseUnderClaim(h.env,job,'lease2','claim',source,'draft',2),/INSERT_DAILY_PENDING_CANCELLATION/);assert.equal(h.writes(),1);
 const withClaim=claimApi.withStableWorkbookClaim;claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');
 try{assert.equal(await runStableExpenseJob(h.env,job,'lease2'),'CONTINUE');const state=h.sqlite.prepare("SELECT status,last_error,lease_token FROM sync_jobs WHERE job_id='other'").get();assert.equal(state.status,'PENDING');assert.equal(state.last_error,'WAITING_FOR_CANCELLATION');assert.equal(state.lease_token,null);}finally{claimApi.withStableWorkbookClaim=withClaim;}
 h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease2',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='other'");
 h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING' WHERE job_id='cancel'");
 await assert.rejects(insertDailyExpenseUnderClaim(h.env,job,'lease2','claim',source,'draft',2),/INSERT_DAILY_PENDING_CANCELLATION/);assert.equal(h.writes(),1);
 const pre=h.sqlite.prepare("SELECT preimage_digest FROM stable_expense_projection_preimages WHERE projection='DAILY'").get();
 h.sqlite.prepare("INSERT INTO stable_expense_cancellation_writes(spreadsheet_id,entity_type,entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state,created_at,updated_at) VALUES('book','EXPENSE','exp_test','DAILY',2,1,?,'other-token','IN_FLIGHT','now','now')").run(pre.preimage_digest);
 await assert.rejects(insertDailyExpenseUnderClaim(h.env,job,'lease2','claim',source,'draft',2),/INSERT_DAILY_ACCOUNTING_UNVERIFIED/);assert.equal(h.writes(),1);
 }finally{h.close();}});

test('stale confirmed job closes safely before or after a fully evidenced Undo, but not during an uncertain intent',async()=>{for(const state of ['pending','completed','uncertain']){const h=await fixture();try{
 await h.run();h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_test'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('cancel','EXPENSE','exp_test',2,'cancel','PENDING','now')");
 if(state!=='pending'){
  const pre=h.sqlite.prepare("SELECT preimage_digest FROM stable_expense_projection_preimages WHERE projection='DAILY'").get();
  h.sqlite.prepare("INSERT INTO stable_expense_cancellation_writes(spreadsheet_id,entity_type,entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state,created_at,updated_at) VALUES('book','EXPENSE','exp_test','DAILY',2,1,?,'cancel-token','IN_FLIGHT','now','now')").run(pre.preimage_digest);
  if(state==='completed')h.sqlite.exec("UPDATE stable_expense_cancellation_writes SET state='VERIFIED' WHERE entity_id='exp_test'; UPDATE sync_jobs SET status='COMPLETED' WHERE job_id='cancel'");
 }
 const original=claimApi.withStableWorkbookClaim;claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');try{
  if(state==='uncertain'){await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_EXPENSE_SOURCE_UNVERIFIED/);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PROCESSING');}
  else{assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.equal(h.sqlite.prepare("SELECT last_error FROM sync_jobs WHERE job_id='job'").get().last_error,'SUPERSEDED_BY_UNDO');}
 }finally{claimApi.withStableWorkbookClaim=original;}
 assert.equal(h.writes(),1);
 }finally{h.close();}}});
test('admitted pre-cutover v1 may be superseded only when its exact v2 Undo exists',async()=>{const h=await fixture(true),original=claimApi.withStableWorkbookClaim;try{
 await h.run();h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_test'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('cancel','EXPENSE','exp_test',2,'cancel','PENDING','now')");
 claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');
 assert.equal(h.sqlite.prepare("SELECT last_error FROM sync_jobs WHERE job_id='job'").get().last_error,'SUPERSEDED_BY_UNDO');assert.equal(h.writes(),1);
 }finally{claimApi.withStableWorkbookClaim=original;h.close();}});

test('exact recovery epoch closes superseded v1 with a verified projection but holds an uncertain cancellation',async()=>{for(const mode of ['verified','uncertain']){const h=await fixture(),original=claimApi.withStableWorkbookClaim;try{
 await h.run();h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2,updated_at='2026-11-15T00:00:00.000Z' WHERE expense_id='exp_test'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('cancel','EXPENSE','exp_test',2,'cancel','PENDING','now'); UPDATE stable_workbook_claims SET operation_token='claim-token-123'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-v1','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-123','epoch-v1','ADMITTED','now')");
 if(mode==='uncertain'){const pre=h.sqlite.prepare("SELECT preimage_digest FROM stable_expense_projection_preimages WHERE projection='DAILY'").get();h.sqlite.prepare("INSERT INTO stable_expense_cancellation_writes(spreadsheet_id,entity_type,entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state,created_at,updated_at) VALUES('book','EXPENSE','exp_test','DAILY',2,1,?,'cancel-token','IN_FLIGHT','now','now')").run(pre.preimage_digest);}
 h.env.STABLE_RECOVERY_GATE_ENABLED='true';h.env.STABLE_SHEETS_PACING_ENABLED='true';claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-123');
 if(mode==='verified'){assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.equal(h.sqlite.prepare("SELECT last_error FROM sync_jobs WHERE job_id='job'").get().last_error,'SUPERSEDED_BY_UNDO');}
 else {await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_EXPENSE_SOURCE_UNVERIFIED/);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PROCESSING');}
 }finally{claimApi.withStableWorkbookClaim=original;h.close()}}});

test('Undo racing before any projection closes v1 in its exact epoch then v2 without a Sheets write',async()=>{const h=await fixture(),original=claimApi.withStableWorkbookClaim;try{
 h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2,updated_at='2026-11-15T00:00:00.000Z' WHERE expense_id='exp_test'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES('cancel','EXPENSE','exp_test',2,'cancel','PENDING',0,'now'); UPDATE stable_workbook_claims SET operation_token='claim-token-123'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-v1','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-123','epoch-v1','ADMITTED','now')");
 h.env.STABLE_RECOVERY_GATE_ENABLED='true';h.env.STABLE_SHEETS_PACING_ENABLED='true';claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-123');
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.equal(h.sqlite.prepare("SELECT last_error FROM sync_jobs WHERE job_id='job'").get().last_error,'SUPERSEDED_BEFORE_DISPATCH');
 h.sqlite.exec("UPDATE stable_recovery_operations SET state='VERIFIED',verified_at='now' WHERE operation_token='claim-token-123'; UPDATE stable_recovery_epochs SET state='COMPLETE' WHERE epoch_id='epoch-v1'; UPDATE stable_workbook_claims SET operation_token='claim-token-456'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-v2','book','ARMED','EXPENSE','exp_test',2,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-456','epoch-v2','ADMITTED','now'); UPDATE sync_jobs SET status='PROCESSING',lease_token='lease-undo',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='cancel'");
 claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-456');const undo={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:2,traceId:'cancel'};assert.equal(await runStableExpenseCancellationJob(h.env,undo,'lease-undo'),'COMPLETED');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='cancel'").get().status,'COMPLETED');assert.equal(h.writes(),0);
 }finally{claimApi.withStableWorkbookClaim=original;h.close()}});
test('Undo racing an in-flight projection keeps the original exact epoch on hold',async()=>{const h=await fixture(),original=claimApi.withStableWorkbookClaim;try{
 h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2,updated_at='2026-11-15T00:00:00.000Z' WHERE expense_id='exp_test'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('cancel','EXPENSE','exp_test',2,'cancel','PENDING','now'); UPDATE stable_workbook_claims SET operation_token='claim-token-123'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-v1','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-123','epoch-v1','ADMITTED','now')");
 h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_test','DAILY',2,'draft',1,?,'previous-token','IN_FLIGHT','now')").run('a'.repeat(64));
 h.env.STABLE_RECOVERY_GATE_ENABLED='true';h.env.STABLE_SHEETS_PACING_ENABLED='true';claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-123');await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_EXPENSE_SOURCE_UNVERIFIED/);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE entity_id='exp_test'").get().state,'IN_FLIGHT');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PROCESSING');
 }finally{claimApi.withStableWorkbookClaim=original;h.close()}});

test('staged confirmed sync writes daily then helper RAW and completes only after both final readbacks',async()=>{const h=await fixture(),original=claimApi.withStableWorkbookClaim;try{
 claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');assert.equal(h.writes(),1);
 h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');assert.equal(h.writes(),2);
 h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'COMPLETED');
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes WHERE state='VERIFIED'").get().n,2);
 }finally{claimApi.withStableWorkbookClaim=original;h.close();}});

test('itemized receipt writes DAILY, RAW and each DETAIL before final verification',async()=>{const h=await fixture(),original=claimApi.withStableWorkbookClaim;try{
 h.sqlite.exec("INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,expense_id,vendor_name,document_date) VALUES('doc_1','docmsg','owner','RECEIPT','CONFIRMED','now','exp_test','shop','2026-11-15'); INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES('link_1','exp_test','doc_1','PRIMARY_PURCHASE_DOCUMENT','MANUAL','now'); INSERT INTO expense_document_items(item_id,document_id,expense_id,description,quantity,line_total_satang,created_at,updated_at) VALUES('item_1','doc_1','exp_test','first',1,100,'now','now'),('item_2','doc_1','exp_test','second',1,23,'now','now')");
 claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');
 for(let stage=0;stage<4;stage++){
  assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');
  h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 }
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.equal(h.writes(),4);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes WHERE state='VERIFIED'").get().n,4);
 }finally{claimApi.withStableWorkbookClaim=original;h.close();}});

test('proven pre-dispatch missing opening cancels the new expense and durably queues owner alert',async()=>{const h=await fixture(),original=claimApi.withStableWorkbookClaim,notices=[];try{
 Object.assign(h.env,{SHADOW_LINE_OUTPUT:'true',LINE_OWNER_USER_ID:'owner',JOB_QUEUE:{async send(v){notices.push(v);}}});h.sqlite.exec("UPDATE sync_jobs SET attempt_count=1 WHERE job_id='job'");
 h.formula()[3][28]=h.effective()[3][28]=null;h.legacy.coverage.openingSatang=null;claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.equal(h.writes(),0);
 assert.equal(h.sqlite.prepare("SELECT status FROM expense_events WHERE expense_id='exp_test'").get().status,'CANCELLED');
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'COMPLETED');
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE error='PENDING_LINE_NOTIFICATION_DELIVERY'").get().n,1);assert.equal(notices.length,1);
 }finally{claimApi.withStableWorkbookClaim=original;h.close();}});
test('unknown provider outcome does not auto-cancel expense',async()=>{const h=await fixture(),original=claimApi.withStableWorkbookClaim,notices=[];try{
 Object.assign(h.env,{SHADOW_LINE_OUTPUT:'true',LINE_OWNER_USER_ID:'owner',JOB_QUEUE:{async send(v){notices.push(v);}}});h.sqlite.exec("UPDATE sync_jobs SET attempt_count=1 WHERE job_id='job'");h.setMode('timeout');claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/synthetic lost response/);assert.equal(h.sqlite.prepare("SELECT status FROM expense_events WHERE expense_id='exp_test'").get().status,'CONFIRMED');assert.equal(notices.length,0);
 }finally{claimApi.withStableWorkbookClaim=original;h.close();}});
test('definite pre-dispatch failure cancels even without LINE owner and persists deferred incident',async()=>{const h=await fixture(),original=claimApi.withStableWorkbookClaim,notices=[];try{
 Object.assign(h.env,{SHADOW_LINE_OUTPUT:'false',LINE_OWNER_USER_ID:'',JOB_QUEUE:{async send(v){notices.push(v);}}});h.sqlite.exec("UPDATE sync_jobs SET attempt_count=1 WHERE job_id='job'");
 h.formula()[3][28]=h.effective()[3][28]=null;h.legacy.coverage.openingSatang=null;claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.equal(h.writes(),0);assert.equal(notices.length,0);
 assert.equal(h.sqlite.prepare("SELECT status FROM expense_events WHERE expense_id='exp_test'").get().status,'CANCELLED');
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE error='SYNC_AUTO_CANCEL_AWAITING_RECIPIENT'").get().n,1);
 }finally{claimApi.withStableWorkbookClaim=original;h.close();}});

test('unreconciled pre-cutover expense is held without freezing the workbook',async()=>{const h=await fixture(true,false),original=claimApi.withStableWorkbookClaim;try{
 claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'JOB_REVIEW');assert.equal(h.writes(),0);
 const job=h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='job'").get();assert.equal(job.status,'REVIEW');assert.match(job.last_error,/CONTINUOUS_PRE_CUTOVER_UNRECONCILED/);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes").get().n,0);assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'HELD');
 }finally{claimApi.withStableWorkbookClaim=original;h.close();}});
test('definite legacy month failure before dispatch cancels new expense and records deferred alert',async()=>{const h=await fixture(),original=claimApi.withStableWorkbookClaim;try{
 Object.assign(h.env,{SHADOW_LINE_OUTPUT:'false',LINE_OWNER_USER_ID:''});coverage.readLegacyDailyCoverage=async()=>{throw Error('LEGACY_COVERAGE_SUBTOTAL_MISMATCH')};claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.equal(h.writes(),0);
 assert.equal(h.sqlite.prepare("SELECT status FROM expense_events WHERE expense_id='exp_test'").get().status,'CANCELLED');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes").get().n,0);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE error='SYNC_AUTO_CANCEL_AWAITING_RECIPIENT'").get().n,1);
 }finally{claimApi.withStableWorkbookClaim=original;h.close();}});
test('unverified legacy sheet read holds only the unwritten job, not auto-cancel',async()=>{const h=await fixture(),original=claimApi.withStableWorkbookClaim;try{
 coverage.readLegacyDailyCoverage=async()=>{throw Error('LEGACY_COVERAGE_READ_UNVERIFIED')};claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'JOB_REVIEW');assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare("SELECT status FROM expense_events WHERE expense_id='exp_test'").get().status,'CONFIRMED');assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');
 }finally{claimApi.withStableWorkbookClaim=original;h.close();}});

for(const [kind,reason,code] of [['report','REPORT_UNVERIFIED','REPORT_HEALTH_FORMULA'],['legacy','LEGACY_READ','LEGACY_COVERAGE_READ_UNAVAILABLE'],['pending','PENDING_UNDO','INSERT_DAILY_PENDING_CANCELLATION']])test(`exact recovery auto-cancels an unwritten ${kind} preflight and queues a specific deferred alert`,async()=>{const h=await fixture(),oldClaim=claimApi.withStableWorkbookClaim,oldInsert=insertWriter.insertDailyExpenseUnderClaim;try{
 h.env.STABLE_RECOVERY_GATE_ENABLED='true';h.env.STABLE_SHEETS_PACING_ENABLED='true';h.env.LINE_OWNER_USER_ID='';
 h.sqlite.exec("UPDATE stable_workbook_claims SET operation_token='claim-token-123'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-v1','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-123','epoch-v1','ADMITTED','now')");
 claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-123');insertWriter.insertDailyExpenseUnderClaim=async()=>{throw kind==='pending'?new insertWriter.InsertDailyPendingCancellationError('exp_waiting'):new insertWriter.InsertDailyPreflightReviewError(code)};
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.deepEqual({...h.sqlite.prepare("SELECT status,version FROM expense_events WHERE expense_id='exp_test'").get()},{status:'CANCELLED',version:2});assert.equal(h.writes(),0);
 const outbox=JSON.parse(h.sqlite.prepare("SELECT payload_json FROM failed_jobs WHERE error='SYNC_AUTO_CANCEL_AWAITING_RECIPIENT'").get().payload_json);assert.equal(outbox.reason,reason);assert.equal(outbox.errorCode,code);
 }finally{insertWriter.insertDailyExpenseUnderClaim=oldInsert;claimApi.withStableWorkbookClaim=oldClaim;h.close()}});

test('preflight auto-cancellation never treats an existing provider intent as unwritten',async()=>{const h=await fixture(),oldClaim=claimApi.withStableWorkbookClaim,oldInsert=insertWriter.insertDailyExpenseUnderClaim;try{
 h.env.STABLE_RECOVERY_GATE_ENABLED='true';h.env.STABLE_SHEETS_PACING_ENABLED='true';h.sqlite.exec("UPDATE stable_workbook_claims SET operation_token='claim-token-123'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-v1','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-123','epoch-v1','ADMITTED','now')");h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_test','DAILY',2,'draft',1,?,'previous-token','IN_FLIGHT','now')").run('a'.repeat(64));
 claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-123');insertWriter.insertDailyExpenseUnderClaim=async()=>{throw new insertWriter.InsertDailyPreflightReviewError('REPORT_HEALTH_FORMULA')};await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/CONTINUOUS_DAILY_PREVIOUS_INTENT_UNRESOLVED/);assert.equal(h.sqlite.prepare("SELECT status FROM expense_events WHERE expense_id='exp_test'").get().status,'CONFIRMED');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM failed_jobs').get().n,0);
 }finally{insertWriter.insertDailyExpenseUnderClaim=oldInsert;claimApi.withStableWorkbookClaim=oldClaim;h.close()}});

for(const [kind,make,code] of [
 ['403',()=>new client.SheetsHttpError(403,'private provider body'),'SHEETS_READ_HTTP_403'],
 ['429',()=>new client.SheetsHttpError(429,'private provider body'),'SHEETS_READ_HTTP_429'],
 ['timeout',()=>new (require('../dist/shared/async.js').OperationTimeoutError)('fixture read',1),'SHEETS_READ_TIMEOUT']
])test(`provider ${kind} on a pre-intent read cancels only the proven unwritten expense and records the error`,async()=>{const h=await fixture(),oldClaim=claimApi.withStableWorkbookClaim,oldGrid=client.getSheetGridInfo;try{
 h.env.STABLE_RECOVERY_GATE_ENABLED='true';h.env.STABLE_SHEETS_PACING_ENABLED='true';h.env.LINE_OWNER_USER_ID='';
 h.sqlite.exec("UPDATE stable_workbook_claims SET operation_token='claim-token-123'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-v1','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-123','epoch-v1','ADMITTED','now')");
 claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-123');client.getSheetGridInfo=async()=>{throw make()};
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.equal(h.writes(),0);
 assert.deepEqual({...h.sqlite.prepare("SELECT status,version FROM expense_events WHERE expense_id='exp_test'").get()},{status:'CANCELLED',version:2});
 const outbox=JSON.parse(h.sqlite.prepare("SELECT payload_json FROM failed_jobs WHERE error='SYNC_AUTO_CANCEL_AWAITING_RECIPIENT'").get().payload_json);assert.equal(outbox.reason,'SHEETS_READ');assert.equal(outbox.errorCode,code);assert.doesNotMatch(JSON.stringify(outbox),/private provider body/);
 }finally{client.getSheetGridInfo=oldGrid;claimApi.withStableWorkbookClaim=oldClaim;h.close()}});

test('stalled continuous Sheets bodies distinguish before intent from after reservation and write',{timeout:5000},async()=>{
 const auth=require('../dist/sheets/google-auth.js'),originalToken=auth.getGoogleAccessToken,originalFetch=globalThis.fetch,realGrid=client.getSheetGridInfo;
 for(const phase of ['preflight','reserved','written']){
  const h=await fixture(),mockGrid=client.getSheetGridInfo;let stalled=0;
  try{
   h.env.EXTERNAL_API_TIMEOUT_MS='20';h.env.STABLE_SHEETS_PACING_ENABLED='true';auth.getGoogleAccessToken=async()=> 'synthetic';
   globalThis.fetch=async()=>{stalled++;return new Response(new ReadableStream({start(){},cancel(){return new Promise(()=>{});}}));};
   client.getSheetGridInfo=async(...args)=>{const intents=h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes").get().n,hit=phase==='preflight'?!intents:phase==='reserved'?intents>0&&h.writes()===0:h.writes()>0;return hit?realGrid(...args):mockGrid(...args);};
   await assert.rejects(h.run(),error=>phase==='preflight'?error instanceof insertWriter.InsertDailyPreflightReviewError&&error.reason==='SHEETS_READ_TIMEOUT':error.name==='OperationTimeoutError');
   assert.equal(stalled,1);assert.equal(h.writes(),phase==='written'?1:0);
   const row=h.sqlite.prepare("SELECT state FROM stable_projection_writes").get();assert.equal(row?.state,phase==='preflight'?undefined:'IN_FLIGHT');
  }finally{h.close();auth.getGoogleAccessToken=originalToken;globalThis.fetch=originalFetch;}
 }
});

test('a real pre-intent stalled read cancels only a provably unwritten expense and records the error',{timeout:5000},async()=>{
 const auth=require('../dist/sheets/google-auth.js'),token=auth.getGoogleAccessToken,fetcher=globalThis.fetch,realGrid=client.getSheetGridInfo,h=await fixture(),claim=claimApi.withStableWorkbookClaim;
 try{
  Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',EXTERNAL_API_TIMEOUT_MS:'20',LINE_OWNER_USER_ID:''});
  h.sqlite.exec("UPDATE stable_workbook_claims SET operation_token='claim-token-123'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-v1','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-123','epoch-v1','ADMITTED','now')");
  auth.getGoogleAccessToken=async()=> 'synthetic';globalThis.fetch=async()=>new Response(new ReadableStream({start(){},cancel(){return new Promise(()=>{});}}));client.getSheetGridInfo=realGrid;claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-123');
  assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.equal(h.sqlite.prepare("SELECT status FROM expense_events WHERE expense_id='exp_test'").get().status,'CANCELLED');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);
  const incident=JSON.parse(h.sqlite.prepare("SELECT payload_json FROM failed_jobs WHERE error='SYNC_AUTO_CANCEL_AWAITING_RECIPIENT'").get().payload_json);assert.equal(incident.errorCode,'SHEETS_READ_TIMEOUT');
 }finally{claimApi.withStableWorkbookClaim=claim;h.close();auth.getGoogleAccessToken=token;globalThis.fetch=fetcher;}
});
test('opt-in actual daily writer atomically hands off after verified provider readback',async()=>{const h=await fixture(false,true,'claim-token-123'),original=claimApi.withStableWorkbookClaim,oldPaused=notice.stableNoticePaused;try{
 Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true'});
 h.sqlite.exec("UPDATE stable_workbook_claims SET notice_stamp='stamp',notice_identity='identity' WHERE operation_token='claim-token-123'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-fixture','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-123','epoch-fixture','ADMITTED','now')");claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-123');
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE operation_token='claim-token-123'").get().state,'VERIFIED');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'PENDING');assert.equal(h.sqlite.prepare("SELECT phase FROM stable_workbook_claims WHERE operation_token='claim-token-123'").get().phase,'END_NOTICE_PENDING');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM continuous_normal_notice_handoffs').get().n,1);notice.stableNoticePaused=async()=>true;assert.equal(await verifyReviewedDailyProjection(h.env,h.job,'claim-token-123','PAUSED',undefined,'HANDOFF'),true);assert.equal(await verifyReviewedDailyProjection(h.env,h.job,'claim-token-123','PAUSED'),false);h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='other',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");assert.equal(await verifyReviewedDailyProjection(h.env,h.job,'claim-token-123','PAUSED',undefined,'HANDOFF'),false);
 }finally{claimApi.withStableWorkbookClaim=original;notice.stableNoticePaused=oldPaused;h.close();}});
test('actual verified daily HANDOFF closes through ACK phases without a false REVIEW',async()=>{const h=await fixture(false,true,'claim-token-123'),original=claimApi.withStableWorkbookClaim,oldPaused=notice.stableNoticePaused,oldStyle=notice.stableNoticeStyleFingerprint;try{
 Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true'});h.sqlite.exec("UPDATE stable_workbook_claims SET notice_stamp='stamp',notice_identity='identity' WHERE operation_token='claim-token-123'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-fixture','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-123','epoch-fixture','ADMITTED','now')");claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-123');assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');
 let status='พักแก้ไฟล์',time='stamp',noticeWrites=0;notice.stableNoticePaused=async(_env,t,i)=>t===time&&i==='identity'&&status==='พักแก้ไฟล์';notice.stableNoticeStyleFingerprint=async(_env,i,s,t)=>i==='identity'&&status===s&&time===t?'b'.repeat(64):null;client.batchUpdateSpreadsheetWithReply=async(_env,requests,before)=>{await before();noticeWrites++;const f=requests[0].findReplace;if(f.range.startColumnIndex===2){assert.equal(time,f.find);time=f.replacement;}else{assert.equal(status,f.find);status=f.replacement;}return {replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};};
 let d1Calls=0;const originalPrepare=h.DB.prepare,originalBatch=h.DB.batch;h.DB.prepare=function(sql){const stmt=originalPrepare.call(this,sql);for(const key of ['first','run','all']){const f=stmt[key];stmt[key]=async function(...args){d1Calls++;return f.apply(this,args);};}return stmt;};h.DB.batch=async function(stmts){d1Calls++;return originalBatch.call(this,stmts);};
 const {closeReviewedContinuousExpense}=require('../dist/sheets/continuous-review-close.js'),{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),counts=[];for(let i=0;i<3;i++){d1Calls=0;assert.equal(await closeReviewedContinuousExpense(h.env,h.job,'claim-token-123',new ReviewRequestBudget(40),'HANDOFF'),'IN_PROGRESS');counts.push(d1Calls);}d1Calls=0;assert.equal(await closeReviewedContinuousExpense(h.env,h.job,'claim-token-123',new ReviewRequestBudget(40),'HANDOFF'),'RESUMED');counts.push(d1Calls);assert.ok(counts.every(n=>n<=25),`D1 calls by phase: ${counts}`);assert.equal(status,'พร้อมแก้ไข • กำลังซิงก์');assert.equal(noticeWrites,2);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'PENDING');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_jobs WHERE status='REVIEW'").get().n,0);
 }finally{claimApi.withStableWorkbookClaim=original;notice.stableNoticePaused=oldPaused;notice.stableNoticeStyleFingerprint=oldStyle;h.close();}});
test('confirm FINAL reverify passes one policy to all Sheets, legacy and report reads',async()=>{const h=await fixture(),original=claimApi.withStableWorkbookClaim;try{claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");const source=await readStableExpenseSource(h.env,h.job,'lease','claim'),journals=h.sqlite.prepare('SELECT entity_id,projection,sheet_id,sheet_name,source_version,source_digest,state,operation_token FROM stable_projection_writes').all(),policy={kind:'continuous-expense',budget:{}},seen=new Set();for(const name of ['getSheetGridInfo','getSpreadsheetSheetProperties','getSheetCellNumberFormats','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues']){const old=client[name];client[name]=async(...args)=>{assert.equal(args.at(-1),policy);seen.add(name);return old(...args);};}const oldLegacy=coverage.readLegacyDailyCoverage;coverage.readLegacyDailyCoverage=async(...args)=>{assert.equal(args.at(-1),policy);seen.add('legacy');return oldLegacy(...args);};const {verifyStableExpenseProjections}=require('../dist/sheets/stable-expense-final-check.js');await verifyStableExpenseProjections(h.env,h.job,source,journals,policy);assert.deepEqual([...seen].sort(),['getSheetGridInfo','getSpreadsheetSheetProperties','getSheetCellNumberFormats','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','legacy'].sort());}finally{claimApi.withStableWorkbookClaim=original;h.close();}});
test('opt-in confirm FINAL saves exact provider-verified manifest and pending handoff',async()=>{const h=await fixture(false,true,'claim-token-prev'),original=claimApi.withStableWorkbookClaim,oldPaused=notice.stableNoticePaused,oldStyle=notice.stableNoticeStyleFingerprint;let token='claim-token-prev';try{claimApi.withStableWorkbookClaim=async(_env,fn)=>fn(token);assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'; UPDATE stable_workbook_claims SET operation_token='claim-token-final',notice_stamp='stamp',notice_identity='identity' WHERE operation_token='claim-token-prev'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-final','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-final','epoch-final','ADMITTED','now')");token='claim-token-final';Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true'});assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');const proof=h.sqlite.prepare('SELECT operation_kind,journal_manifest FROM continuous_final_notice_evidence').get();assert.equal(proof.operation_kind,'CONFIRM');assert.equal(JSON.parse(proof.journal_manifest).length,2);assert.equal(h.sqlite.prepare('SELECT projection FROM continuous_normal_notice_handoffs').get().projection,'FINAL');assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'PENDING');notice.stableNoticePaused=async()=>true;const {verifyFinalHandoff}=require('../dist/sheets/continuous-final-positive-recovery.js');assert.equal(await verifyFinalHandoff(h.env,h.job,'claim-token-final','PAUSED',{kind:'continuous-expense'}),true);const formula=h.formula(),priorFormula=formula[4][9];formula[4][9]='=0';await assert.rejects(verifyFinalHandoff(h.env,h.job,'claim-token-final','PAUSED',{kind:'continuous-expense'}),/INSERT_DAILY_FINAL_ACCOUNTING/);formula[4][9]=priorFormula;h.sqlite.exec("UPDATE expense_events SET description='changed' WHERE expense_id='exp_test'");assert.equal(await verifyFinalHandoff(h.env,h.job,'claim-token-final','PAUSED',{kind:'continuous-expense'}),false);h.sqlite.exec("UPDATE expense_events SET description='=literal' WHERE expense_id='exp_test'");assert.equal(await verifyFinalHandoff(h.env,h.job,'claim-token-final','PAUSED',{kind:'continuous-expense'}),true);
 let status='พักแก้ไฟล์',time='stamp',noticeWrites=0;notice.stableNoticePaused=async(_env,t,i)=>status==='พักแก้ไฟล์'&&time===t&&i==='identity';notice.stableNoticeStyleFingerprint=async(_env,i,s,t)=>i==='identity'&&status===s&&time===t?'b'.repeat(64):null;client.batchUpdateSpreadsheetWithReply=async(_env,req,before)=>{await before();noticeWrites++;const f=req[0].findReplace;if(f.range.startColumnIndex===2){assert.equal(time,f.find);time=f.replacement;}else{assert.equal(status,f.find);status=f.replacement;}return {replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};};let d1Calls=0;const originalPrepare=h.DB.prepare,originalBatch=h.DB.batch;h.DB.prepare=function(sql){const stmt=originalPrepare.call(this,sql);for(const key of ['first','run','all']){const fn=stmt[key];stmt[key]=async function(...args){d1Calls++;return fn.apply(this,args);};}return stmt;};let lostFinalAck=false;h.DB.batch=async function(stmts){d1Calls++;const result=await originalBatch.call(this,stmts);if(!lostFinalAck&&stmts.some(x=>x.sql.includes("SET state='FINAL_COMMITTED'"))){lostFinalAck=true;throw Error('synthetic final commit ACK lost');}return result;};const counts=[],worker=require('../dist/continuous-notice-worker.js').default;let acks=0;const runPhase=async()=>{const row=h.sqlite.prepare("SELECT dispatch_id FROM continuous_notice_dispatches WHERE state='PENDING'").get();assert.ok(row);d1Calls=0;await worker.queue({queue:'malipang-continuous-notice-phases',messages:[{body:{dispatchId:row.dispatch_id},ack(){acks++;},retry(){assert.fail('unexpected retry');}}]},h.env);counts.push(d1Calls);};for(let i=0;i<4;i++)await runPhase();assert.equal(noticeWrites,2);assert.equal(h.sqlite.prepare('SELECT status FROM sync_jobs').get().status,'COMPLETED');assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'HELD');assert.equal(h.sqlite.prepare('SELECT state FROM continuous_review_notice_close').get().state,'FINAL_COMMITTED');assert.match(status,/^พร้อมแก้ไข • กำลังซิงก์ • รหัส [a-f0-9]{32}$/);await runPhase();await runPhase();assert.equal(acks,6);assert.equal(lostFinalAck,true);assert.ok(counts.every(n=>n<=30),`D1 calls by FINAL phase including dispatch: ${counts}`);assert.equal(status,'พร้อมแก้ไข');assert.equal(noticeWrites,3);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{claimApi.withStableWorkbookClaim=original;notice.stableNoticePaused=oldPaused;notice.stableNoticeStyleFingerprint=oldStyle;h.close();}});
test('isolated queue runs actual daily HANDOFF one phase per message through readback',async()=>{const h=await fixture(false,true,'claim-token-123'),original=claimApi.withStableWorkbookClaim,oldPaused=notice.stableNoticePaused,oldStyle=notice.stableNoticeStyleFingerprint;try{Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true'});h.sqlite.exec("UPDATE stable_workbook_claims SET notice_stamp='stamp',notice_identity='identity' WHERE operation_token='claim-token-123'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-fixture','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-123','epoch-fixture','ADMITTED','now')");claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-123');assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');let status='พักแก้ไฟล์',time='stamp',noticeWrites=0;notice.stableNoticePaused=async(_env,t,i)=>status==='พักแก้ไฟล์'&&time===t&&i==='identity';notice.stableNoticeStyleFingerprint=async(_env,i,s,t)=>i==='identity'&&status===s&&time===t?'b'.repeat(64):null;client.batchUpdateSpreadsheetWithReply=async(_env,req,before)=>{await before();noticeWrites++;const f=req[0].findReplace;if(f.range.startColumnIndex===2){assert.equal(time,f.find);time=f.replacement;}else{assert.equal(status,f.find);status=f.replacement;}return {replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};};const worker=require('../dist/continuous-notice-worker.js').default;let acks=0;for(let i=0;i<4;i++){const row=h.sqlite.prepare("SELECT dispatch_id FROM continuous_notice_dispatches WHERE state='PENDING'").get();assert.ok(row);await worker.queue({queue:'malipang-continuous-notice-phases',messages:[{body:{dispatchId:row.dispatch_id},ack(){acks++;},retry(){assert.fail('unexpected retry');}}]},h.env);}assert.equal(acks,4);assert.equal(noticeWrites,2);assert.equal(status,'พร้อมแก้ไข • กำลังซิงก์');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM continuous_notice_dispatches WHERE state='DONE'").get().n,4);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_alert_incidents WHERE state='OPEN'").get().n,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);}finally{claimApi.withStableWorkbookClaim=original;notice.stableNoticePaused=oldPaused;notice.stableNoticeStyleFingerprint=oldStyle;h.close();}});
test('handoff not ready reports its cause before claiming the workbook or writing Sheets',async()=>{const h=await fixture();try{h.sqlite.exec("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'; UPDATE sync_jobs SET status='PENDING',attempt_count=0,lease_token=NULL,lease_until=NULL WHERE job_id='job'");Object.assign(h.env,{CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'false'});const outcome=await dispatchStablePhase1(h.env,h.job);assert.equal(outcome,'DEFERRED');assert.deepEqual({...h.sqlite.prepare('SELECT status,attempt_count,last_error FROM sync_jobs').get()},{status:'PENDING',attempt_count:0,last_error:'NORMAL_NOTICE_HANDOFF_NOT_READY'});assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_alert_incidents WHERE kind='JOB' AND state='OPEN'").get().n,1);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare('SELECT status FROM expense_events').get().status,'CONFIRMED');}finally{h.close();}});
test('not-ready deferral stays pending across retries without duplicate incidents or consumed attempts',async()=>{const h=await fixture();try{h.sqlite.exec("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'; UPDATE sync_jobs SET status='PENDING',attempt_count=0,lease_token=NULL,lease_until=NULL WHERE job_id='job'");Object.assign(h.env,{CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'false'});assert.equal(await dispatchStablePhase1(h.env,h.job),'DEFERRED');assert.equal(await dispatchStablePhase1(h.env,h.job),'DEFERRED');assert.deepEqual({...h.sqlite.prepare('SELECT status,attempt_count,last_error FROM sync_jobs').get()},{status:'PENDING',attempt_count:0,last_error:'NORMAL_NOTICE_HANDOFF_NOT_READY'});assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_alert_incidents WHERE kind='JOB' AND state='OPEN'").get().n,1);assert.equal(h.writes(),0);}finally{h.close();}});
test('a deferred job with earlier projections is held before the next provider operation',async()=>{const h=await fixture(),handoff=require('../dist/sheets/continuous-normal-notice-handoff.js'),originalReady=handoff.normalNoticeHandoffReady;try{h.sqlite.exec("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'; UPDATE sync_jobs SET status='PENDING',attempt_count=0,lease_token=NULL,lease_until=NULL WHERE job_id='job'");Object.assign(h.env,{CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'false'});assert.equal(await dispatchStablePhase1(h.env,h.job),'DEFERRED');h.sqlite.prepare("INSERT INTO stable_projection_writes(spreadsheet_id,entity_type,entity_id,projection,sheet_id,sheet_name,source_version,source_digest,operation_token,state,updated_at) VALUES('book','EXPENSE','exp_test','DAILY',2,'draft',1,?,'prior-token','VERIFIED','now')").run('a'.repeat(64));handoff.normalNoticeHandoffReady=async()=>true;assert.equal(await dispatchStablePhase1(h.env,h.job),'REVIEW');assert.equal(h.sqlite.prepare('SELECT last_error FROM sync_jobs').get().last_error,'NORMAL_NOTICE_PRIOR_REVERIFY_REQUIRED');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_alert_incidents WHERE kind='JOB' AND state='CLOSED'").get().n,1);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_alert_incidents WHERE kind='JOB' AND state='OPEN'").get().n,1);assert.equal(h.writes(),0);}finally{handoff.normalNoticeHandoffReady=originalReady;h.close();}});
test('a deferred first attempt is eligible to continue after readiness returns',async()=>{const h=await fixture(),handoff=require('../dist/sheets/continuous-normal-notice-handoff.js'),jobModule=require('../dist/sheets/stable-expense-job.js'),oldReady=handoff.normalNoticeHandoffReady,oldJob=jobModule.runStableExpenseJob;try{h.sqlite.exec("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'; UPDATE sync_jobs SET status='PENDING',attempt_count=0,lease_token=NULL,lease_until=NULL WHERE job_id='job'");Object.assign(h.env,{CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'false'});assert.equal(await dispatchStablePhase1(h.env,h.job),'DEFERRED');handoff.normalNoticeHandoffReady=async()=>true;let calls=0;jobModule.runStableExpenseJob=async()=>{calls++;return 'COMPLETED';};assert.equal(await dispatchStablePhase1(h.env,h.job),'PROCESSED');assert.equal(calls,1);}finally{handoff.normalNoticeHandoffReady=oldReady;jobModule.runStableExpenseJob=oldJob;h.close();}});
function enableNoticeActivation(h){h.sqlite.prepare("INSERT INTO continuous_publication_targets(spreadsheet_id,sheet_id,sheet_name,row_count,bootstrap_digest,created_at) VALUES('book',8,'pub',10,?,'now')").run('a'.repeat(64));h.sqlite.exec("INSERT INTO continuous_notice_activation(singleton,spreadsheet_id,legacy_sheet_name,daily_sheet_name,daily_sheet_id,raw_sheet_name,raw_sheet_id,detail_sheet_name,detail_sheet_id,publication_sheet_name,publication_sheet_id,state,activated_at) VALUES(1,'book','รายวัน','draft',2,'raw_new',3,'detail_new',4,'pub',8,'ACTIVE','now')");Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true',CONTINUOUS_PUBLICATION_ENABLED:'true',CONTINUOUS_PUBLICATION_SHEET:'pub',CONTINUOUS_PUBLICATION_SHEET_ID:'8',NOTICE_QUEUE:{send:async()=>{}}});}
test('activation fence accepts exact runtime and cannot be removed or replaced',async()=>{const h=await fixture();try{enableNoticeActivation(h);await assert.doesNotReject(assertNoticeActivationReal(h.env,h.job));assert.throws(()=>h.sqlite.exec("DELETE FROM continuous_notice_activation"));assert.throws(()=>h.sqlite.exec("UPDATE continuous_notice_activation SET daily_sheet_name='other'"));assert.throws(()=>h.sqlite.exec("INSERT OR REPLACE INTO continuous_notice_activation SELECT * FROM continuous_notice_activation"));}finally{h.close();}});
for(const [field,value] of [['STABLE_PHASE1_ENABLED','false'],['CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED','false'],['CONTINUOUS_NOTICE_DISPATCH_ENABLED','false'],['CONTINUOUS_PUBLICATION_ENABLED','false'],['GOOGLE_SPREADSHEET_ID','other'],['CONTINUOUS_DAILY_SHEET_ID','99']])test(`activated expense refuses runtime downgrade or changed target ${field}`,async()=>{const h=await fixture();try{enableNoticeActivation(h);h.env[field]=value;await assert.rejects(assertNoticeActivationReal(h.env,h.job),/CONTINUOUS_NOTICE_ACTIVATION_BLOCKED/);await assert.doesNotReject(assertNoticeActivationReal(h.env,{...h.job,entityType:'ATTENDANCE_EVENT'}));assert.equal(h.writes(),0);}finally{h.close();}});
test('activated stable and legacy expense entrypoints both block before writes on flag downgrade',async()=>{const h=await fixture();try{activationModule.assertContinuousNoticeActivation=assertNoticeActivationReal;enableNoticeActivation(h);h.env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED='false';await assert.rejects(dispatchStablePhase1(h.env,h.job),/CONTINUOUS_NOTICE_ACTIVATION_BLOCKED/);h.env.STABLE_PHASE1_ENABLED='false';const {syncJob}=require('../dist/sheets/sync.js');await assert.rejects(syncJob(h.env,h.job),/CONTINUOUS_NOTICE_ACTIVATION_BLOCKED/);assert.equal(h.writes(),0);}finally{activationModule.assertContinuousNoticeActivation=async()=>{};h.close();}});
test('activation fence rejects missing immutable trigger even with matching runtime',async()=>{const h=await fixture();try{enableNoticeActivation(h);h.sqlite.exec('DROP TRIGGER continuous_notice_activation_no_delete');await assert.rejects(assertNoticeActivationReal(h.env,h.job),/CONTINUOUS_NOTICE_ACTIVATION_BLOCKED/);}finally{h.close();}});
test('new handoff cannot be enabled before its durable activation marker exists',async()=>{const h=await fixture();try{await assert.doesNotReject(assertNoticeActivationReal(h.env,h.job));h.env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED='true';await assert.rejects(assertNoticeActivationReal(h.env,h.job),/CONTINUOUS_NOTICE_ACTIVATION_BLOCKED/);assert.equal(h.writes(),0);}finally{h.close();}});
