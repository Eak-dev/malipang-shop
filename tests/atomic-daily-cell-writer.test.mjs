import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),{withStableWorkbookClaim}=require('../dist/sheets/stable-workbook-claim.js'),{readStableExpenseSource}=require('../dist/sheets/stable-expense-source.js'),{writeAtomicDailyCellUnderClaim,verifyAtomicDailyAccounting,verifyAtomicDailyFinalSnapshot}=require('../dist/sheets/atomic-daily-cell-writer.js'),{runStableExpenseJob}=require('../dist/sheets/stable-expense-job.js'),{dispatchStablePhase1}=require('../dist/sheets/stable-phase1-dispatch.js'),{syncJob}=require('../dist/sheets/sync.js'),{continuousDailyTarget}=require('../dist/sheets/continuous-daily-route.js'),{atomicDailyMarker,isAtomicDailyMarkerForRow,atomicDailyRowFormulas,atomicDailyBootstrapRequests,encodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js');

function fixture(){
 const h=expenseSqlite(),old={getSheetGridInfo:client.getSheetGridInfo,batchGetSheetFormulaValues:client.batchGetSheetFormulaValues,batchGetSheetEffectiveSerialValues:client.batchGetSheetEffectiveSerialValues,batchUpdateSpreadsheetWithReply:client.batchUpdateSpreadsheetWithReply},prepare=h.DB.prepare,batch=h.DB.batch;
 h.DB.prepare=function(sql){const stmt=prepare.call(this,sql),run=stmt.run,all=stmt.all;stmt.run=async function(){return{...await run.call(this),success:true};};stmt.all=async function(){return{...await all.call(this),success:true};};return stmt;};h.DB.batch=async function(stmts){return(await batch.call(this,stmts)).map(x=>({...x,success:true}));};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_RAW:'raw',SHEET_EXPENSE_DAILY:'รายวัน',SHEET_PURCHASE_DETAILS:'detail'});
 h.sqlite.exec("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'; INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_test','message','owner','=literal',10000,'transfer','SHOP_BANK','ingredients','2026-10-09','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_test',1,'fixture','PROCESSING','now','2099-01-01T00:00:00.000Z','lease')");
 const len=10,cols=29,blank=()=>Array(cols).fill(null),f=Array.from({length:len},blank),e=Array.from({length:len},blank);
 for(const g of [f,e]){g[1][7]='เงินโอน';g[2][6]='NON-FIXED';g[3][26]=2026;g[3][27]=10;g[3][28]=1000;}
 for(let r=4;r<=len;r++){Object.assign(f[r-1],atomicDailyRowFormulas(r));f[r-1][24]=e[r-1][24]=atomicDailyMarker(r);}
 const legacyF=Array.from({length:len},()=>Array(21).fill(null)),legacyE=legacyF.map(row=>row.slice());
 for(const g of [legacyF,legacyE]){g[4][0]=2026;Object.assign(g[5],{1:10,3:'รายรับทั้งหมดในบัญชี',4:1000});Object.assign(g[7],{0:'รวม',1:10,8:0});}
 legacyF[7][8]='=SUM(I7:I7)';
 let writes=0,mode='ok',chosen=0;
 client.getSheetGridInfo=async(_env,title)=>title==='รายวัน'?({sheetId:8,rowCount:len,columnCount:21}):({sheetId:9,rowCount:len,columnCount:cols});
 client.batchGetSheetFormulaValues=async(_env,ranges)=>[(ranges[0].startsWith("'รายวัน'!")?legacyF:f).map(row=>row.slice())];client.batchGetSheetEffectiveSerialValues=async(_env,ranges)=>[(ranges[0].startsWith("'รายวัน'!")?legacyE:e).map(row=>row.slice())];
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before)=>{
  if(mode==='formula-race')f[3][5]='=MANUAL';if(mode==='legacy-race')legacyF[6][3]=legacyE[6][3]='changed';await before();
  const change=requests[0].findReplace;assert.deepEqual(Object.keys(requests[0]),['findReplace']);assert.equal(change.range.startColumnIndex,24);assert.equal(change.range.endColumnIndex,25);assert.equal(change.matchEntireCell,true);assert.equal(change.searchByRegex,false);assert.equal(change.includeFormulas,false);
  const index=change.range.startRowIndex;chosen=index+1;
  if(mode==='marker-race'){f[index][24]=e[index][24]='owner data';return{replies:[{findReplace:{}}]};}
  if(mode==='manual-race'){f[index][4]=e[index][4]=321;}
  if(f[index][24]!==change.find)return{replies:[{findReplace:{}}]};
  writes++;f[index][24]=e[index][24]=change.replacement;
  const x=change.replacement.split('␟'),year=Number(x[2]),month=Number(x[3]),day=Number(x[4]),amount=Number(x[7])/100;
  const old=legacyE[7][8]||0;Object.assign(e[index],{0:year,1:month,2:day,3:x[5],7:amount,8:amount,9:1000-old-amount,17:'',18:1000-old-amount,20:(Date.UTC(year,month-1,day)-Date.UTC(1899,11,30))/86400000,21:x[8],22:x[9],23:x[1]});
  if(mode==='timeout')throw new Error('synthetic lost response');
  if(mode==='malformed')return{replies:[{}]};
  return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};
 };
 const run=(entityKey='exp_test')=>withStableWorkbookClaim(h.env,async claim=>{const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey,entityVersion:1,traceId:'fixture'};const source=await readStableExpenseSource(h.env,job,'lease',claim);assert.ok(source);await writeAtomicDailyCellUnderClaim(h.env,job,'lease',claim,source,'continuous_carrier',9);});
 return{...h,f,e,legacyF,legacyE,run,writes:()=>writes,chosen:()=>chosen,setMode:x=>{mode=x;},close(){Object.assign(client,old);h.close();}};
}

