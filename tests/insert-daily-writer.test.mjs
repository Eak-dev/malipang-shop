import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),route=require('../dist/sheets/continuous-daily-route.js'),claimApi=require('../dist/sheets/stable-workbook-claim.js'),coverage=require('../dist/sheets/legacy-daily-coverage.js'),insertWriter=require('../dist/sheets/insert-daily-writer.js');
const {continuousDailyCutoverStatements}=require('../dist/sheets/continuous-daily-cutover.js'),{readStableExpenseSource}=require('../dist/sheets/stable-expense-source.js'),{continuousDailyHelperFormulas}=require('../dist/sheets/continuous-daily-plan.js'),{decodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js'),{insertDailyExpenseUnderClaim}=require('../dist/sheets/insert-daily-writer.js');
const {runStableExpenseJob}=require('../dist/sheets/stable-expense-job.js');
const {runStableExpenseCancellationJob}=require('../dist/sheets/stable-expense-cancellation-job.js');
const {pendingDailyCancellations,verifyDailyCarrierEvidence}=require('../dist/sheets/daily-carrier-auth.js');
const {rawCarrierHeaders,detailCarrierHeaders,ledgerCarrierFormulas,ledgerCarrierMarker,decodeLedgerCarrier,ledgerCarrierDisplay}=require('../dist/sheets/atomic-expense-ledger-template.js');

async function fixture(preCutover=false,createAdmission=true){
 const h=expenseSqlite(),names=['getSheetGridInfo','getSpreadsheetSheetProperties','getSheetCellNumberFormats','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheetWithReply'],saved=Object.fromEntries(names.map(k=>[k,client[k]])),originalRoute=route.continuousDailyTarget,originalOwned=claimApi.stableWorkbookClaimOwned,originalCoverage=coverage.readLegacyDailyCoverage,prepare=h.DB.prepare,batch=h.DB.batch;
 h.DB.prepare=function(sql){const stmt=prepare.call(this,sql),run=stmt.run,all=stmt.all;stmt.run=async function(){return{...await run.call(this),success:true};};stmt.all=async function(){return{...await all.call(this),success:true};};return stmt;};h.DB.batch=async function(stmts){return(await batch.call(this,stmts)).map(x=>({...x,success:true}));};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'รายวัน',SHEET_EXPENSE_RAW:'V52_EXPENSE_RAW',SHEET_PURCHASE_DETAILS:'รายละเอียดการซื้อ',APP_ENV:'test',RUNTIME_MODE:'shadow',STABLE_PHASE1_ENABLED:'true',STABLE_CANCELLATION_PREIMAGE_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'draft',CONTINUOUS_DAILY_SHEET_ID:'2',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'3',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'4'});
 h.sqlite.exec("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'; INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','claim','HELD','now','now')");
 const viewManifest=JSON.stringify([{sheetId:3,title:'raw_new',kind:'LEDGER'},{sheetId:4,title:'detail_new',kind:'LEDGER'},{sheetId:5,title:'V52_EXPENSE_RAW_ALL',kind:'VIEW'},{sheetId:6,title:'V52_PURCHASE_DETAIL_ALL',kind:'VIEW'}]);
 const reportFormula='=1+1',reportManifest=JSON.stringify([{sheetId:7,sheetName:'97_EXPENSE_CLEAN',row:2,column:1,after:createHash('sha256').update(reportFormula).digest('hex')}]);
 for(const stage of ['VIEWS','DAILY_J','REPORTS']){const manifest=stage==='VIEWS'?viewManifest:stage==='REPORTS'?reportManifest:'[{}]',hash=createHash('sha256').update(manifest).digest('hex');h.sqlite.prepare("INSERT INTO continuous_report_cutover_attempts(spreadsheet_id,stage,operation_token,manifest_digest,manifest_json,cell_count,state,created_at,updated_at) VALUES('book',?,'claim',?,?,?,'IN_FLIGHT','now','now')").run(stage,hash,manifest,JSON.parse(manifest).length);h.sqlite.prepare("UPDATE continuous_report_cutover_attempts SET state='VERIFIED' WHERE stage=?").run(stage);}
 const createSource=()=>h.sqlite.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_test','message','owner','=literal',123,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_test',1,'fixture','PROCESSING',1,'now','2099-01-01T00:00:00.000Z','lease')");
 if(preCutover){createSource();h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");}
 const revision=h.sqlite.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').get().revision;
 await h.DB.batch(continuousDailyCutoverStatements(h.env,{book:'book',legacySheetId:1,legacySheetName:'รายวัน',continuousSheetId:2,continuousSheetName:'draft',rawSheetId:3,rawSheetName:'raw_new',detailSheetId:4,detailSheetName:'detail_new',claim:'claim',revision,mustBeCancelledOrAbsentExpenseIds:['exp_absent1','exp_absent2']}));
 if(!preCutover)createSource();else h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:1,traceId:'fixture'},source=await readStableExpenseSource(h.env,job,'lease','claim');assert.ok(source);
 if(preCutover&&createAdmission)h.sqlite.prepare("INSERT INTO continuous_daily_source_admissions(spreadsheet_id,expense_id,source_version,source_digest,provider_digest,source_revision,claim_token,admitted_at) VALUES('book','exp_test',1,?,?,?,'claim','now')").run(source.digest,'b'.repeat(64),source.revision);
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
  if(range.includes("'97_EXPENSE_CLEAN'!")){const header=['Date','Expense_ID / Legacy row','Description','Amount','Wallet','Category','Source','Sales_Addback_Basis'];return rawE[1][0]==='exp_test'?[header,[(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000,'exp_test','=literal',1.23,'SHOP_BANK','ingredients','V52_CONFIRMED','']]:[header];}
  if(range.includes("'V52_EXPENSE_RAW_ALL'!"))return [['Expense_ID'],...rawE.slice(1).map(r=>[r[0]])];
  if(range.includes("'V52_PURCHASE_DETAIL_ALL'!"))return [['Purchase_Item_ID','Expense_ID'],...detailE.slice(1).map(r=>[r[0],r[1]])];
  return range.includes("'raw_new'!")?rawE.map(r=>r.slice()):range.includes("'detail_new'!")?detailE.map(r=>r.slice()):e.map(r=>r.slice());
 });
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before)=>{
  await before();
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
 return {...h,job,source,legacy,formula:()=>f,effective:()=>e,writes:()=>writes,setMode:x=>{mode=x;},async run(){return insertDailyExpenseUnderClaim(h.env,job,'lease','claim',source,'draft',2);},close(){Object.assign(client,saved);route.continuousDailyTarget=originalRoute;claimApi.stableWorkbookClaimOwned=originalOwned;coverage.readLegacyDailyCoverage=originalCoverage;h.close();}};
}

test('inserts into first logical row after permanent anchor and verifies durable preimage',async()=>{const h=await fixture();try{
 await h.run();assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_expense_projection_preimages WHERE projection='DAILY'").get().n,1);
 await assert.rejects(h.run(),/DUPLICATE_ID/);assert.equal(h.writes(),1);
 }finally{h.close();}});
test('lost response, format mismatch or shifted-formula tampering leaves intent in flight and does not retry',async()=>{for(const mode of ['timeout','tamper','bad-format']){const h=await fixture();try{
 h.setMode(mode);await assert.rejects(h.run());assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 await assert.rejects(h.run());assert.equal(h.writes(),1);
 }finally{h.close();}}});
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