test('bootstrap initializes only a genuinely new sheet, unique opaque markers and preserves owner input E',()=>{
 const requests=atomicDailyBootstrapRequests(42,'synthetic',8,[17,24,24,13,22,15,15]);
 assert.deepEqual(requests[0],{addSheet:{properties:{sheetId:42,title:'synthetic',gridProperties:{rowCount:8,columnCount:29,frozenRowCount:3}}}});
 const markers=requests.find(x=>x.updateCells?.start.columnIndex===24).updateCells.rows.map(x=>x.values[0].userEnteredValue.stringValue);
 assert.ok(markers.every((marker,i)=>isAtomicDailyMarkerForRow(marker,i+4)));assert.equal(new Set(markers).size,5);assert.notEqual(atomicDailyMarker(4),atomicDailyMarker(4));
 assert.equal(requests.some(x=>x.repeatCell?.range.startColumnIndex===4),false);
 assert.throws(()=>atomicDailyBootstrapRequests(42,'synthetic',8,[0,24,24,13,22,15,15]));
});
test('conditional writer dispatches one Y cell and verifies the readback before completing the journal',async()=>{const h=fixture();try{
 await h.run();assert.equal(h.writes(),1);assert.equal(h.chosen(),4);assert.equal(h.e[3][3],'=literal');assert.equal(h.e[3][7],100);assert.equal(h.e[3][9],900);assert.equal(h.e[3][4],null);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');await h.run();assert.equal(h.writes(),1,'verified duplicate does not write twice');
 }finally{h.close();}});
test('carrier verification accounts for old-month direct I plus the new expense',async()=>{const h=fixture();try{
 const serial=(Date.UTC(2026,9,9)-Date.UTC(1899,11,30))/86400000;
 Object.assign(h.legacyF[6],{1:10,2:9,8:50,20:'=DATE(2026,10,9)'});Object.assign(h.legacyE[6],{1:10,2:9,8:50,20:serial});h.legacyE[7][8]=50;
 await h.run();assert.equal(h.e[3][9],850);assert.equal(h.e[3][18],850);assert.equal(h.writes(),1);
 }finally{h.close();}});
test('accounting falls back to verified legacy opening, permits one numeric override and rejects uncertainty',async()=>{const h=fixture();try{
 await h.run();const legacy={status:'VERIFIED',legacyDebitSatang:0,openingSatang:100000,checkedRows:0,year:2026,month:10};
 const verify=()=>verifyAtomicDailyAccounting({formula:h.f,effective:h.e},10,2026,10,legacy);
 h.f[3][28]=h.e[3][28]=null;assert.equal(verify(),false,'invalid existing matching budget is not fallback');
 h.f[3][26]=h.e[3][26]=null;h.f[3][27]=h.e[3][27]=null;assert.equal(verify(),true,'verified legacy header supplies budget');
 assert.equal(verifyAtomicDailyAccounting({formula:h.f,effective:h.e},10,2026,10,{...legacy,openingSatang:null}),false,'no assumed budget for future year');
 Object.assign(h.f[3],{26:2026,27:10,28:1200});Object.assign(h.e[3],{26:2026,27:10,28:1200,9:1100,18:1100});assert.equal(verify(),true,'owner override need not equal old opening');
 Object.assign(h.f[4],{26:2026,27:10,28:1000});Object.assign(h.e[4],{26:2026,27:10,28:1000});assert.equal(verify(),false,'duplicate is rejected');
 }finally{h.close();}});
test('legacy changes before dispatch prevent the carrier write',async()=>{const h=fixture();try{
 h.setMode('legacy-race');await assert.rejects(h.run(),/ATOMIC_DAILY_PRE_DISPATCH_SHEET_CHANGED/);assert.equal(h.writes(),0);
 }finally{h.close();}});
test('opt-in preimage records the exact confirmed carrier row with verified projection atomically',async()=>{const h=fixture();try{
 h.env.STABLE_CANCELLATION_PREIMAGE_ENABLED='true';await h.run();
 const image=h.sqlite.prepare("SELECT * FROM stable_expense_projection_preimages WHERE projection='DAILY'").get();
 const digest=createHash('sha256').update(JSON.stringify(h.f[3].map(v=>v===undefined||v===''?null:v))).digest('hex');
 assert.equal(image.preimage_digest,digest);assert.equal(image.preimage_width,29);assert.equal(image.sheet_id,9);assert.equal(image.sheet_name,'continuous_carrier');assert.equal(image.source_version,1);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');
 await h.run();assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_expense_projection_preimages').get().n,1);
 }finally{h.close();}});
test('failed preimage insert rolls back VERIFIED transition and never retries the carrier',async()=>{const h=fixture(),batch=h.DB.batch;try{
 h.env.STABLE_CANCELLATION_PREIMAGE_ENABLED='true';h.DB.batch=async function(statements){if(statements.some(s=>s.sql.includes('INSERT INTO stable_expense_projection_preimages')))h.DB.failAt=1;try{return await batch.call(this,statements);}finally{h.DB.failAt=null;}};
 await assert.rejects(h.run(),/fixture batch failure/);assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_expense_projection_preimages').get().n,0);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 await assert.rejects(h.run());assert.equal(h.writes(),1);
 }finally{h.DB.batch=batch;h.close();}});
test('route is disabled by default and rejects invalid configuration',()=>{
 assert.equal(continuousDailyTarget({SHEET_EXPENSE_DAILY:'daily'}),null);
 assert.throws(()=>continuousDailyTarget({CONTINUOUS_DAILY_ENABLED:'yes'}),/CONTINUOUS_DAILY_FLAG_INVALID/);
 assert.throws(()=>continuousDailyTarget({CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'continuous'}),/CONTINUOUS_DAILY_TARGET_INVALID/);
});
test('mislabeled test configuration is rejected before claim, D1 or Sheets writes',async()=>{const h=fixture();try{
 Object.assign(h.env,{APP_ENV:'test',STABLE_PHASE1_ENABLED:'true',STABLE_CANCELLATION_PREIMAGE_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'continuous_carrier',CONTINUOUS_DAILY_SHEET_ID:'9',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'10',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'11'});
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:1,traceId:'fixture'};
 await assert.rejects(runStableExpenseJob(h.env,job,'lease'),/CONTINUOUS_DAILY_NOT_READY/);
 assert.equal(h.writes(),0);assert.equal(h.DB.runs.length,0);assert.equal(h.DB.batches.length,0);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);
 }finally{h.close();}});
test('dispatcher rejects mislabeled test or production binding before taking a job lease',async()=>{for(const stable of ['true','false']){const h=fixture();try{
 Object.assign(h.env,{APP_ENV:'test',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:'continuous_carrier',CONTINUOUS_DAILY_SHEET_ID:'9',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'10',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'11',STABLE_CANCELLATION_PREIMAGE_ENABLED:'true',STABLE_PHASE1_ENABLED:stable});
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:1,traceId:'fixture'};
 await assert.rejects(dispatchStablePhase1(h.env,job),/CONTINUOUS_DAILY_(NOT_READY|TARGET_INVALID)/);
 await assert.rejects(syncJob(h.env,job),/CONTINUOUS_DAILY_(NOT_READY|TARGET_INVALID|LEGACY_WRITE_BLOCKED)/);
 assert.equal(h.writes(),0);assert.equal(h.DB.runs.length,0);assert.equal(h.DB.batches.length,0);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PROCESSING');
 }finally{h.close();}}});
test('final readback requires carrier, correct total and exact reservation evidence',async()=>{const h=fixture();try{
 await h.run();const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:1,traceId:'fixture'};
 await withStableWorkbookClaim(h.env,async claim=>{
  const source=await readStableExpenseSource(h.env,job,'lease',claim),journal=h.sqlite.prepare("SELECT * FROM stable_projection_writes WHERE projection='DAILY'").get();
  const check=()=>verifyAtomicDailyFinalSnapshot(h.env,job,source,'continuous_carrier',9,10,29,{formula:h.f,effective:h.e},journal,{status:'VERIFIED',legacyDebitSatang:0,openingSatang:100000,checkedRows:0,year:2026,month:10});
  await check();h.e[3][9]=999;await assert.rejects(check(),/ATOMIC_FINAL_ACCOUNTING_UNVERIFIED/);h.e[3][9]=900;
  journal.operation_token='other';await assert.rejects(check(),/ATOMIC_FINAL_RESERVATION_UNVERIFIED/);
 });
 }finally{h.close();}});
test('timeout after commit retains in-flight intent and never blindly resends',async()=>{const h=fixture();try{
 h.setMode('timeout');await assert.rejects(h.run(),/lost response/);assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');await assert.rejects(h.run());assert.equal(h.writes(),1);
 }finally{h.close();}});
test('racing marker change produces no overwrite and keeps the intent uncertain',async()=>{const h=fixture();try{
 h.setMode('marker-race');await assert.rejects(h.run(),/ATOMIC_DAILY_CONDITIONAL_UNCERTAIN/);assert.equal(h.writes(),0);assert.equal(h.f[3][24],'owner data');assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 }finally{h.close();}});
test('manual income racing after precheck is preserved and prevents verified success',async()=>{const h=fixture();try{
 h.setMode('manual-race');await assert.rejects(h.run(),/ATOMIC_DAILY_READBACK_UNCERTAIN/);assert.equal(h.f[3][4],321);assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 }finally{h.close();}});
test('changed formula before dispatch blocks provider mutation and preserves edit',async()=>{const h=fixture();try{
 h.setMode('formula-race');await assert.rejects(h.run(),/ATOMIC_DAILY_PRE_DISPATCH_SHEET_CHANGED/);assert.equal(h.writes(),0);assert.equal(h.f[3][5],'=MANUAL');assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'REVIEW');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM atomic_daily_marker_reservations').get().n,1);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}});
test('if recording the pre-dispatch review fails, the intent remains in-flight and the workbook stays held',async()=>{const h=fixture(),prepare=h.DB.prepare;try{
 h.setMode('formula-race');h.DB.prepare=function(sql){const stmt=prepare.call(this,sql);if(sql.includes("UPDATE stable_projection_writes SET state='REVIEW'"))stmt.run=async()=>{throw Error('synthetic D1 unavailable');};return stmt;};
 await assert.rejects(h.run(),/ATOMIC_DAILY_PRE_DISPATCH_SHEET_CHANGED/);assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM atomic_daily_marker_reservations').get().n,1);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.DB.prepare=prepare;h.close();}});
test('unverified opening, preexisting manual data and missing markers fail before intent',async()=>{for(const mode of ['opening','manual','marker']){const h=fixture();try{
 if(mode==='opening')h.f[3][28]=h.e[3][28]=null;if(mode==='manual')h.f[3][4]=h.e[3][4]=500;if(mode==='marker')h.f[3][24]=h.e[3][24]=null;
 await assert.rejects(h.run());assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);
 }finally{h.close();}}});
test('dated manual income remains untouched and the next row is used',async()=>{const h=fixture();try{
 const date=(Date.UTC(2026,9,5)-Date.UTC(1899,11,30))/86400000;
 for(const grid of [h.f,h.e])Object.assign(grid[3],{0:2026,1:10,2:5,3:'manual income',4:500});
 Object.assign(h.e[3],{9:1000,18:1000,20:date});
 await h.run();assert.equal(h.chosen(),5);assert.equal(h.f[3][4],500);assert.equal(h.e[3][4],500);assert.equal(h.f[3][3],'manual income');assert.equal(h.writes(),1);
 }finally{h.close();}});
test('orphaned Y carrier or blanked amount formula is rejected before appending',async()=>{for(const mode of ['deleted-id','different-month-blank-amount']){const h=fixture();try{
 const payload=encodeAtomicDailyPayload({expenseId:mode==='deleted-id'?'exp_test':'exp_other',postingYear:mode==='deleted-id'?2026:2025,postingMonth:mode==='deleted-id'?10:1,postingDay:9,description:'previous',amountColumn:'H',amountSatang:10000,category:'ingredients',wallet:'บัญชีร้าน'}),r=h.f[3],e=h.e[3];r[24]=e[24]=payload;
 Object.assign(e,{0:mode==='deleted-id'?2026:2025,1:mode==='deleted-id'?10:1,2:9,3:'previous',7:100,21:'ingredients',22:'บัญชีร้าน',23:mode==='deleted-id'?'MALIPANG_EXPENSE:exp_test':'MALIPANG_EXPENSE:exp_other'});
 if(mode==='deleted-id'){r[23]=null;e[23]=null;}else{r[7]='=IF(FALSE,1,"")';e[7]='';}
 assert.equal(verifyAtomicDailyAccounting({formula:h.f,effective:h.e},10,2026,10),false);
 await assert.rejects(h.run(),/ATOMIC_DAILY_ACCOUNTING_UNVERIFIED/);assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);
 }finally{h.close();}}});
test('restoring a previously consumed marker cannot reserve it for another expense',async()=>{const h=fixture();try{
 const original=h.f[3][24];await h.run();assert.equal(h.writes(),1);
 h.f[3][24]=h.e[3][24]=original;for(const c of [0,1,2,3,7,8,9,17,18,20,21,22,23])h.e[3][c]=null;
 h.sqlite.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_second','message2','owner','another',10000,'transfer','SHOP_BANK','ingredients','2026-10-09','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job2','EXPENSE','exp_second',1,'fixture','PROCESSING','now','2099-01-01T00:00:00.000Z','lease')");
 await assert.rejects(h.run('exp_second'),/malformed JSON/);assert.ok(h.DB.batches.some(batch=>batch.some(stmt=>stmt.sql.includes('INSERT INTO atomic_daily_marker_reservations'))));assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM atomic_daily_marker_reservations').get().n,1);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,1);
 }finally{h.close();}});
test('failure between D1 marker reservation and projection intent rolls both back',async()=>{const h=fixture(),batch=h.DB.batch;try{
 h.DB.batch=async function(statements){if(statements.some(s=>s.sql.includes('INSERT INTO atomic_daily_marker_reservations')))h.DB.failAt=1;try{return await batch.call(this,statements);}finally{h.DB.failAt=null;}};
 await assert.rejects(h.run(),/fixture batch failure/);assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM atomic_daily_marker_reservations').get().n,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);
 }finally{h.DB.batch=batch;h.close();}});
test('payload rejects delimiter ambiguity and invalid dates',()=>{
 const row={expenseId:'exp_test',postingYear:2026,postingMonth:10,postingDay:9,description:'=literal',amountColumn:'H',amountSatang:10000,category:'ingredients',wallet:'บัญชีร้าน'};
 const payload=encodeAtomicDailyPayload(row);assert.ok(payload.startsWith('MPD1␟MALIPANG_EXPENSE:exp_test␟'));assert.ok(payload.includes('␟=literal␟'));
 assert.throws(()=>encodeAtomicDailyPayload({...row,description:'bad␟text'}));assert.throws(()=>encodeAtomicDailyPayload({...row,postingMonth:2,postingDay:30}));
});
test('real Sheets client runs the mutation callback before POST and classifies a lost POST as unknown',async()=>{
 const auth=require('../dist/sheets/google-auth.js'),originalToken=auth.getGoogleAccessToken,originalFetch=globalThis.fetch,marker=Error('synthetic pre-dispatch stop');let sends=0;
 try{
  auth.getGoogleAccessToken=async()=> 'synthetic';globalThis.fetch=async()=>{sends++;throw Error('synthetic network loss');};
  const env={GOOGLE_SPREADSHEET_ID:'book',EXTERNAL_API_TIMEOUT_MS:'1000'};
  await assert.rejects(client.batchUpdateSpreadsheetWithReply(env,[{findReplace:{}}],async()=>{throw marker;}),error=>error===marker);assert.equal(sends,0);
  await assert.rejects(client.batchUpdateSpreadsheetWithReply(env,[{findReplace:{}}],async()=>{}),error=>error instanceof client.SheetsMutationOutcomeUnknownError);assert.equal(sends,1);
 }finally{auth.getGoogleAccessToken=originalToken;globalThis.fetch=originalFetch;}
});
