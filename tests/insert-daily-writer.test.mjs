process.env.MALIPANG_TEST_CANDIDATE_FLAGS='1'; // candidate behaviour flags on for this file
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {readFileSync,writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {BPRED_MODES,runBPredicateScenario} from './helpers/serial-handoff-b-predicates.mjs';
import {releaseSchemaOnly} from './helpers/migration-files.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),route=require('../dist/sheets/continuous-daily-route.js'),claimApi=require('../dist/sheets/stable-workbook-claim.js'),coverage=require('../dist/sheets/legacy-daily-coverage.js'),insertWriter=require('../dist/sheets/insert-daily-writer.js');
const {continuousDailyCutoverStatements}=require('../dist/sheets/continuous-daily-cutover.js'),{readStableExpenseSource}=require('../dist/sheets/stable-expense-source.js'),{continuousDailyHelperFormulas}=require('../dist/sheets/continuous-daily-plan.js'),{decodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js'),{insertDailyExpenseUnderClaim}=require('../dist/sheets/insert-daily-writer.js');
const realStableClaimOwned=claimApi.stableWorkbookClaimOwned;
const {runStableExpenseJob}=require('../dist/sheets/stable-expense-job.js');
const {runStableExpenseCancellationJob}=require('../dist/sheets/stable-expense-cancellation-job.js');
const {pendingDailyCancellations,verifyDailyCarrierEvidence}=require('../dist/sheets/daily-carrier-auth.js');
const {matchesCommittedDailyInsert}=require('../dist/sheets/continuous-daily-write-evidence.js');
const {readObservedDailyIncidentSource}=require('../dist/sheets/stable-expense-source.js');
const {DAILY_FAILED_INCIDENT_EVIDENCE_SQL,failedDailyIncidentFingerprint,readFailedDailyIncidentEvidence}=require('../dist/admin/exact-daily-proof-evidence.js');
const {operateExactDailySettlement,parseExactDailyOperation}=require('../dist/admin/exact-daily-settlement.js');
const probeExactFailedDailyOnly=async(env,fingerprint,version)=>(await operateExactDailySettlement(env,{action:'PROBE',fingerprint},version)).outcome==='MATCHED';
const {operateMonthlyReport}=require('../dist/sheets/monthly-report-operator.js'),googleAuth=require('../dist/sheets/google-auth.js');
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
async function fixture(preCutover=false,createAdmission=true,claim='claim',includeItem=false,dailySheet='draft',postingDate='2026-11-15'){
 const [year,month,day]=postingDate.split('-').map(Number);
 const h=expenseSqlite(),names=['getSheetGridInfo','getSpreadsheetSheetProperties','getSheetCellNumberFormats','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheetWithReply'],saved=Object.fromEntries(names.map(k=>[k,client[k]])),originalRoute=route.continuousDailyTarget,originalOwned=claimApi.stableWorkbookClaimOwned,originalCoverage=coverage.readLegacyDailyCoverage,prepare=h.DB.prepare,batch=h.DB.batch;
 h.DB.prepare=function(sql){const stmt=prepare.call(this,sql),run=stmt.run,all=stmt.all;stmt.run=async function(){return{...await run.call(this),success:true};};stmt.all=async function(){return{...await all.call(this),success:true};};return stmt;};h.DB.batch=async function(stmts){return(await batch.call(this,stmts)).map(x=>({...x,success:true}));};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'รายวัน',SHEET_EXPENSE_RAW:'V52_EXPENSE_RAW',SHEET_PURCHASE_DETAILS:'รายละเอียดการซื้อ',APP_ENV:'test',RUNTIME_MODE:'shadow',STABLE_PHASE1_ENABLED:'true',STABLE_CANCELLATION_PREIMAGE_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',CONTINUOUS_DAILY_SHEET:dailySheet,CONTINUOUS_DAILY_SHEET_ID:'2',CONTINUOUS_RAW_SHEET:'raw_new',CONTINUOUS_RAW_SHEET_ID:'3',CONTINUOUS_DETAIL_SHEET:'detail_new',CONTINUOUS_DETAIL_SHEET_ID:'4'});
 h.sqlite.exec("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'");h.sqlite.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book',?,'HELD','now','now')").run(claim);
 const viewManifest=JSON.stringify([{sheetId:3,title:'raw_new',kind:'LEDGER'},{sheetId:4,title:'detail_new',kind:'LEDGER'},{sheetId:5,title:'V52_EXPENSE_RAW_ALL',kind:'VIEW'},{sheetId:6,title:'V52_PURCHASE_DETAIL_ALL',kind:'VIEW'}]);
 const reportFormula='=1+1',reportManifest=JSON.stringify([{sheetId:7,sheetName:'97_EXPENSE_CLEAN',row:2,column:1,after:createHash('sha256').update(reportFormula).digest('hex')}]);
 for(const stage of ['VIEWS','DAILY_J','REPORTS']){const manifest=stage==='VIEWS'?viewManifest:stage==='REPORTS'?reportManifest:'[{}]',hash=createHash('sha256').update(manifest).digest('hex');h.sqlite.prepare("INSERT INTO continuous_report_cutover_attempts(spreadsheet_id,stage,operation_token,manifest_digest,manifest_json,cell_count,state,created_at,updated_at) VALUES('book',?,?,?,?,?,'IN_FLIGHT','now','now')").run(stage,claim,hash,manifest,JSON.parse(manifest).length);h.sqlite.prepare("UPDATE continuous_report_cutover_attempts SET state='VERIFIED' WHERE stage=?").run(stage);}
 const createSource=()=>{
  h.sqlite.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_test','message','owner','=literal',123,'transfer','SHOP_BANK','ingredients',?,'CONFIRMED','now',1)").run(postingDate);
  h.sqlite.exec("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_test',1,'fixture','PROCESSING',1,'now','2099-01-01T00:00:00.000Z','lease')");
 };
 if(preCutover){createSource();h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");}
 const revision=h.sqlite.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').get().revision;
 await h.DB.batch(continuousDailyCutoverStatements(h.env,{book:'book',legacySheetId:1,legacySheetName:'รายวัน',continuousSheetId:2,continuousSheetName:dailySheet,rawSheetId:3,rawSheetName:'raw_new',detailSheetId:4,detailSheetName:'detail_new',claim,revision,mustBeCancelledOrAbsentExpenseIds:['exp_absent1','exp_absent2']}));
 if(!preCutover)createSource();else h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 if(includeItem)h.sqlite.exec("INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,expense_id) VALUES('doc_fixture','doc-msg','owner','RECEIPT','CONFIRMED','now','exp_test'); INSERT INTO expense_document_items(item_id,document_id,expense_id,description,line_total_satang,created_at,updated_at) VALUES('item_1','doc_fixture','exp_test','item',123,'now','now'); INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES('link_1','exp_test','doc_fixture','PRIMARY_PURCHASE_DOCUMENT','EXACT_IDENTIFIER','now')");
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
 for(const rows of [f,e])Object.assign(rows[3],{26:year,27:month,28:1000});
 const legacy={grid:{sheetId:1,rowCount:10,columnCount:25},formula:[],effective:[],coverage:{status:'VERIFIED',legacyDebitSatang:0,openingSatang:100000,checkedRows:0,year,month}};
 route.continuousDailyTarget=()=>({sheet:dailySheet,sheetId:2});claimApi.stableWorkbookClaimOwned=async()=>true;coverage.readLegacyDailyCoverage=async()=>legacy;
 client.getSheetGridInfo=async(_env,name)=>{if(mode==='metadata-error'&&writes&&name==='draft')throw Error('synthetic metadata timeout');return name==='raw_new'?{sheetId:3,rowCount:rawF.length,columnCount:26}:name==='detail_new'?{sheetId:4,rowCount:detailF.length,columnCount:26}:{sheetId:mode==='identity-drift'&&writes?99:2,rowCount:f.length,columnCount:29};};
 client.getSpreadsheetSheetProperties=async()=>[{sheetId:10,title:'V52_EXPENSE_RAW',rowCount:1000,columnCount:26},{sheetId:3,title:'raw_new',rowCount:rawF.length,columnCount:26},{sheetId:11,title:'รายละเอียดการซื้อ',rowCount:1000,columnCount:20},{sheetId:4,title:'detail_new',rowCount:detailF.length,columnCount:26},{sheetId:5,title:'V52_EXPENSE_RAW_ALL',rowCount:9999,columnCount:18},{sheetId:6,title:'V52_PURCHASE_DETAIL_ALL',rowCount:9999,columnCount:20},{sheetId:7,title:'97_EXPENSE_CLEAN',rowCount:4500,columnCount:8}];
 client.getSheetCellNumberFormats=async()=>[...Array.from({length:15},()=>({type:'NUMBER',pattern:'#,##0.00'})),null,{type:'DATE',pattern:mode==='bad-format'?'yyyy':'dd/MM/yyyy'}];
 client.batchGetSheetFormulaValues=async(_env,ranges)=>ranges.map(range=>range.includes("'รายวัน'!X")?[]:range.includes("'97_EXPENSE_CLEAN'!A2:A2")?[[reportFormula]]:range.includes("'V52_EXPENSE_RAW_ALL'!")?[[reportFormulas.raw]]:range.includes("'V52_PURCHASE_DETAIL_ALL'!")?[[reportFormulas.detail]]:range.includes("'raw_new'!")?rawF.map(r=>r.slice()):range.includes("'detail_new'!")?detailF.map(r=>r.slice()):f.map(r=>r.slice()));
 client.batchGetSheetEffectiveSerialValues=async(_env,ranges)=>ranges.map(range=>{
  if(range.includes("'รายวัน'!X"))return [];
  if(range.includes("'97_EXPENSE_CLEAN'!")){const header=['Date','Expense_ID / Legacy row','Description','Amount','Wallet','Category','Source','Sales_Addback_Basis'];if(mode==='third-pilot'){
   const confirmed=rawE.slice(1).filter(row=>row[7]==='CONFIRMED');
   return [header,...confirmed.map(row=>[(Date.parse(row[1]+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000,row[0],row[2],row[3],row[5],row[6],'V52_CONFIRMED',''])];
  }
  if(rawE[1][0]==='exp_pilot'){const date=rawE[1][1],serial=(Date.parse(date+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000;return [header,[serial,'exp_pilot','pilot',1.20,'SHOP_BANK','ingredients','V52_CONFIRMED','']];}return rawE[1][0]==='exp_test'?[header,[(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000,'exp_test','=literal',1.23,'SHOP_BANK','ingredients','V52_CONFIRMED','']]:[header];}
  if(range.includes("'V52_EXPENSE_RAW_ALL'!"))return [['Expense_ID'],...rawE.slice(1).map(r=>[r[0]])];
  if(range.includes("'V52_PURCHASE_DETAIL_ALL'!"))return [['Purchase_Item_ID','Expense_ID'],...detailE.slice(1).map(r=>[r[0],r[1]])];
  return range.includes("'raw_new'!")?rawE.map(r=>r.slice()):range.includes("'detail_new'!")?detailE.map(r=>r.slice()):e.map(r=>r.slice());
 });
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before)=>{
  await before();
  if(requests[0].findReplace?.range.sheetId===2){const x=requests[0].findReplace,i=x.range.startRowIndex;if(f[i][24]!==x.find)return{replies:[{findReplace:{}}]};assert.equal(x.matchEntireCell,true);assert.equal(x.includeFormulas,false);writes++;f[i][24]=e[i][24]=x.replacement;for(const c of [0,1,2,3,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20,21,22,23])e[i][c]='';return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};}
  if(requests[0].findReplace){const change=requests[0].findReplace,i=change.range.startRowIndex,ledgerF=change.range.sheetId===4?detailF:rawF,ledgerE=change.range.sheetId===4?detailE:rawE;if(ledgerF[i][25]!==change.find)return{replies:[{findReplace:{}}]};ledgerF[i][25]=ledgerE[i][25]=change.replacement;ledgerCarrierDisplay(decodeLedgerCarrier(change.replacement)).forEach((v,c)=>{ledgerE[i][c]=v});writes++;return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};}
  const offset=requests[0].appendDimension?1:0,index=requests[offset].insertRange.range.startRowIndex,values=requests[offset+1].updateCells.rows[0].values;
  assert.equal(index,mode==='third-pilot'?6:mode==='second-pilot'?5:4);assert.equal(requests[offset].insertRange.range.endColumnIndex,25);writes++;
  const oldF=f.map(r=>r.slice()),oldE=e.map(r=>r.slice());f.push(Array(29).fill(null));e.push(Array(29).fill(null));
  // Provider can grow once for appendDimension and once for insertRange.
  if(offset&&mode!=='one-growth'){f.push(Array(29).fill(null));e.push(Array(29).fill(null));}
  if(offset&&mode==='three-growth'){f.push(Array(29).fill(null));e.push(Array(29).fill(null));}
  for(let i=index;i<oldF.length;i++)for(let c=0;c<25;c++){f[i+1][c]=oldF[i][c];e[i+1][c]=oldE[i][c];}
  for(let i=index+1;i<f.length;i++)if(oldF[i-1]?.[8])Object.assign(f[i],continuousDailyHelperFormulas(i+1));
  for(let c=0;c<25;c++){f[index][c]=values[c].userEnteredValue?.formulaValue??values[c].userEnteredValue?.stringValue??null;e[index][c]=null;}
  const payload=decodeAtomicDailyPayload(f[index][24]);assert.ok(payload);
  Object.assign(e[index],{0:year,1:month,2:day,3:'=literal',7:1.23,8:1.23,9:998.77,18:998.77,20:(Date.UTC(year,month-1,day)-Date.UTC(1899,11,30))/86400000,21:'ingredients',22:'บัญชีร้าน',23:'MALIPANG_EXPENSE:exp_test',24:f[index][24]});
  if(mode==='second-pilot'||mode==='third-pilot'){
   const {postingYear:y,postingMonth:m,postingDay:d,description,amountSatang,category,wallet,expenseId}=payload;
   const spent=oldE.slice(3,index).filter(r=>r[0]===y&&r[1]===m).reduce((total,r)=>total+Math.round((r[8]||0)*100),amountSatang);
   Object.assign(e[index],{0:y,1:m,2:d,3:description,7:amountSatang/100,8:amountSatang/100,9:(100000-spent)/100,18:(100000-spent)/100,20:(Date.UTC(y,m-1,d)-Date.UTC(1899,11,30))/86400000,21:category,22:wallet,23:'MALIPANG_EXPENSE:'+expenseId,24:f[index][24]});
  }
  if(mode==='timeout')throw Error('synthetic lost response');if(mode==='tamper')f[6][9]='=0';if(mode==='tail-tamper')f.at(-1)[28]='=1';if(mode==='tail-effective')e.at(-1)[27]=1;return{replies:requests.map(()=>({}))};
 };
 return {...h,job,source,legacy,claim,realBatchUpdate:saved.batchUpdateSpreadsheetWithReply,formula:()=>f,effective:()=>e,rawFormula:()=>rawF,rawEffective:()=>rawE,detailFormula:()=>detailF,detailEffective:()=>detailE,writes:()=>writes,setMode:x=>{mode=x;},async run(){return insertDailyExpenseUnderClaim(h.env,job,'lease',claim,source,dailySheet,2);},close(){Object.assign(client,saved);route.continuousDailyTarget=originalRoute;claimApi.stableWorkbookClaimOwned=originalOwned;coverage.readLegacyDailyCoverage=originalCoverage;h.close();}};
}

test('monthly operator projects one record without replaying original incident or changing business data',async()=>{for(const mode of ['ok','lost-provider','post-tamper','unrelated-before','incident-child','multi']){const h=await fixture(false,true,'claim-token-recovery',false,'รายวันต่อเนื่อง_แบบร่าง'),originalRead=client.readMonthlyReportGrid,originalInfo=client.getSheetGridInfo,originalPost=client.batchUpdateSpreadsheetWithReply,originalNotice=notice.stableNoticePaused,originalLease=googleAuth.createGoogleOAuthLease;let posts=0;try{
 h.setMode('timeout');await assert.rejects(h.run(),/synthetic lost response/);h.sqlite.exec("UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED',notice_stamp='stamp',notice_identity='identity' WHERE spreadsheet_id='book'; UPDATE sync_jobs SET status='REVIEW',lease_token=NULL,lease_until=NULL,last_error='STABLE_SYNC_REVIEW' WHERE job_id='job'");
 Object.assign(h.env,{MONTHLY_REPORT_OPERATOR_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CF_VERSION_METADATA:{id:'test-version'}});const workerHash=createHash('sha256').update('test-version').digest('hex'),beforeExpense={...h.sqlite.prepare("SELECT * FROM expense_events WHERE expense_id='exp_test'").get()};
 const n=h.formula().length,blank=()=>Array(29).fill(null),notes=Array.from({length:n},blank),formats=Array.from({length:n},blank),validations=Array.from({length:n},blank),extras=Array.from({length:n},blank);
 for(let c=4;c<=18;c++){formats[5][c]={numberFormat:{type:'NUMBER',pattern:'#,##0.00'}};formats[n-1][c]={numberFormat:{type:'NUMBER',pattern:'#,##0.00'}};}formats[5][20]={numberFormat:{type:'DATE',pattern:'dd/MM/yyyy'}};formats[n-1][20]={numberFormat:{type:'DATE',pattern:'dd/MM/yyyy'}};
 const structure=baseRows=>({sheetId:2,title:'รายวันต่อเนื่อง_แบบร่าง',properties:{},mergedRanges:[],protectedRanges:[],conditionalFormats:[],filterViews:[],basicFilter:null,rowMetadata:Array(baseRows).fill(null),columnMetadata:Array(29).fill(null)});
 client.getSheetGridInfo=async(_env,_sheet,policy)=>{policy?.budget?.consumeRead();return {sheetId:2,rowCount:h.formula().length,columnCount:29}};
 client.readMonthlyReportGrid=async(_env,_id,baseRows,policy)=>{for(let i=0;i<6;i++)policy.budget.consumeRead();return {rows:h.formula().length,columns:29,formula:structuredClone(h.formula()),effective:structuredClone(h.effective()),notes:structuredClone(notes),formats:structuredClone(formats),validations:structuredClone(validations),extras:structuredClone(extras),structure:structure(baseRows)}};
 notice.stableNoticePaused=async(_env,_stamp,_identity,budget)=>{budget?.consumeRead();budget?.consumeRead();return true};googleAuth.createGoogleOAuthLease=async(_env,budget)=>{budget.consumeRead();return {tokenFor(){return 'synthetic'}}};
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before,budget)=>{const ticket=budget.claimMutation();try{await before();ticket.consume();posts++;const cells=requests[2].updateCells.rows[0].values,f=blank(),e=blank();for(let c=0;c<25;c++){const v=cells[c]?.userEnteredValue;if(!v)continue;if(v.formulaValue)f[c]=v.formulaValue;else f[c]=e[c]=v.numberValue??v.stringValue;}
  Object.assign(e,{8:1.23,9:997.54,18:997.54,20:(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000});h.formula().push(f,blank());h.effective().push(e,blank());notes.push(blank(),blank());notes.at(-2)[19]=requests[3].updateCells.rows[0].values[0].note;const inherited=structuredClone(formats.at(-1));formats.push(structuredClone(formats[5]),inherited);validations.push(blank(),blank());extras.push(blank(),blank());
  if(mode==='post-tamper')h.formula()[3][4]='owner edit';if(mode==='lost-provider')throw Error('synthetic lost provider response');return {replies:requests.map(()=>({}))};}finally{ticket.release();}};
 const batch=h.DB.batch;h.DB.batch=async function(stmts){for(const s of stmts)if(/\bRETURNING\b/i.test(s.sql))s.runSync=function(){return {results:this.db.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}}};return batch.call(this,stmts)};
 h.sqlite.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_display','display','user','=literal',123,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1)");
 if(mode==='multi')h.sqlite.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_later','other','user','second',123,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1),('exp_invalid','bad','user','',123,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1),('exp_date_bad','bad-date','user','synthetic',123,'transfer','SHOP_BANK','ingredients','nonsense','CONFIRMED','now',1),('exp_date_month','bad-month','user','synthetic',123,'transfer','SHOP_BANK','ingredients','2026-11-99','CONFIRMED','now',1)");
 const preview=await operateMonthlyReport(h.env,'PREVIEW',workerHash);assert.equal(preview.status,'READY');assert.equal(preview.ready,mode==='multi'?2:1);if(mode==='multi'){assert.equal(preview.held,3);assert.deepEqual(preview.heldReasons,{SOURCE_INCOMPLETE:1,DATE_UNVERIFIED:1,INCIDENT_REVIEW:1});assert.equal(preview.unassignedDate,1);assert.deepEqual(preview.heldItems.map(x=>x.reason).sort(),['DATE_UNVERIFIED','INCIDENT_REVIEW','SOURCE_INCOMPLETE']);}assert.match(preview.candidate,/^[0-9a-f]{64}$/);
 if(mode==='unrelated-before')h.sqlite.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_other','other','user','other',100,'transfer','SHOP_BANK','ingredients','2026-11-21','CONFIRMED','now',1)");
 if(mode==='incident-child')h.sqlite.exec("INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,expense_id) VALUES('doc_changed','doc-msg','owner','RECEIPT','CONFIRMED','now','exp_test')");
 const result=await operateMonthlyReport(h.env,'APPEND_ONE',workerHash,preview.candidate),expected=mode==='incident-child'?'HELD':['ok','unrelated-before','multi'].includes(mode)?'DONE':'UNCERTAIN',expectedPosts=mode==='incident-child'?0:1;assert.equal(result.status,expected,mode);assert.equal(posts,expectedPosts);assert.deepEqual({...h.sqlite.prepare("SELECT * FROM expense_events WHERE expense_id='exp_test'").get()},beforeExpense);assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'REVIEW');assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 if(mode==='multi'){
  const next=await operateMonthlyReport(h.env,'PREVIEW',workerHash);assert.equal(next.status,'READY');assert.equal(next.ready,1);assert.equal(next.held,3);assert.notEqual(next.candidate,preview.candidate);
  assert.equal((await operateMonthlyReport(h.env,'APPEND_ONE',workerHash,next.candidate)).status,'DONE');assert.equal(posts,2);
  const end=await operateMonthlyReport(h.env,'PREVIEW',workerHash);assert.equal(end.status,'READY');assert.equal(end.ready,0);assert.equal(end.held,3);assert.equal(end.candidate,undefined);
  assert.equal((await operateMonthlyReport(h.env,'APPEND_ONE',workerHash,preview.candidate)).status,'HELD');assert.equal(posts,2);
 }else {assert.equal((await operateMonthlyReport(h.env,'APPEND_ONE',workerHash,preview.candidate)).status,'HELD');assert.equal(posts,expectedPosts);}
 }finally{client.readMonthlyReportGrid=originalRead;client.getSheetGridInfo=originalInfo;client.batchUpdateSpreadsheetWithReply=originalPost;notice.stableNoticePaused=originalNotice;googleAuth.createGoogleOAuthLease=originalLease;h.close();}}});
test('observed no-epoch incident source is read-only and bound to exact evidence',async()=>{const h=await fixture(false,true,'claim-token-recovery');try{
 h.setMode('timeout');await assert.rejects(h.run(),/synthetic lost response/);
 h.sqlite.exec("UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED' WHERE spreadsheet_id='book'; UPDATE sync_jobs SET status='REVIEW',lease_token=NULL,lease_until=NULL,last_error='STABLE_SYNC_REVIEW' WHERE job_id='job'");
 const evidence=h.sqlite.prepare('SELECT source_digest,marker FROM continuous_daily_write_evidence').get(),start=h.DB.batches.length,source=await readObservedDailyIncidentSource(h.env,h.job,h.claim,evidence.source_digest,evidence.marker);
 assert.ok(source);assert.equal(source.digest,evidence.source_digest);assert.equal(h.DB.batches.slice(start).every(batch=>batch.every(stmt=>/^\s*SELECT\b/i.test(stmt.sql))),true);
 assert.equal(await readObservedDailyIncidentSource(h.env,h.job,h.claim,evidence.source_digest,'INSERT_'+'0'.repeat(32)),null);
 h.sqlite.exec("UPDATE expense_events SET description='changed' WHERE expense_id='exp_test'");assert.equal(await readObservedDailyIncidentSource(h.env,h.job,h.claim,evidence.source_digest,evidence.marker),null);
 }finally{h.close();}});
test('inserts into first logical row after permanent anchor and verifies durable preimage',async()=>{const h=await fixture();try{
 await h.run();assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_expense_projection_preimages WHERE projection='DAILY'").get().n,1);
 await assert.rejects(h.run(),/DUPLICATE_ID/);assert.equal(h.writes(),1);
 }finally{h.close();}});
test('inserts safely when the final row is entirely blank',async()=>{const h=await fixture();try{
 h.formula().at(-1).fill(null);h.effective().at(-1).fill(null);
 await h.run();assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');
 const evidence=h.sqlite.prepare('SELECT * FROM continuous_daily_write_evidence').get(),coords={sheetId:evidence.sheet_id,row:evidence.target_row,rowCount:evidence.before_rows,columnCount:evidence.before_columns};
 assert.equal(await matchesCommittedDailyInsert({formula:h.formula().slice(0,-1),effective:h.effective().slice(0,-1)},coords,h.formula()[coords.row-1][24],evidence.before_digest,evidence.payload_digest),true);
 }finally{h.close();}});
test('repeated blank padding accepts only a contiguous, fully blank shifted suffix',async()=>{
 for(const fault of ['interior-gap','missing-helper','effective-value']){
  const h=await fixture();
  try{
   for(const grid of [h.formula(),h.effective()])grid.push(Array(29).fill(null),Array(29).fill(null));
   if(fault==='interior-gap')h.formula()[5].fill(null);
   if(fault==='missing-helper')h.formula()[6][8]=null;
   if(fault==='effective-value')h.effective().at(-2)[8]=123;
   await assert.rejects(h.run(),/INSERT_DAILY_(ROW_FORMULA|TAIL_UNVERIFIED)/,fault);
   assert.equal(h.writes(),0,fault);
   assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0,fault);
  }finally{h.close();}
 }
});

test('blank tail readback accepts one-row provider growth',async()=>{const h=await fixture();try{
 h.formula().at(-1).fill(null);h.effective().at(-1).fill(null);h.setMode('one-growth');await h.run();
 assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');
 }finally{h.close();}});
test('blank tail readback rejects a nonblank formula or effective value in any extra column',async()=>{for(const mode of ['tail-tamper','tail-effective']){const h=await fixture();try{
 h.formula().at(-1).fill(null);h.effective().at(-1).fill(null);h.setMode(mode);
 await assert.rejects(h.run(),/INSERT_DAILY_READBACK_UNCERTAIN/);assert.equal(h.writes(),1);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 }finally{h.close();}}});
test('blank tail readback rejects changed identity or unexpected grid growth',async()=>{for(const mode of ['identity-drift','three-growth']){const h=await fixture();try{
 h.formula().at(-1).fill(null);h.effective().at(-1).fill(null);h.setMode(mode);
 await assert.rejects(h.run(),/INSERT_DAILY_SNAPSHOT_UNVERIFIED/);assert.equal(h.writes(),1);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 }finally{h.close();}}});
test('lost ACK with blank tail retains intent and does not write again',async()=>{const h=await fixture();try{
 h.formula().at(-1).fill(null);h.effective().at(-1).fill(null);h.setMode('timeout');
 await assert.rejects(h.run(),/synthetic lost response/);assert.equal(h.writes(),1);
 await assert.rejects(h.run());assert.equal(h.writes(),1);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 }finally{h.close();}});
test('metadata GET failure after ACK retains intent and never repeats the write',async()=>{const h=await fixture();try{
 h.formula().at(-1).fill(null);h.effective().at(-1).fill(null);h.setMode('metadata-error');
 await assert.rejects(h.run(),/synthetic metadata timeout/);assert.equal(h.writes(),1);
 await assert.rejects(h.run());assert.equal(h.writes(),1);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 }finally{h.close();}});
test('blank tail respects the 5000-row limit before reservation',async()=>{for(const count of [4998,4999]){const h=await fixture();try{
 while(h.formula().length<count){const row=h.formula().length+1,f=Array(29).fill(null);Object.assign(f,continuousDailyHelperFormulas(row));h.formula().push(f);h.effective().push(Array(29).fill(null));}
 h.formula().at(-1).fill(null);h.effective().at(-1).fill(null);
 if(count===4998){await h.run();assert.equal(h.formula().length,5000);assert.equal(h.writes(),1);}
 else {await assert.rejects(h.run(),/INSERT_DAILY_CAPACITY/);assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes").get().n,0);}
 }finally{h.close();}}});

async function publicationFixture(mode='ok',includeItem=false){
 const h=await fixture(false,true,'claim-token-stage',includeItem);
 h.env.STABLE_SHEETS_PACING_ENABLED='true';
 claimApi.stableWorkbookClaimOwned=async(_env,_claim,budget)=>{if(budget){budget.consumeRead();budget.consumeRead();}return true;};
 const pub=require('../dist/sheets/continuous-publication-template.js'),{combinedLedgerSpillFormulas}=await import('../scripts/combined-ledger-report-formulas.mjs');
 const marker={expenseId:'exp_test',version:1,nonce:'a'.repeat(32),state:'STAGED',detailCount:includeItem?1:0},value=pub.encodePublicationCarrier(marker),target={sheet:'pub',sheetId:50,rows:3,row:2,expected:marker,sourceDigest:h.source.digest};
 h.sqlite.exec("UPDATE sync_jobs SET lease_token='lease-token' WHERE job_id='job'");
 h.sqlite.prepare("INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at) VALUES('stage-operation','book','exp_test',50,'pub',2,'STAGE',1,?,?,'claim-token-stage','lease-token','EMPTY',?,?,?,?,?,'IN_FLIGHT','now','now')").run(h.source.revision,h.source.digest,'d'.repeat(32),marker.nonce,marker.detailCount,pub.publicationEmptyMarker(2,'d'.repeat(32)),value);
 h.sqlite.exec("UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='stage-operation'");
 h.sqlite.prepare("INSERT INTO continuous_publication_markers(spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,version,state,marker,transition_id,created_at,updated_at) VALUES('book','exp_test',50,'pub',2,1,'STAGED',?,'stage-operation','now','now')").run(value);
 const grid=client.getSheetGridInfo,formula=client.batchGetSheetFormulaValues,effective=client.batchGetSheetEffectiveSerialValues,metadata=client.getSpreadsheetSheetProperties,formats=client.getSheetCellNumberFormats;
 const view=combinedLedgerSpillFormulas({rawNew:'raw_new',detailNew:'detail_new',rawCombined:'V52_EXPENSE_RAW_ALL',detailCombined:'V52_PURCHASE_DETAIL_ALL',rawOldRows:1000,rawNewRows:6,detailOldRows:1000,detailNewRows:6,publishedDaily:'draft'});
 let pubColumn=[['Publication_Marker'],[value],[pub.publicationEmptyMarker(3,'e'.repeat(32))]],writes=0,reads=0,instrumentGrid=false;
 // Worst case for a post-write metadata GET includes an OAuth refresh.
 client.getSheetGridInfo=async(env,name,policy)=>{if(instrumentGrid){policy?.budget?.consumeRead();policy?.budget?.consumeRead();}return name==='pub'?{sheetId:50,rowCount:3,columnCount:1}:grid(env,name,policy);};
 client.getSpreadsheetSheetProperties=async(env,policy)=>{policy?.budget?.consumeRead();return[...await metadata(env,policy),{sheetId:1,title:'รายวัน',rowCount:10,columnCount:25},{sheetId:2,title:'draft',rowCount:h.formula().length,columnCount:29},{sheetId:50,title:'pub',rowCount:3,columnCount:1}];};
 client.getSheetCellNumberFormats=async(env,name,id,row,policy)=>{policy?.budget?.consumeRead();return formats(env,name,id,row,policy);};
 client.batchGetSheetFormulaValues=async(env,ranges,policy)=>{policy?.budget?.consumeRead();return Promise.all(ranges.map(async r=>{
  if(r.startsWith("'pub'!")){reads++;return structuredClone(pubColumn);}if(r.startsWith("'รายวัน'!"))return [];
  if(r.startsWith("'V52_EXPENSE_RAW_ALL'!"))return [[view.raw]];if(r.startsWith("'V52_PURCHASE_DETAIL_ALL'!"))return [[view.detail]];
  if(r.startsWith("'97_EXPENSE_CLEAN'!")&&r!=="'97_EXPENSE_CLEAN'!A2:A2")return [[],['=1+1']];
  return (await formula(env,[r],policy))[0];
 }));};
 client.batchGetSheetEffectiveSerialValues=async(env,ranges,policy)=>{policy?.budget?.consumeRead();return Promise.all(ranges.map(async r=>{
  if(r.startsWith("'pub'!"))return structuredClone(pubColumn);if(r.startsWith("'รายวัน'!"))return [];
  if(r.startsWith("'V52_EXPENSE_RAW_ALL'!"))return [['Expense_ID']];if(r.startsWith("'V52_PURCHASE_DETAIL_ALL'!"))return [['Purchase_Item_ID','Expense_ID']];
  if(r==="'97_EXPENSE_CLEAN'!A2:A2")return [];
  if(r.startsWith("'97_EXPENSE_CLEAN'!"))return [['Date','Expense_ID / Legacy row','Description','Amount','Wallet','Category','Source','Sales_Addback_Basis']];
  return (await effective(env,[r],policy))[0];
 }));};
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before,budget)=>{
  const ticket=budget?.claimMutation();
  try{
  if(mode==='changed-before')pubColumn[1][0]='changed';
  if(mode==='budget-before')while(budget.remaining>6)budget.consumeRead();
  await before();ticket?.consume();writes++;
  if(requests[0].findReplace){const change=requests[0].findReplace,i=change.range.startRowIndex,lf=change.range.sheetId===4?h.detailFormula():h.rawFormula(),le=change.range.sheetId===4?h.detailEffective():h.rawEffective();assert.equal(lf[i][25],change.find);lf[i][25]=le[i][25]=change.replacement;ledgerCarrierDisplay(decodeLedgerCarrier(change.replacement)).forEach((v,c)=>{le[i][c]=v});if(mode==='lost-ack')throw Error('synthetic lost ACK');if(mode==='changed-after')pubColumn[1][0]='changed';return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};}
  const offset=requests[0].appendDimension?1:0,index=requests[offset].insertRange.range.startRowIndex,values=requests[offset+1].updateCells.rows[0].values,f=h.formula(),e=h.effective();assert.equal(requests[offset].insertRange.range.endColumnIndex,26);
  const oldF=structuredClone(f),oldE=structuredClone(e);f.push(Array(29).fill(null));e.push(Array(29).fill(null));
  if(offset){f.push(Array(29).fill(null));e.push(Array(29).fill(null));}
  for(let i=index;i<oldF.length;i++)for(let c=0;c<26;c++){f[i+1][c]=oldF[i][c];e[i+1][c]=oldE[i][c];}
  for(let i=index+1;i<f.length;i++)if(oldF[i-1]?.[8])Object.assign(f[i],continuousDailyHelperFormulas(i+1));
  for(let c=0;c<26;c++){f[index][c]=values[c].userEnteredValue?.formulaValue??values[c].userEnteredValue?.stringValue??null;e[index][c]=null;}
  e[index][24]=f[index][24];e[index][25]='STAGED';
  if(mode==='lost-ack')throw Error('synthetic lost ACK');if(mode==='changed-after')pubColumn[1][0]='changed';return{replies:requests.map(()=>({}))};
  }finally{ticket?.release();}
 };
 const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js');let lastBudget;
 return{...h,target,pub,reads:()=>reads,publicationWrites:()=>writes,lastBudget:()=>lastBudget,instrumentGrid(){instrumentGrid=true;},setPublicationMode(value){mode=value;},setPublicationValue(value){pubColumn[1][0]=value;},async runPublication(limit=40){lastBudget=typeof limit==='number'?new ReviewRequestBudget(limit):limit;return insertDailyExpenseUnderClaim(h.env,h.job,'lease-token',h.claim,h.source,'draft',2,target,lastBudget);}};
}
test('opt-in staged insert proves provider marker, keeps public columns empty and verifies preimage',async()=>{const h=await publicationFixture();try{
 await h.runPublication();assert.equal(h.publicationWrites(),1);assert.ok(h.reads()>=3);assert.equal(h.lastBudget().used,25);assert.equal(h.lastBudget().reserved,false);assert.equal(h.lastBudget().postReserved,0);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');
 assert.equal(h.effective()[4][23],null);assert.equal(h.effective()[4][25],'STAGED');assert.equal(decodeAtomicDailyPayload(h.formula()[4][24]).publicationVersion,1);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_expense_projection_preimages WHERE projection='DAILY'").get().n,1);
}finally{h.close();}});
test('staged insert checks both extra blank tail and reserved read budget',async()=>{const h=await publicationFixture();try{
 h.formula().at(-1).fill(null);h.effective().at(-1).fill(null);
 h.instrumentGrid();
 const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js');
 await h.runPublication(new ReviewRequestBudget(48,'invocation'));assert.equal(h.publicationWrites(),1);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');
 assert.equal(h.lastBudget().used,27);assert.equal(h.lastBudget().postReserved,0);
}finally{h.close();}});
test('staged blank tail without enough read budget stops before intent',async()=>{const h=await publicationFixture();try{
 h.formula().at(-1).fill(null);h.effective().at(-1).fill(null);
 await assert.rejects(h.runPublication(),/INSERT_DAILY_PUBLICATION_BUDGET/);assert.equal(h.publicationWrites(),0);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes WHERE projection='DAILY'").get().n,0);
}finally{h.close();}});
test('grouped staged insert stops before intent when postimage budget cannot be reserved',async()=>{const h=await publicationFixture();try{
 await assert.rejects(h.runPublication(35),/INSERT_DAILY_PUBLICATION_BUDGET/);assert.equal(h.publicationWrites(),0);assert.equal(h.lastBudget().reserved,false);assert.equal(h.lastBudget().postReserved,0);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes WHERE projection='DAILY'").get().n,0);
}finally{h.close();}});
test('staged insert does not release another operation’s existing budget reservation',async()=>{for(const which of ['mutation','post']){const h=await publicationFixture();try{
 const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),budget=new ReviewRequestBudget(40);
 assert.equal(which==='mutation'?budget.reserveMutation():budget.reservePost(1),true);
 await assert.rejects(h.runPublication(budget),/INSERT_DAILY_PUBLICATION_BUDGET/);assert.equal(h.publicationWrites(),0);
 assert.equal(which==='mutation'?budget.reserved:budget.postReserved===1,true);
}finally{h.close();}}});
test('opt-in staged insert holds on changed marker or spent budget and never retries lost ACK',async()=>{for(const mode of ['changed-before','budget-before','changed-after','lost-ack']){const h=await publicationFixture(mode);try{
 await assert.rejects(h.runPublication());assert.equal(h.publicationWrites(),['changed-before','budget-before'].includes(mode)?0:1);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 if(mode==='lost-ack'){
  const ev=h.sqlite.prepare("SELECT * FROM continuous_daily_write_evidence WHERE entity_id='exp_test'").get(),coords={sheetId:ev.sheet_id,row:ev.target_row,rowCount:ev.before_rows,columnCount:ev.before_columns},payload=h.formula()[4][24],snapshot={formula:h.formula(),effective:h.effective()};
  assert.equal(await matchesCommittedDailyInsert(snapshot,coords,payload,ev.before_digest,ev.payload_digest,h.target),true);
  assert.equal(await matchesCommittedDailyInsert(snapshot,coords,payload,ev.before_digest,ev.payload_digest),false);
  snapshot.effective[4][25]='PUBLISHED';assert.equal(await matchesCommittedDailyInsert(snapshot,coords,payload,ev.before_digest,ev.payload_digest,h.target),false);snapshot.effective[4][25]='STAGED';
 }
 await assert.rejects(h.runPublication());assert.equal(h.publicationWrites(),['changed-before','budget-before'].includes(mode)?0:1);
}finally{h.close();}}});
test('staged RAW writer checks marker, hides projection and verifies guarded journal',async()=>{const h=await publicationFixture();try{
 await h.runPublication();const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{writeCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-writer.js'),budget=new ReviewRequestBudget(40);
 await writeCarrierLedgerUnderClaim(h.env,h.job,'lease-token',h.claim,h.source,'EXPENSE_RAW',undefined,h.target,budget);
 assert.equal(h.publicationWrites(),2);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='EXPENSE_RAW'").get().state,'VERIFIED');assert.equal(h.rawEffective()[1][0],'exp_test');assert.equal(budget.used,24);assert.equal(budget.postReserved,0);
}finally{h.close();}});
test('staged RAW writer retains unknown intent when marker changes or ACK is lost',async()=>{for(const mode of ['changed-before','changed-after','lost-ack']){const h=await publicationFixture();try{
 await h.runPublication();h.setPublicationMode(mode);const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{writeCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-writer.js'),run=()=>writeCarrierLedgerUnderClaim(h.env,h.job,'lease-token',h.claim,h.source,'EXPENSE_RAW',undefined,h.target,new ReviewRequestBudget(40));
 await assert.rejects(run());assert.equal(h.publicationWrites(),mode==='changed-before'?1:2);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='EXPENSE_RAW'").get().state,'IN_FLIGHT');await assert.rejects(run());assert.equal(h.publicationWrites(),mode==='changed-before'?1:2);
}finally{h.close();}}});
test('staged DETAIL writer retains exact item identity and guarded postimage',async()=>{const h=await publicationFixture('ok',true);try{
 await h.runPublication();const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{writeCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-writer.js'),budget=new ReviewRequestBudget(40);
 await writeCarrierLedgerUnderClaim(h.env,h.job,'lease-token',h.claim,h.source,'DETAIL','item_1',h.target,budget);
 assert.equal(h.detailEffective()[1][0],'item_1');assert.equal(h.detailEffective()[1][1],'exp_test');assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DETAIL' AND entity_id='exp_test|item_1'").get().state,'VERIFIED');assert.equal(budget.used,24);
}finally{h.close();}});
test('staged ledger writer stops before reservation when postimage budget is too small',async()=>{const h=await publicationFixture();try{
 await h.runPublication();const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{writeCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-writer.js'),budget=new ReviewRequestBudget(35);
 await assert.rejects(writeCarrierLedgerUnderClaim(h.env,h.job,'lease-token',h.claim,h.source,'EXPENSE_RAW',undefined,h.target,budget),/LEDGER_PUBLICATION_BUDGET/);assert.equal(h.publicationWrites(),1);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes WHERE projection='EXPENSE_RAW'").get().n,0);assert.equal(budget.postReserved,0);
}finally{h.close();}});

async function revokedPublicationFixture(mode='ok',includeItem=false){
 const h=await publicationFixture('ok',includeItem);await h.runPublication();
 const old=h.target.expected,published={...old,nonce:'b'.repeat(32),state:'PUBLISHED'};
 const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{writeCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-writer.js');
 await writeCarrierLedgerUnderClaim(h.env,h.job,'lease-token',h.claim,h.source,'EXPENSE_RAW',undefined,h.target,new ReviewRequestBudget(40));
 if(includeItem)await writeCarrierLedgerUnderClaim(h.env,h.job,'lease-token',h.claim,h.source,'DETAIL','item_1',h.target,new ReviewRequestBudget(40));
 h.sqlite.prepare("INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at) VALUES('publish-operation','book','exp_test',50,'pub',2,'PUBLISH',1,?,?,'claim-token-stage','lease-token','STAGED',?,?,?,?,?,'IN_FLIGHT','now','now')").run(h.source.revision,h.source.digest,old.nonce,published.nonce,old.detailCount,h.pub.encodePublicationCarrier(old),h.pub.encodePublicationCarrier(published));
 h.sqlite.exec("UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='publish-operation'");
 h.sqlite.prepare("UPDATE continuous_publication_markers SET state='PUBLISHED',marker=?,transition_id='publish-operation' WHERE entity_id='exp_test'").run(h.pub.encodePublicationCarrier(published));
 h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2,updated_at='2026-11-15T11:00:00.000Z' WHERE expense_id='exp_test'; INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('undo','EXPENSE','exp_test',2,'undo-trace','PROCESSING','now','2099-01-01T00:00:00.000Z','cancel-lease')");
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:2},cancelled=await require('../dist/sheets/cancelled-expense-source.js').readCancelledExpenseSource(h.env,job,h.claim,'cancel-lease');assert.ok(cancelled);
 const revoked={...published,nonce:'c'.repeat(32),version:2,state:'REVOKED'},value=h.pub.encodePublicationCarrier(revoked),target={...h.target,expected:revoked,sourceDigest:cancelled.digest};
 h.sqlite.prepare("INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at) VALUES('revoke-operation','book','exp_test',50,'pub',2,'REVOKE',2,?,?,'claim-token-stage','cancel-lease','PUBLISHED',?,?,?,?,?,'IN_FLIGHT','now','now')").run(cancelled.revision,cancelled.digest,published.nonce,revoked.nonce,published.detailCount,h.pub.encodePublicationCarrier(published),value);
 h.sqlite.exec("UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='revoke-operation'");
 h.sqlite.prepare("UPDATE continuous_publication_markers SET state='REVOKED',version=2,marker=?,transition_id='revoke-operation' WHERE entity_id='exp_test'").run(value);
 h.setPublicationValue(value);h.effective()[4][25]='REVOKED';let writes=0,cancelMode=mode;
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before,budget)=>{const ticket=budget?.claimMutation();try{if(cancelMode==='changed-before')h.setPublicationValue('changed');await before();ticket?.consume();writes++;const change=requests[0].findReplace,row=change.range.startRowIndex;if(change.range.sheetId===2){assert.equal(h.formula()[row][24],change.find);h.formula()[row][24]=h.effective()[row][24]=change.replacement;h.effective()[row][25]='';}else{const f=change.range.sheetId===4?h.detailFormula():h.rawFormula(),e=change.range.sheetId===4?h.detailEffective():h.rawEffective();assert.equal(f[row][25],change.find);f[row][25]=e[row][25]=change.replacement;ledgerCarrierDisplay(decodeLedgerCarrier(change.replacement)).forEach((v,c)=>{e[row][c]=v});}if(cancelMode==='lost-ack')throw Error('synthetic cancel lost ACK');if(cancelMode==='changed-after')h.setPublicationValue('changed');return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};}finally{ticket?.release();}};
 return{...h,target,undoJob:job,cancelWrites:()=>writes,setCancelMode(value){cancelMode=value;},runCancel:()=>cancelAtomicDailyCandidateUnderClaim(h.env,job,'cancel-lease',h.claim,'draft',2,target,new ReviewRequestBudget(40))};
}
test('REVOKE handoff checks real DAILY, RAW and DETAIL preimages and rejects changed projection',async()=>{
 const h=await revokedPublicationFixture('ok',true),pubRoute=require('../dist/sheets/continuous-publication-route.js'),sourceApi=require('../dist/sheets/continuous-publication-reviewed-source.js'),noticeApi=require('../dist/sheets/continuous-reviewed-notice.js'),planApi=require('../dist/sheets/publication-snapshot-plan.js'),snapApi=require('../dist/sheets/publication-batch-snapshot.js'),healthApi=require('../dist/sheets/continuous-report-health.js'),{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{verifyPublicationHandoff}=require('../dist/sheets/continuous-publication-handoff.js'),old=[pubRoute.resolvePublicationTarget,sourceApi.readReviewedPublicationSource,noticeApi.reviewedNoticeMatches,planApi.planPublicationSnapshot,snapApi.capturePublicationBatchSnapshot,healthApi.readContinuousReportHealth];
 try{
  h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_until=NULL,lease_token=NULL WHERE job_id='undo'; UPDATE stable_workbook_claims SET phase='END_NOTICE_PENDING' WHERE spreadsheet_id='book'");
  const metadata=[{sheetId:2,title:'draft',rowCount:9,columnCount:29},{sheetId:1,title:'รายวัน',rowCount:10,columnCount:25},{sheetId:3,title:'raw_new',rowCount:6,columnCount:26},{sheetId:4,title:'detail_new',rowCount:6,columnCount:26},{sheetId:50,title:'pub',rowCount:3,columnCount:1}],specs=metadata.map(s=>({sheetId:s.sheetId,sheetName:s.title,rows:s.rowCount,columns:s.columnCount}));
  pubRoute.resolvePublicationTarget=async()=>({sheetId:50,sheetName:'pub',rows:3});sourceApi.readReviewedPublicationSource=async()=>({revision:1,digest:h.target.sourceDigest,kind:'REVOKE',noticeStamp:'stamp',noticeIdentity:'identity'});noticeApi.reviewedNoticeMatches=async()=>true;planApi.planPublicationSnapshot=async()=>specs;healthApi.readContinuousReportHealth=async()=> 'OK';
  snapApi.capturePublicationBatchSnapshot=async()=>{const marker=[['Publication_Marker'],[h.pub.encodePublicationCarrier(h.target.expected)],[h.pub.publicationEmptyMarker(3,'e'.repeat(32))]];return{metadata,specs,formula:[structuredClone(h.formula()),[],structuredClone(h.rawFormula()),structuredClone(h.detailFormula()),marker],effective:[structuredClone(h.effective()),[],structuredClone(h.rawEffective()),structuredClone(h.detailEffective()),structuredClone(marker)]};};
  const run=()=>verifyPublicationHandoff(h.env,h.undoJob,h.claim,'revoke-operation','PAUSED',{kind:'continuous-expense',budget:new ReviewRequestBudget(40)},'HANDOFF');
  assert.equal(await run(),true);h.rawEffective()[1][3]=999;await assert.rejects(run(),/LEDGER_CARRIER/);
 }finally{[pubRoute.resolvePublicationTarget,sourceApi.readReviewedPublicationSource,noticeApi.reviewedNoticeMatches,planApi.planPublicationSnapshot,snapApi.capturePublicationBatchSnapshot,healthApi.readContinuousReportHealth]=old;h.close();}
});
test('revoked publication permits only exact cancellation and preserves formula plus prior preimage',async()=>{const h=await revokedPublicationFixture();try{
 const formula=h.formula()[4][25];await h.runCancel();assert.equal(h.cancelWrites(),1);assert.equal(h.formula()[4][25],formula);assert.equal(h.effective()[4][25],'');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_expense_cancellation_writes WHERE projection='DAILY'").get().state,'VERIFIED');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_expense_projection_preimages WHERE projection='DAILY'").get().n,1);
}finally{h.close();}});
test('revoked RAW cancellation requires verified daily Undo and preserves owner addback',async()=>{const h=await revokedPublicationFixture();try{
 const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{cancelCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-cancellation.js'),run=budget=>cancelCarrierLedgerUnderClaim(h.env,h.undoJob,'cancel-lease',h.claim,'EXPENSE_RAW',undefined,h.target,budget);
 await assert.rejects(run(new ReviewRequestBudget(40)),/LEDGER_CANCEL_SOURCE/);assert.equal(h.cancelWrites(),0);
 await h.runCancel();h.rawFormula()[1][17]=h.rawEffective()[1][17]=5.5;
 const budget=new ReviewRequestBudget(40);await run(budget);
 assert.equal(h.rawEffective()[1][7],'CANCELLED');assert.equal(h.rawFormula()[1][17],5.5);assert.equal(h.rawEffective()[1][17],5.5);assert.equal(h.sqlite.prepare("SELECT state FROM stable_expense_cancellation_writes WHERE projection='EXPENSE_RAW'").get().state,'VERIFIED');assert.equal(budget.used,24);
}finally{h.close();}});
test('revoked RAW cancellation holds on marker change or lost ACK and does not repeat',async()=>{for(const mode of ['changed-before','changed-after','lost-ack']){const h=await revokedPublicationFixture();try{
 await h.runCancel();h.setCancelMode(mode);const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{cancelCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-cancellation.js'),run=()=>cancelCarrierLedgerUnderClaim(h.env,h.undoJob,'cancel-lease',h.claim,'EXPENSE_RAW',undefined,h.target,new ReviewRequestBudget(40));
 await assert.rejects(run());assert.equal(h.cancelWrites(),mode==='changed-before'?1:2);assert.equal(h.sqlite.prepare("SELECT state FROM stable_expense_cancellation_writes WHERE projection='EXPENSE_RAW'").get().state,'IN_FLIGHT');await assert.rejects(run());assert.equal(h.cancelWrites(),mode==='changed-before'?1:2);
}finally{h.close();}}});
test('revoked DETAIL cancellation changes only the exact item after daily Undo',async()=>{const h=await revokedPublicationFixture('ok',true);try{
 await h.runCancel();const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{cancelCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-cancellation.js'),budget=new ReviewRequestBudget(40);
 await cancelCarrierLedgerUnderClaim(h.env,h.undoJob,'cancel-lease',h.claim,'DETAIL','item_1',h.target,budget);
 assert.equal(h.detailEffective()[1][0],'item_1');assert.equal(h.detailEffective()[1][16],'CANCELLED');assert.equal(h.sqlite.prepare("SELECT state FROM stable_expense_cancellation_writes WHERE projection='DETAIL' AND entity_id='exp_test|item_1'").get().state,'VERIFIED');assert.equal(budget.used,24);
}finally{h.close();}});
test('revoked ledger Undo retains source untouched when postimage budget is too low',async()=>{const h=await revokedPublicationFixture();try{
 await h.runCancel();const {ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{cancelCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-cancellation.js'),budget=new ReviewRequestBudget(35);
 await assert.rejects(cancelCarrierLedgerUnderClaim(h.env,h.undoJob,'cancel-lease',h.claim,'EXPENSE_RAW',undefined,h.target,budget),/LEDGER_CANCEL_PUBLICATION_BUDGET/);
 assert.equal(h.cancelWrites(),1);assert.equal(h.rawEffective()[1][7],'CONFIRMED');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_expense_cancellation_writes WHERE projection='EXPENSE_RAW'").get().n,0);assert.equal(budget.postReserved,0);
}finally{h.close();}});
test('grouped revoked Undo shares three bounded snapshots and checks budget before intent',async()=>{for(const limit of [40,25]){
 const h=await revokedPublicationFixture(),snapshotApi=require('../dist/sheets/publication-batch-snapshot.js'),planApi=require('../dist/sheets/publication-snapshot-plan.js'),health=require('../dist/sheets/continuous-report-health.js'),{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),oldCapture=snapshotApi.capturePublicationBatchSnapshot,oldPlan=planApi.planPublicationSnapshot,oldHealth=health.readContinuousReportHealth,oldMetadata=client.getSpreadsheetSheetProperties,oldGrid=client.getSheetGridInfo,oldWrite=client.batchUpdateSpreadsheetWithReply,oldOwned=claimApi.stableWorkbookClaimOwned;let captures=0;
 try{
  h.env.STABLE_SHEETS_PACING_ENABLED='true';const budget=new ReviewRequestBudget(limit),specs=[{sheetId:2,sheetName:'draft',rows:9,columns:29},{sheetId:50,sheetName:'pub',rows:3,columns:1}],metadata=specs.map(s=>({sheetId:s.sheetId,title:s.sheetName,rowCount:s.rows,columnCount:s.columns}));
  client.getSpreadsheetSheetProperties=async(_env,policy)=>{policy?.budget?.consumeRead();return metadata;};client.getSheetGridInfo=async(env,name,policy)=>{policy?.budget?.consumeRead();return oldGrid(env,name,policy);};planApi.planPublicationSnapshot=async()=>specs;health.readContinuousReportHealth=async()=> 'OK';
  client.batchUpdateSpreadsheetWithReply=async(env,requests,before,b)=>{const ticket=b?.claimMutation();try{return await oldWrite(env,requests,async()=>{await before();ticket?.consume();});}finally{ticket?.release();}};
  snapshotApi.capturePublicationBatchSnapshot=async(_env,_specs,b)=>{captures++;for(let i=0;i<4;i++)b.consumeRead();const marker=[['Publication_Marker'],[h.pub.encodePublicationCarrier(h.target.expected)],[h.pub.publicationEmptyMarker(3,'e'.repeat(32))]];return{specs,metadata,formula:[structuredClone(h.formula()),structuredClone(marker)],effective:[structuredClone(h.effective()),structuredClone(marker)]};};
  claimApi.stableWorkbookClaimOwned=async(_env,_claim,b)=>{if(b){b.consumeRead();b.consumeRead();}return true;};
  const run=()=>cancelAtomicDailyCandidateUnderClaim(h.env,h.undoJob,'cancel-lease',h.claim,'draft',2,h.target,budget);
  if(limit===40){await run();assert.equal(h.cancelWrites(),1);assert.equal(captures,3);assert.equal(h.sqlite.prepare("SELECT state FROM stable_expense_cancellation_writes WHERE projection='DAILY'").get().state,'VERIFIED');assert.equal(budget.used,25);}
  else{await assert.rejects(run,/ATOMIC_CANCEL_BUDGET_POSTIMAGE/);assert.equal(h.cancelWrites(),0);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_expense_cancellation_writes WHERE projection='DAILY'").get().n,0);}
 }finally{snapshotApi.capturePublicationBatchSnapshot=oldCapture;planApi.planPublicationSnapshot=oldPlan;health.readContinuousReportHealth=oldHealth;client.getSpreadsheetSheetProperties=oldMetadata;client.getSheetGridInfo=oldGrid;client.batchUpdateSpreadsheetWithReply=oldWrite;claimApi.stableWorkbookClaimOwned=oldOwned;h.close();}
}});
test('revoked cancellation holds if marker changes or ACK is lost, and never resends',async()=>{for(const mode of ['changed-before','changed-after','lost-ack']){const h=await revokedPublicationFixture(mode);try{
 await assert.rejects(h.runCancel());assert.equal(h.cancelWrites(),mode==='changed-before'?0:1);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_expense_cancellation_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 if(mode==='lost-ack'){
  const ev=h.sqlite.prepare("SELECT * FROM continuous_daily_cancel_evidence WHERE entity_id='exp_test'").get(),c={sheetId:ev.sheet_id,row:ev.target_row,rowCount:ev.row_count,columnCount:ev.column_count,year:ev.posting_year,month:ev.posting_month};
  const {matchesCommittedDailyCancellation}=require('../dist/sheets/continuous-daily-cancel-evidence.js'),snapshot={formula:h.formula(),effective:h.effective()};
  assert.equal(await matchesCommittedDailyCancellation(snapshot,c,'exp_test',ev.tombstone,ev.masked_before_digest,true),true);
  assert.equal(await matchesCommittedDailyCancellation(snapshot,c,'exp_test',ev.tombstone,ev.masked_before_digest),false);
 }
 await assert.rejects(h.runCancel());assert.equal(h.cancelWrites(),mode==='changed-before'?0:1);
}finally{h.close();}}});
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
test('an explicitly scoped extra trailing row must be entirely blank before positive recovery',async()=>{const h=await reviewedLostDaily();try{
 h.formula().push(Array(29).fill(null));h.effective().push(Array(29).fill(null));
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim),false);
 h.formula().at(-1)[28]='unexpected';assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim,'PAUSED',undefined,'REVIEW',true),false);
 h.formula().at(-1)[28]=null;h.effective().at(-1)[1]='unexpected';assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim,'PAUSED',undefined,'REVIEW',true),false);
 h.effective().at(-1)[1]=null;const diagnostic={stage:''};assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim,'PAUSED',undefined,'REVIEW',true,diagnostic),true);
 assert.equal(h.writes(),1);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim,'PAUSED',undefined,'REVIEW',true,diagnostic),true);assert.equal(diagnostic.stage,'COMPLETE');
 }finally{h.close();}});
async function historicalDailyReceiptFixture(h,row,fingerprint){
  const {historicalDailyReceiptDigest,prepareHistoricalDailyReceipt}=require('../dist/sheets/exact-daily-historical-receipt.js');
  h.formula().push(Array(29).fill(null));h.effective().push(Array(29).fill(null));
  const coords={sheetId:row.sheet_id,row:row.target_row,rowCount:row.before_rows,columnCount:row.before_columns};
  const sheet={sheetId:row.sheet_id,sheetName:row.sheet_name,rowCount:row.before_rows+2,columnCount:row.before_columns};
  const archive={...sheet,spreadsheetId:'backup-book',sourceSpreadsheetId:'book',createdAt:'2026-11-21T12:41:28.055Z',
   values:{formula:structuredClone(h.formula()),effective:structuredClone(h.effective())}};
  const edited='synthetic approved header edit';
  const differences=[[1,1,archive.values.formula[0][0]??null,archive.values.effective[0][0]??null,edited,edited]];
  h.formula()[0][0]=h.effective()[0][0]=edited;
  const current={fingerprint,spreadsheetId:'book',sheetName:row.sheet_name,coordinates:coords,beforeDigest:row.before_digest,payloadDigest:row.payload_digest};
  const policy={...current,backupSpreadsheetId:archive.spreadsheetId,backupCreatedAt:archive.createdAt,
   expectedDeltaDigest:createHash('sha256').update(JSON.stringify(['issue296-daily-above-insert-delta-v1',row.sheet_id,row.target_row,row.before_digest,archive.createdAt,differences])).digest('hex')};
  const payload=h.formula()[row.target_row-1][24];
  const live={...sheet,spreadsheetId:'book',values:{formula:h.formula(),effective:h.effective()}};
  const receipt=await prepareHistoricalDailyReceipt(policy,current,payload,archive,live,'42');
  assert.ok(receipt);
  return {edited,receipt,pin:await historicalDailyReceiptDigest(receipt)};
}
test('approved historical DAILY readback preserves the live proof checks and makes no writes',async()=>{
 const h=await reviewedLostDaily(),{proveDailyProviderPostimage}=require('../dist/sheets/exact-daily-provider-proof.js');
 const reports=require('../dist/sheets/continuous-report-health.js'),originalReport=reports.readContinuousReportHealth;
 try{
  const row={...h.sqlite.prepare('SELECT * FROM continuous_daily_write_evidence').get(),notice_stamp:'stamp',notice_identity:'identity',projection_state:'IN_FLIGHT'};
  const fingerprint='d'.repeat(64),{edited,receipt,pin}=await historicalDailyReceiptFixture(h,row,fingerprint);
  const historical={fingerprint,receipt};
  const state=()=>['stable_workbook_claims','stable_projection_writes','stable_expense_projection_preimages','stable_recovery_epochs','sync_jobs']
   .map(table=>h.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  const before=state(),marks=[];
  let ready=true,report='OK',reportReads=0,changeWhileReading=false,changeScope=false;
  reports.readContinuousReportHealth=async()=>{reportReads++;return report;};
  const prove=approval=>proveDailyProviderPostimage(h.env,h.job,h.claim,row,h.source,{sheet:row.sheet_name,sheetId:row.sheet_id},
   {kind:'continuous-expense'},()=>true,async()=>{
    if(changeWhileReading)h.formula()[0][0]='changed during proof';
    if(changeScope)h.env.EXACT_DAILY_HISTORICAL_RECEIPT_SHA256='a'.repeat(64);
    return h.source;
   },async()=>ready,true,step=>marks.push(step),false,approval);
  assert.equal(await prove(),null,'strict verification still requires the live preimage hash');
  assert.equal(marks.at(-1),'POSTIMAGE');
  assert.equal(await prove(historical),null,'the deployed receipt pin is required');
  h.env.EXACT_DAILY_HISTORICAL_RECEIPT_SHA256=pin;
  const verified=await prove(historical);
  assert.ok(verified);
  assert.equal(verified.snapshot.formula[0][0],edited,'return the live record, not the reconstructed grid');
  assert.equal(reportReads,2,'both report checks ran on the authorized proof');
  assert.deepEqual(state(),before);
  ready=false;assert.equal(await prove(historical),null);ready=true;
  h.setMode('bad-format');assert.equal(await prove(historical),null);h.setMode('timeout');
  report='UNVERIFIED';assert.equal(await prove(historical),null);report='OK';
  changeScope=true;assert.equal(await prove(historical),null);h.env.EXACT_DAILY_HISTORICAL_RECEIPT_SHA256=pin;changeScope=false;
  changeWhileReading=true;assert.equal(await prove(historical),null);
  assert.deepEqual(state(),before);
  assert.equal(h.writes(),1,'the original write remains the only Sheets mutation');
 }finally{reports.readContinuousReportHealth=originalReport;h.close();}
});
test('positive daily recovery SQL compiles at the D1 expression limit',async()=>{const h=await reviewedLostDaily(),sql=[],prepare=h.DB.prepare;try{
 h.formula().push(Array(29).fill(null));h.effective().push(Array(29).fill(null));
 h.DB.prepare=function(statement){sql.push(statement);return prepare.call(this,statement)};
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim,'PAUSED',undefined,'REVIEW',true),true);
 assert.equal(await verifyReviewedDailyProjection(h.env,h.job,h.claim,'PAUSED',undefined,'REVIEW',true),true);
 const check=spawnSync('python3',[fileURLToPath(new URL('./helpers/sqlite-expression-limit.py',import.meta.url))],{input:JSON.stringify(sql),encoding:'utf8'});
 assert.equal(check.status,0,check.stderr||check.error?.message);
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

test('publication confirm route hands off its exact staged marker before writing expense projections',async()=>{
 const h=await fixture(false,true,'claim-token-stage'),pubRoute=require('../dist/sheets/continuous-publication-route.js'),operations=require('../dist/sheets/continuous-publication-operation.js'),{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),oldClaim=claimApi.withStableWorkbookClaim,oldRoute=pubRoute.resolvePublicationTarget,oldOperation=operations.publicationOperationUnderClaim,pub=require('../dist/sheets/continuous-publication-template.js');
 try{
  Object.assign(h.env,{STABLE_SHEETS_PACING_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',SHEETS_SYNC_ENABLED:'true'});h.sqlite.exec("UPDATE sync_jobs SET lease_token='lease-token' WHERE job_id='job'; UPDATE stable_workbook_claims SET notice_stamp='stamp',notice_identity='identity'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('stage-route-epoch','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-stage','stage-route-epoch','ADMITTED','now')");claimApi.withStableWorkbookClaim=async(_env,fn)=>fn(h.claim);pubRoute.resolvePublicationTarget=async()=>({sheetId:50,sheetName:'pub',rows:3});
  operations.publicationOperationUnderClaim=async(_env,kind,input)=>{assert.equal(kind,'STAGE');const marker={expenseId:input.job.entityKey,version:input.job.entityVersion,nonce:'a'.repeat(32),state:'STAGED',detailCount:0},value=pub.encodePublicationCarrier(marker);h.sqlite.prepare("INSERT INTO continuous_publication_intents(transition_id,spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,kind,source_version,source_revision,source_digest,claim_token,lease_token,before_state,before_nonce,after_nonce,detail_count,before_value,after_value,state,created_at,updated_at) VALUES('stage-route','book','exp_test',50,'pub',2,'STAGE',1,?,?,'claim-token-stage','lease-token','EMPTY',?,?,0,?,?,'IN_FLIGHT','now','now')").run(input.sourceRevision,input.sourceDigest,'b'.repeat(32),marker.nonce,pub.publicationEmptyMarker(2,'b'.repeat(32)),value);const prefix=[h.DB.prepare("UPDATE continuous_publication_intents SET state='VERIFIED' WHERE transition_id='stage-route' AND state='IN_FLIGHT'"),h.DB.prepare("INSERT INTO continuous_publication_markers(spreadsheet_id,entity_id,sheet_id,sheet_name,row_number,version,state,marker,transition_id,created_at,updated_at) VALUES('book','exp_test',50,'pub',2,1,'STAGED',?,'stage-route','now','now')").bind(value)];assert.equal(await input.atomicHandoff(prefix,'stage-route'),true);return marker;};
  assert.equal(await runStableExpenseJob(h.env,h.job,'lease-token',new ReviewRequestBudget(48,'invocation')),'CONTINUE');assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='job'").get().last_error,'STABLE_STAGE_CONTINUE');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);assert.equal(h.sqlite.prepare("SELECT projection FROM continuous_normal_notice_handoffs").get().projection,'PUBLICATION');
 }finally{claimApi.withStableWorkbookClaim=oldClaim;pubRoute.resolvePublicationTarget=oldRoute;operations.publicationOperationUnderClaim=oldOperation;h.close();}
});
test('publication confirm route passes staged marker and shared budget to DAILY insert',async()=>{
 const h=await publicationFixture(),pubRoute=require('../dist/sheets/continuous-publication-route.js'),{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),oldClaim=claimApi.withStableWorkbookClaim,oldRoute=pubRoute.resolvePublicationTarget;
 try{Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',SHEETS_SYNC_ENABLED:'true'});h.sqlite.exec("UPDATE stable_workbook_claims SET notice_stamp='stamp',notice_identity='identity'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('daily-route-epoch','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-stage','daily-route-epoch','ADMITTED','now')");claimApi.withStableWorkbookClaim=async(_env,fn)=>fn(h.claim);pubRoute.resolvePublicationTarget=async()=>({sheetId:50,sheetName:'pub',rows:3});assert.equal(await runStableExpenseJob(h.env,h.job,'lease-token',new ReviewRequestBudget(48,'invocation')),'CONTINUE');assert.equal(h.publicationWrites(),1);assert.equal(h.effective()[4][23],null);assert.equal(h.effective()[4][25],'STAGED');assert.equal(h.sqlite.prepare("SELECT projection FROM continuous_normal_notice_handoffs").get().projection,'DAILY');}
 finally{claimApi.withStableWorkbookClaim=oldClaim;pubRoute.resolvePublicationTarget=oldRoute;h.close();}
});
test('publication Undo route remains blocked before provider writes until its handoff proof is complete',async()=>{
 const h=await publicationFixture(),pubRoute=require('../dist/sheets/continuous-publication-route.js'),oldRoute=pubRoute.resolvePublicationTarget;
 try{h.env.CONTINUOUS_PUBLICATION_ENABLED='true';pubRoute.resolvePublicationTarget=async()=>({sheetId:50,sheetName:'pub',rows:3});await assert.rejects(runStableExpenseCancellationJob(h.env,{kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:2},'cancel-lease'),/PUBLICATION_UNDO_HANDOFF_UNAVAILABLE/);assert.equal(h.publicationWrites(),0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_expense_cancellation_writes').get().n,0);}
 finally{pubRoute.resolvePublicationTarget=oldRoute;h.close();}
});
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
test('confirm FINAL reverify passes one policy to all Sheets, legacy and report reads',async()=>{const h=await fixture(),original=claimApi.withStableWorkbookClaim;try{claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim');assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");const source=await readStableExpenseSource(h.env,h.job,'lease','claim'),journals=h.sqlite.prepare('SELECT entity_id,projection,sheet_id,sheet_name,source_version,source_digest,state,operation_token FROM stable_projection_writes').all(),policy={kind:'continuous-expense',budget:{}},seen=new Set();for(const name of ['getSheetGridInfo','getSpreadsheetSheetProperties','getSheetCellNumberFormats','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues']){const old=client[name];client[name]=async(...args)=>{assert.equal(args.at(-1),policy);seen.add(name);return old(...args);};}const oldLegacy=coverage.readLegacyDailyCoverage;coverage.readLegacyDailyCoverage=async(...args)=>{assert.equal(args[4],policy);seen.add('legacy');return oldLegacy(...args);};const {verifyStableExpenseProjections}=require('../dist/sheets/stable-expense-final-check.js');await verifyStableExpenseProjections(h.env,h.job,source,journals,undefined,policy);assert.deepEqual([...seen].sort(),['getSheetGridInfo','getSpreadsheetSheetProperties','getSheetCellNumberFormats','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','legacy'].sort());}finally{claimApi.withStableWorkbookClaim=original;h.close();}});
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

test('activated stable and legacy expense entrypoints both block before writes on flag downgrade',async()=>{const h=await fixture();try{activationModule.assertContinuousNoticeActivation=assertNoticeActivationReal;enableNoticeActivation(h);h.env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED='false';await assert.rejects(dispatchStablePhase1(h.env,h.job),/CONTINUOUS_NOTICE_ACTIVATION_BLOCKED/);h.env.STABLE_PHASE1_ENABLED='false';const {syncJob}=require('../dist/sheets/sync.js');await assert.rejects(syncJob(h.env,h.job),/CONTINUOUS_NOTICE_ACTIVATION_BLOCKED/);assert.equal(h.writes(),0);}finally{activationModule.assertContinuousNoticeActivation=async()=>{};h.close();}});

test('activation fence rejects missing immutable trigger even with matching runtime',async()=>{const h=await fixture();try{enableNoticeActivation(h);h.sqlite.exec('DROP TRIGGER continuous_notice_activation_no_delete');await assert.rejects(assertNoticeActivationReal(h.env,h.job),/CONTINUOUS_NOTICE_ACTIVATION_BLOCKED/);}finally{h.close();}});

test('new handoff cannot be enabled before its durable activation marker exists',async()=>{const h=await fixture();try{await assert.doesNotReject(assertNoticeActivationReal(h.env,h.job));h.env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED='true';await assert.rejects(assertNoticeActivationReal(h.env,h.job),/CONTINUOUS_NOTICE_ACTIVATION_BLOCKED/);assert.equal(h.writes(),0);}finally{h.close();}});
test('PUBLISH route holds before intent or provider write while whole-invocation quota is unproven',async()=>{
 const h=await publicationFixture(),pubRoute=require('../dist/sheets/continuous-publication-route.js'),handoff=require('../dist/sheets/continuous-normal-notice-handoff.js'),{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{writeCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-writer.js'),oldClaim=claimApi.withStableWorkbookClaim,oldRoute=pubRoute.resolvePublicationTarget,oldReady=handoff.normalNoticeHandoffReady;
 try{
  await h.runPublication();await writeCarrierLedgerUnderClaim(h.env,h.job,'lease-token',h.claim,h.source,'EXPENSE_RAW',undefined,h.target,new ReviewRequestBudget(40));const before=h.publicationWrites();
  Object.assign(h.env,{CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',SHEETS_SYNC_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true'});handoff.normalNoticeHandoffReady=async()=>true;claimApi.withStableWorkbookClaim=async(_env,fn)=>fn(h.claim);pubRoute.resolvePublicationTarget=async()=>({sheetId:50,sheetName:'pub',rows:3});
  await assert.rejects(runStableExpenseJob(h.env,h.job,'lease-token',new ReviewRequestBudget(48,'invocation')),/PUBLICATION_PUBLISH_QUOTA_UNPROVEN/);
  assert.equal(h.publicationWrites(),before);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM continuous_publication_intents WHERE kind='PUBLISH'").get().n,0);
 }finally{claimApi.withStableWorkbookClaim=oldClaim;pubRoute.resolvePublicationTarget=oldRoute;handoff.normalNoticeHandoffReady=oldReady;h.close();}
});
test('real queue and claim count all D1 and HTTP until PUBLISH quota hold',async()=>{
 const {generateKeyPairSync}=await import('node:crypto'),h=await publicationFixture(),worker=require('../dist/index.js').default,noticeModule=require('../dist/sheets/stable-edit-notice.js'),pubRoute=require('../dist/sheets/continuous-publication-route.js'),handoff=require('../dist/sheets/continuous-normal-notice-handoff.js'),{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{writeCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-writer.js');
 const oldFetch=globalThis.fetch,oldBegin=noticeModule.beginStableNotice,oldRoute=pubRoute.resolvePublicationTarget,oldReady=handoff.normalNoticeHandoffReady;let requests=0,d1Calls=0,d1Statements=0,sends=0,retries=0,acks=0,status='พร้อมแก้ไข',time='old';
 try{
  await h.runPublication();await writeCarrierLedgerUnderClaim(h.env,h.job,'lease-token',h.claim,h.source,'EXPENSE_RAW',undefined,h.target,new ReviewRequestBudget(40));
  h.sqlite.exec("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'; UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL,attempt_count=0 WHERE job_id='job'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-entry','book','ARMED','EXPENSE','exp_test',1,'now','now')");
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  Object.assign(h.env,{CONTINUOUS_PUBLICATION_ENABLED:'true',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',SHEETS_SYNC_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',GOOGLE_SERVICE_ACCOUNT_EMAIL:'entry@example.invalid',GOOGLE_PRIVATE_KEY_BASE64:Buffer.from(privateKey).toString('base64')});
  const prepare=h.DB.prepare,batch=h.DB.batch;h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run,first=s.first,all=s.all;s.run=async function(){d1Calls++;d1Statements++;return run.call(this);};s.first=async function(){d1Calls++;d1Statements++;return first.call(this);};s.all=async function(){d1Calls++;d1Statements++;return all.call(this);};return s;};h.DB.batch=async function(statements){d1Calls++;d1Statements+=statements.length;return batch.call(this,statements);};
  globalThis.fetch=async(input,init={})=>{requests++;const url=String(input);if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'synthetic',expires_in:3600});if(url.includes('values:batchUpdate')){const data=JSON.parse(init.body).data;status=data[0].values[0][0];time=data[1].values[0][0];return Response.json({});}const parsed=new URL(url),sheet={properties:{sheetId:1,title:'รายวัน',gridProperties:{rowCount:10,columnCount:25,frozenRowCount:3}}},namedRanges=[{namedRangeId:'s',name:'MLP_DAILY_STATUS',range:{sheetId:1,startRowIndex:0,endRowIndex:1,startColumnIndex:1,endColumnIndex:2}},{namedRangeId:'t',name:'MLP_DAILY_STATUS_TIME',range:{sheetId:1,startRowIndex:0,endRowIndex:1,startColumnIndex:2,endColumnIndex:3}}];if(parsed.searchParams.has('ranges'))sheet.data=[{startRow:0,startColumn:1,rowData:[{values:[{userEnteredValue:{stringValue:status}}]}]},{startRow:0,startColumn:2,rowData:[{values:[{userEnteredValue:{stringValue:time}}]}]}];return Response.json({spreadsheetId:'book',namedRanges,sheets:[sheet]});};
  noticeModule.beginStableNotice=(env,token,_wait,auth,bounded,budget)=>oldBegin(env,token,async()=>{},auth,bounded,budget);pubRoute.resolvePublicationTarget=async()=>({sheetId:50,sheetName:'pub',rows:3});handoff.normalNoticeHandoffReady=async()=>true;h.env.JOB_QUEUE.send=async()=>{sends++;};
  const msg={body:h.job,attempts:1,ack(){acks++;},retry(){retries++;}};await worker.queue({queue:'malipang-jobs',messages:[msg]},h.env,{});
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM continuous_publication_intents WHERE kind='PUBLISH'").get().n,0);assert.equal(h.sqlite.prepare("SELECT state FROM continuous_publication_markers").get().state,'STAGED');
  console.log('PUBLICATION_PRE_GATE_COUNTS',{requests,d1Calls,d1Statements,sends,retries,acks,status});
 }finally{globalThis.fetch=oldFetch;noticeModule.beginStableNotice=oldBegin;pubRoute.resolvePublicationTarget=oldRoute;handoff.normalNoticeHandoffReady=oldReady;h.close();}
});
test('synthetic full PUBLISH probe instruments real queue, notice, adapter and final verifier',async()=>{
 const {generateKeyPairSync}=await import('node:crypto'),{readFileSync}=await import('node:fs'),{createRequire:makeRequire}=await import('node:module'),Module=(await import('node:module')).default;
 const worker=require('../dist/index.js').default,jobModule=require('../dist/sheets/stable-expense-job.js'),dispatchModule=require('../dist/sheets/stable-phase1-dispatch.js'),noticeModule=require('../dist/sheets/stable-edit-notice.js'),{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{writeCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-writer.js');
 const clientNames=['getSheetGridInfo','getSpreadsheetSheetProperties','getSheetCellNumberFormats','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheetWithReply'],realClient=Object.fromEntries(clientNames.map(k=>[k,client[k]])),realCoverage=coverage.readLegacyDailyCoverage,realOwned=claimApi.stableWorkbookClaimOwned,oldJob=jobModule.runStableExpenseJob,oldDispatch=dispatchModule.dispatchStablePhase1,oldBegin=noticeModule.beginStableNotice,oldFetch=globalThis.fetch,executor=require('../dist/sheets/continuous-publication-executor.js'),oldExecute=executor.executePublicationIntent,operationApi=require('../dist/sheets/continuous-publication-operation.js'),oldOperation=operationApi.publicationOperationUnderClaim;
 const includeDetail=process.env.PUBLICATION_PROBE_DETAIL==='true',h=await publicationFixture('ok',includeDetail);let requests=0,d1Calls=0,d1Statements=0,queueSends=0,acks=0,retries=0,markerPosts=0,status='พร้อมแก้ไข',time='old',marker,observedBudget,atPublish,atOperation;const categories=new Map();
 try{
  await h.runPublication();await writeCarrierLedgerUnderClaim(h.env,h.job,'lease-token',h.claim,h.source,'EXPENSE_RAW',undefined,h.target,new ReviewRequestBudget(40));if(includeDetail)await writeCarrierLedgerUnderClaim(h.env,h.job,'lease-token',h.claim,h.source,'DETAIL','item_1',h.target,new ReviewRequestBudget(40));marker=h.pub.encodePublicationCarrier(h.target.expected);
  h.sqlite.exec("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'; UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL,attempt_count=0 WHERE job_id='job'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-full-probe','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO continuous_publication_targets(spreadsheet_id,sheet_id,sheet_name,row_count,bootstrap_digest,created_at) VALUES('book',50,'pub',3,'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','now')");
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}});
  Object.assign(h.env,{CONTINUOUS_PUBLICATION_ENABLED:'true',CONTINUOUS_PUBLICATION_SHEET:'pub',CONTINUOUS_PUBLICATION_SHEET_ID:'50',CONTINUOUS_PUBLICATION_ROWS:'3',CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED:'true',CONTINUOUS_NOTICE_DISPATCH_ENABLED:'true',CONTINUOUS_REVIEW_CLOSE_ENABLED:'true',SHEETS_SYNC_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',GOOGLE_SERVICE_ACCOUNT_EMAIL:'full-probe@example.invalid',GOOGLE_PRIVATE_KEY_BASE64:Buffer.from(privateKey).toString('base64')});
  Object.assign(client,realClient);coverage.readLegacyDailyCoverage=realCoverage;claimApi.stableWorkbookClaimOwned=realOwned;
  const count=sql=>{const key=sql.replace(/\s+/g,' ').slice(0,75);categories.set(key,(categories.get(key)||0)+1);};const prepare=h.DB.prepare,batch=h.DB.batch;h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run,first=s.first,all=s.all;s.run=async function(){count(sql);d1Calls++;d1Statements++;return run.call(this);};s.first=async function(){count(sql);d1Calls++;d1Statements++;return first.call(this);};s.all=async function(){count(sql);d1Calls++;d1Statements++;return all.call(this);};return s;};h.DB.batch=async function(stmts){count('BATCH');d1Calls++;d1Statements+=stmts.length;return batch.call(this,stmts);};
  if(process.env.PUBLICATION_PROBE_OPTIMIZE==='true')executor.executePublicationIntent=async(intent,io)=>{try{if(!await io.persist())throw Error('PUBLICATION_INTENT_UNVERIFIED');const request=h.pub.publicationTransitionRequest(intent.sheetId,intent.row,h.pub.decodePublicationCarrier(intent.before),intent.after);await io.dispatch(request);}finally{io.release?.();}if(!await io.commit())throw Error('PUBLICATION_COMMIT_UNCERTAIN');};
  const modulePath=makeRequire(import.meta.url).resolve('../dist/sheets/stable-expense-job.js'),source=readFileSync(modulePath,'utf8'),needle='function publicationPublishInvocationReady(_budget) { return false; }';assert.equal(source.split(needle).length,2);const probe=new Module(modulePath);probe.filename=modulePath;probe.paths=Module._nodeModulePaths(modulePath.substring(0,modulePath.lastIndexOf('/')));probe._compile(source.replace(needle,'function publicationPublishInvocationReady(_budget) { return true; }'),modulePath);jobModule.runStableExpenseJob=probe.exports.runStableExpenseJob;
  operationApi.publicationOperationUnderClaim=async(...args)=>{atOperation={requests,d1Calls,d1Statements,queueSends};return oldOperation(...args);};dispatchModule.dispatchStablePhase1=async(...args)=>{observedBudget=args[3];return oldDispatch(...args);};noticeModule.beginStableNotice=(env,token,_wait,auth,bounded,budget)=>oldBegin(env,token,async()=>{},auth,bounded,budget);
  const legacyF=Array.from({length:10},()=>Array(25).fill(null)),legacyE=structuredClone(legacyF);for(const r of [legacyF,legacyE]){r[4][0]=2026;Object.assign(r[5],{1:11,3:'รายรับทั้งหมดในบัญชี',4:1000});Object.assign(r[8],{0:'รวม',1:11,8:0});}legacyF[8][8]='=SUM(I7:I8)';
  const views=(await import('../scripts/combined-ledger-report-formulas.mjs')).combinedLedgerSpillFormulas({rawNew:'raw_new',detailNew:'detail_new',rawCombined:'V52_EXPENSE_RAW_ALL',detailCombined:'V52_PURCHASE_DETAIL_ALL',rawOldRows:1000,rawNewRows:6,detailOldRows:1000,detailNewRows:6,publishedDaily:'draft'}),daySerial=(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000;
  const props=[{sheetId:1,title:'รายวัน',gridProperties:{rowCount:10,columnCount:25,frozenRowCount:3}},{sheetId:2,title:'draft',gridProperties:{rowCount:h.formula().length,columnCount:29}},{sheetId:3,title:'raw_new',gridProperties:{rowCount:6,columnCount:26}},{sheetId:4,title:'detail_new',gridProperties:{rowCount:6,columnCount:26}},{sheetId:5,title:'V52_EXPENSE_RAW_ALL',gridProperties:{rowCount:9999,columnCount:18}},{sheetId:6,title:'V52_PURCHASE_DETAIL_ALL',gridProperties:{rowCount:9999,columnCount:20}},{sheetId:7,title:'97_EXPENSE_CLEAN',gridProperties:{rowCount:4500,columnCount:8}},{sheetId:10,title:'V52_EXPENSE_RAW',gridProperties:{rowCount:1000,columnCount:26}},{sheetId:11,title:'รายละเอียดการซื้อ',gridProperties:{rowCount:1000,columnCount:20}},{sheetId:50,title:'pub',gridProperties:{rowCount:3,columnCount:1}}];
  const namedRanges=[{namedRangeId:'s',name:'MLP_DAILY_STATUS',range:{sheetId:1,startRowIndex:0,endRowIndex:1,startColumnIndex:1,endColumnIndex:2}},{namedRangeId:'t',name:'MLP_DAILY_STATUS_TIME',range:{sheetId:1,startRowIndex:0,endRowIndex:1,startColumnIndex:2,endColumnIndex:3}}],col=v=>[...v].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0),grid=(name,formula)=>{const published=marker.includes('␟PUBLISHED␟');if(name==='รายวัน')return formula?legacyF:legacyE;if(name==='draft')return formula?h.formula():h.effective();if(name==='raw_new')return formula?h.rawFormula():h.rawEffective();if(name==='detail_new')return formula?h.detailFormula():h.detailEffective();if(name==='pub')return [['Publication_Marker'],[marker],[h.pub.publicationEmptyMarker(3,'e'.repeat(32))]];if(name==='V52_EXPENSE_RAW_ALL')return formula?[[views.raw]]:[['Expense_ID'],...(published?[['exp_test']]:[])];if(name==='V52_PURCHASE_DETAIL_ALL')return formula?[[views.detail]]:[['Purchase_Item_ID','Expense_ID'],...(published&&includeDetail?[['item_1','exp_test']]:[])];if(name==='97_EXPENSE_CLEAN')return formula?[[],['=1+1']]:[['Date','Expense_ID / Legacy row','Description','Amount','Wallet','Category','Source','Sales_Addback_Basis'],...(published?[[daySerial,'exp_test','=literal',1.23,'SHOP_BANK','ingredients','V52_CONFIRMED','']]:[])];return [];};
  globalThis.fetch=async(input,init={})=>{requests++;const u=String(input),url=new URL(u);if(u.includes('oauth2.googleapis.com'))return Response.json({access_token:'synthetic',expires_in:3600});if(u.includes('values:batchUpdate')){const data=JSON.parse(init.body).data;status=data[0].values[0][0];time=data[1].values[0][0];legacyF[0][1]=legacyE[0][1]=status;legacyF[0][2]=legacyE[0][2]=time;return Response.json({});}if(u.includes(':batchUpdate')){markerPosts++;atPublish={requests,d1Calls,d1Statements,queueSends};const req=JSON.parse(init.body).requests[0].findReplace;assert.equal(marker,req.find);marker=req.replacement;const e=h.effective()[4];Object.assign(e,{0:2026,1:11,2:15,3:'=literal',7:1.23,8:1.23,9:998.77,18:998.77,20:daySerial,21:'ingredients',22:'บัญชีร้าน',23:'MALIPANG_EXPENSE:exp_test',25:'PUBLISHED'});if(process.env.PUBLICATION_PROBE_SOURCE_RACE==='true')h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2,updated_at='2026-11-16T00:00:00.000Z' WHERE expense_id='exp_test'");if(process.env.PUBLICATION_PROBE_LOST_ACK==='true')throw Error('synthetic lost marker ACK');return Response.json({replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]});}if(u.includes('values:batchGet')){const formula=url.searchParams.get('valueRenderOption')==='FORMULA',ranges=url.searchParams.getAll('ranges'),valueRanges=ranges.map(range=>{const m=/^'([^']+)'!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);assert.ok(m,range);const rows=grid(m[1],formula),start=Number(m[3])-1,end=Number(m[5]),first=col(m[2])-1,last=col(m[4]);return{values:rows.slice(start,end).map(r=>r.slice(first,last))};});return Response.json({valueRanges});}if(url.searchParams.has('includeGridData')){const range=url.searchParams.get('ranges'),m=/E(\d+):U/.exec(range);return Response.json({sheets:[{properties:{sheetId:2,title:'draft'},data:[{startRow:Number(m[1])-1,startColumn:4,rowData:[{values:Array.from({length:17},(_,i)=>i<15?{userEnteredFormat:{numberFormat:{type:'NUMBER',pattern:'#,##0.00'}}}:i===16?{userEnteredFormat:{numberFormat:{type:'DATE',pattern:'dd/MM/yyyy'}}}:{})}]}]}]});}if(u.includes('namedRanges')){const sheet={properties:props[0],merges:[],protectedRanges:[]};if(url.searchParams.has('ranges'))sheet.data=[{startRow:0,startColumn:1,rowData:[{values:[{userEnteredValue:{stringValue:status}}]}]},{startRow:0,startColumn:2,rowData:[{values:[{userEnteredValue:{stringValue:time}}]}]}];return Response.json({spreadsheetId:'book',namedRanges,sheets:props.map(p=>p.sheetId===1?sheet:{properties:p})});}return Response.json({spreadsheetId:'book',sheets:props.map(properties=>({properties}))});};
  h.env.JOB_QUEUE.send=async()=>{queueSends++;};h.env.NOTICE_QUEUE={async send(){queueSends++;}};const msg={body:h.job,attempts:1,ack(){acks++;},retry(){retries++;}};await worker.queue({queue:'malipang-jobs',messages:[msg]},h.env,{});
  console.log('SYNTHETIC_FULL_PROBE',{requests,d1Calls,d1Statements,queueSends,acks,retries,budget:observedBudget?.used,atOperation,atPublish,top:[...categories.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12),state:h.sqlite.prepare("SELECT state FROM continuous_publication_markers").get().state,reason:h.sqlite.prepare("SELECT review_reason FROM stable_workbook_claims").get()?.review_reason});
  assert.ok(observedBudget);assert.equal(requests,observedBudget.used);
  if(process.env.PUBLICATION_PROBE_LOST_ACK==='true'||process.env.PUBLICATION_PROBE_SOURCE_RACE==='true'){
   assert.equal(markerPosts,1);assert.equal(h.sqlite.prepare("SELECT state FROM continuous_publication_intents WHERE kind='PUBLISH'").get().state,'IN_FLIGHT');assert.equal(h.sqlite.prepare("SELECT state FROM continuous_publication_markers").get().state,'STAGED');assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims").get().state,'REVIEW');
   if(process.env.PUBLICATION_PROBE_SOURCE_RACE==='true'){assert.equal(h.sqlite.prepare("SELECT status FROM expense_events WHERE expense_id='exp_test'").get().status,'CANCELLED');assert.ok(marker.includes('␟PUBLISHED␟'));}
   await worker.queue({queue:'malipang-jobs',messages:[msg]},h.env,{});assert.equal(markerPosts,1);
  }else assert.equal(h.sqlite.prepare("SELECT state FROM continuous_publication_markers").get().state,'PUBLISHED');
 }finally{globalThis.fetch=oldFetch;noticeModule.beginStableNotice=oldBegin;jobModule.runStableExpenseJob=oldJob;dispatchModule.dispatchStablePhase1=oldDispatch;executor.executePublicationIntent=oldExecute;operationApi.publicationOperationUnderClaim=oldOperation;coverage.readLegacyDailyCoverage=realCoverage;claimApi.stableWorkbookClaimOwned=realOwned;h.close();Object.assign(client,realClient);}
});
test('synthetic REVOKE cancels daily, raw and detail and final verifier rejects report drift',async()=>{const h=await revokedPublicationFixture('ok',true),health=require('../dist/sheets/continuous-report-health.js'),oldHealth=health.readContinuousReportHealth,{ReviewRequestBudget}=require('../dist/sheets/review-request-budget.js'),{cancelCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-cancellation.js'),{verifyStableCancellationFinal}=require('../dist/sheets/stable-cancellation-final-check.js');let report='OK';try{
 await h.runCancel();await cancelCarrierLedgerUnderClaim(h.env,h.undoJob,'cancel-lease',h.claim,'EXPENSE_RAW',undefined,h.target,new ReviewRequestBudget(40));await cancelCarrierLedgerUnderClaim(h.env,h.undoJob,'cancel-lease',h.claim,'DETAIL','item_1',h.target,new ReviewRequestBudget(40));
 const metadata=[{sheetId:2,title:'draft',rowCount:9,columnCount:29},{sheetId:3,title:'raw_new',rowCount:6,columnCount:26},{sheetId:4,title:'detail_new',rowCount:6,columnCount:26}],specs=metadata.map(s=>({sheetId:s.sheetId,sheetName:s.title,rows:s.rowCount,columns:s.columnCount})),image={metadata,specs,formula:[structuredClone(h.formula()),structuredClone(h.rawFormula()),structuredClone(h.detailFormula())],effective:[structuredClone(h.effective()),structuredClone(h.rawEffective()),structuredClone(h.detailEffective())]};
 const projections=h.sqlite.prepare("SELECT entity_id,projection,sheet_id,sheet_name,source_version,source_digest,state FROM stable_projection_writes WHERE entity_type='EXPENSE'").all(),writes=h.sqlite.prepare("SELECT entity_id,projection,cancellation_version,previous_version,preimage_digest,operation_token,state FROM stable_expense_cancellation_writes WHERE entity_type='EXPENSE'").all(),publication={sheet:'pub',rows:3,markers:new Map([['exp_test',{state:'REVOKED',version:2}]])},policy={kind:'continuous-expense',budget:new ReviewRequestBudget(40)};
 health.readContinuousReportHealth=async()=>report;const run=()=>verifyStableCancellationFinal(h.env,h.undoJob,projections,writes,'2026-11-15T11:00:00.000Z',h.claim,publication,policy,{before:image,after:structuredClone(image)});
 await run();assert.equal(h.cancelWrites(),3);assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_expense_cancellation_writes WHERE state='VERIFIED'").get().n,3);report='CAPACITY';await assert.rejects(run(),/CANCEL_FINAL_REPORT_UNVERIFIED/);report='OK';image.effective[1][1][3]=999;await assert.rejects(run(),/LEDGER|CANCEL_FINAL/);
 }finally{health.readContinuousReportHealth=oldHealth;h.close();}});
for(const [kind,code] of [['report','REPORT_HEALTH_FORMULA'],['legacy','LEGACY_COVERAGE_READ_UNAVAILABLE']])test(`auto-cancel flag off: an unwritten ${kind} preflight is held for review, the expense stays confirmed`,async()=>{const h=await fixture(),oldClaim=claimApi.withStableWorkbookClaim,oldInsert=insertWriter.insertDailyExpenseUnderClaim;try{
 delete h.env.UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED;
 h.env.STABLE_RECOVERY_GATE_ENABLED='true';h.env.STABLE_SHEETS_PACING_ENABLED='true';h.env.LINE_OWNER_USER_ID='';
 h.sqlite.exec("UPDATE stable_workbook_claims SET operation_token='claim-token-123'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-v1','book','ARMED','EXPENSE','exp_test',1,'now','now'); INSERT INTO stable_recovery_operations(operation_token,epoch_id,state,admitted_at) VALUES('claim-token-123','epoch-v1','ADMITTED','now')");
 claimApi.withStableWorkbookClaim=async(_env,fn)=>fn('claim-token-123');insertWriter.insertDailyExpenseUnderClaim=async()=>{throw new insertWriter.InsertDailyPreflightReviewError(code)};
 // Under the recovery gate the scoped job hold is fail-closed, so the error
 // propagates and the workbook claim fences the job, as before automation.
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'));
 assert.deepEqual({...h.sqlite.prepare("SELECT status,version FROM expense_events WHERE expense_id='exp_test'").get()},{status:'CONFIRMED',version:1});assert.equal(h.writes(),0);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM expense_audit_log WHERE action='CANCEL'").get().n,0);
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE error IN ('SYNC_AUTO_CANCEL_AWAITING_RECIPIENT','PENDING_LINE_NOTIFICATION_DELIVERY')").get().n,0);
 }finally{insertWriter.insertDailyExpenseUnderClaim=oldInsert;claimApi.withStableWorkbookClaim=oldClaim;h.close()}});

test('QA deterministic Miniflare monthly diagnostics and multi-run',async t=>{t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-21T12:00:00.000Z')});for(const mode of ['normal','version-bump','undo','content-drift']){const h=await fixture(false,true,'claim-token-recovery',false,'รายวันต่อเนื่อง_แบบร่าง'),originalRead=client.readMonthlyReportGrid,originalInfo=client.getSheetGridInfo,originalPost=client.batchUpdateSpreadsheetWithReply,originalNotice=notice.stableNoticePaused,originalLease=googleAuth.createGoogleOAuthLease;let posts=0,mf=null,dir=null,realdb=null,phase='setup',budgetLog=[];const budgetClass=require('../dist/sheets/review-request-budget.js').ReviewRequestBudget,oldRead=budgetClass.prototype.consumeRead,oldClaim=budgetClass.prototype.claimMutation;budgetClass.prototype.consumeRead=function(){oldRead.call(this);budgetLog.push([phase,this.used]);};budgetClass.prototype.claimMutation=function(){const t=oldClaim.call(this),consume=t.consume;return {...t,consume:()=>{consume();budgetLog.push([phase,this.used]);}}};try{
 h.setMode('timeout');await assert.rejects(h.run(),/synthetic lost response/);h.sqlite.exec("UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED',notice_stamp='stamp',notice_identity='identity' WHERE spreadsheet_id='book'; UPDATE sync_jobs SET status='REVIEW',lease_token=NULL,lease_until=NULL,last_error='STABLE_SYNC_REVIEW' WHERE job_id='job'");
 h.sqlite.exec("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_aa','msg_a','user_a','=literal',123,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1),('exp_bb','msg_b','user_b','=literal',123,'transfer','SHOP_BANK','ingredients','2026-11-15','CONFIRMED','now',1),('exp_00_bad','msg_c','user_c','=literal',123,'transfer','SHOP_BANK','bad_category','2026-11-15','CONFIRMED','now',1),('exp_00_date','msg_d','user_d','=literal',123,'transfer','SHOP_BANK','ingredients','2026-11-99','CONFIRMED','now',1),('exp_garbage','msg_e','user_e','=literal',123,'transfer','SHOP_BANK','ingredients','garbage','CONFIRMED','now',1)");
 Object.assign(h.env,{MONTHLY_REPORT_OPERATOR_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CF_VERSION_METADATA:{id:'test-version'}});const workerHash=createHash('sha256').update('test-version').digest('hex'),beforeExpense={...h.sqlite.prepare("SELECT * FROM expense_events WHERE expense_id='exp_test'").get()};
 const {mkdtempSync,readdirSync,copyFileSync,rmSync}=await import('node:fs'),{join}=await import('node:path'),{tmpdir}=await import('node:os'),{Miniflare}=await import('miniflare');dir=mkdtempSync(join(tmpdir(),'qa296-e2e-real-d1-'));const fixturePath=join(dir,'fixture.sqlite');h.sqlite.exec(`VACUUM INTO '${fixturePath.replaceAll("'","''")}'`);const options={modules:true,compatibilityDate:'2026-07-20',d1Databases:{DB:'test-db'},d1Persist:dir,script:'export default {async fetch(_r,e){await e.DB.prepare("SELECT 1").first();return new Response("ok")}}'};mf=new Miniflare(options);assert.equal((await mf.dispatchFetch('http://local/')).status,200);await mf.dispose();mf=null;const folder=join(dir,'miniflare-D1DatabaseObject'),dbfile=readdirSync(folder).find(x=>x.endsWith('.sqlite'));for(const ext of ['-wal','-shm'])rmSync(join(folder,dbfile+ext),{force:true});copyFileSync(fixturePath,join(folder,dbfile));mf=new Miniflare(options);realdb=await mf.getD1Database('DB');h.env.DB=realdb;const businessBefore={jobs:await realdb.prepare('SELECT * FROM sync_jobs ORDER BY job_id').all(),claims:await realdb.prepare('SELECT * FROM stable_workbook_claims').all(),projection:await realdb.prepare('SELECT * FROM stable_projection_writes').all()};
 const expenseBefore=(await realdb.prepare('SELECT * FROM expense_events ORDER BY expense_id').all()).results,existingDraftIncident=h.effective().some(row=>row[23]==='MALIPANG_EXPENSE:exp_test');assert.equal(existingDraftIncident,true);
 const n=h.formula().length,blank=()=>Array(29).fill(null),notes=Array.from({length:n},blank),formats=Array.from({length:n},blank),validations=Array.from({length:n},blank),extras=Array.from({length:n},blank);
 for(let c=4;c<=18;c++)formats[5][c]={numberFormat:{type:'NUMBER',pattern:'#,##0.00'}};formats[5][20]={numberFormat:{type:'DATE',pattern:'dd/MM/yyyy'}};for(let c=4;c<=18;c++)formats[n-1][c]={numberFormat:{type:'NUMBER',pattern:'#,##0.00'}};formats[n-1][20]={numberFormat:{type:'DATE',pattern:'dd/MM/yyyy'}};
 const structure=baseRows=>({sheetId:2,title:'รายวันต่อเนื่อง_แบบร่าง',properties:{},mergedRanges:[],protectedRanges:[],conditionalFormats:[],filterViews:[],basicFilter:null,rowMetadata:Array(baseRows).fill(null),columnMetadata:Array(29).fill(null)});
 client.getSheetGridInfo=async(_env,_sheet,policy)=>{policy?.budget?.consumeRead();return {sheetId:2,rowCount:h.formula().length,columnCount:29}};
 client.readMonthlyReportGrid=async(_env,_id,baseRows,policy)=>{for(let i=0;i<6;i++)policy.budget.consumeRead();return {rows:h.formula().length,columns:29,formula:structuredClone(h.formula()),effective:structuredClone(h.effective()),notes:structuredClone(notes),formats:structuredClone(formats),validations:structuredClone(validations),extras:structuredClone(extras),structure:structure(baseRows)}};
 notice.stableNoticePaused=async(_env,_stamp,_identity,budget)=>{budget?.consumeRead();budget?.consumeRead();return true};googleAuth.createGoogleOAuthLease=async(_env,budget)=>{budget.consumeRead();return {tokenFor(){return 'synthetic'}}};
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before,budget)=>{const ticket=budget.claimMutation();try{if(mode==='pre-drift')await realdb.prepare("UPDATE expense_events SET description='SYNTHETIC DRIFT' WHERE expense_id='exp_test'").run();await before();ticket.consume();posts++;const cells=requests[2].updateCells.rows[0].values,f=blank(),e=blank();for(let c=0;c<25;c++){const v=cells[c]?.userEnteredValue;if(!v)continue;if(v.formulaValue)f[c]=v.formulaValue;else f[c]=e[c]=v.numberValue??v.stringValue;}
  Object.assign(e,{8:1.23,9:997.54,18:997.54,20:(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000});h.formula().push(f,blank());h.effective().push(e,blank());notes.push(blank(),blank());notes.at(-2)[19]=requests[3].updateCells.rows[0].values[0].note;const inherited=structuredClone(formats.at(-1));formats.push(structuredClone(formats[5]),inherited);validations.push(blank(),blank());extras.push(blank(),blank());
  if(mode==='post-tamper')h.formula()[3][4]='owner edit';if(mode==='post-drift')await realdb.prepare("UPDATE expense_events SET description='SYNTHETIC DRIFT' WHERE expense_id='exp_test'").run();if(mode==='lost-provider')throw Error('synthetic lost provider response');return {replies:requests.map(()=>({}))};}finally{ticket.release();}};
 const batch=h.DB.batch;h.DB.batch=async function(stmts){for(const s of stmts)if(/\bRETURNING\b/i.test(s.sql))s.runSync=function(){return {results:this.db.sqlite.prepare(this.sql).all(...this.args),meta:{changes:0}}};return batch.call(this,stmts)};
 phase='preview';let preview=await operateMonthlyReport(h.env,'PREVIEW',workerHash);assert.equal(preview.status,'READY');assert.equal(preview.ready,2);assert.equal(preview.held,3);assert.equal(preview.unassignedDate,1);assert.deepEqual(preview.heldReasons,{SOURCE_INCOMPLETE:1,DATE_UNVERIFIED:1,INCIDENT_REVIEW:1});assert.deepEqual(preview.heldItems.map(x=>x.reason).sort(),['DATE_UNVERIFIED','INCIDENT_REVIEW','SOURCE_INCOMPLETE']);assert.equal(preview.stale,0);
 let result=await operateMonthlyReport(h.env,'APPEND_ONE',workerHash,preview.candidate);assert.equal(result.status,'DONE');assert.equal(posts,1);let first=(await realdb.prepare("SELECT expense_id,source_version FROM monthly_report_intents WHERE state='VERIFIED'").all()).results[0];assert.equal(first.expense_id,'exp_aa');
 if(mode==='version-bump'||mode==='undo')await realdb.prepare("UPDATE expense_events SET version=2,status=? WHERE expense_id='exp_aa'").bind(mode==='undo'?'CANCELLED':'CONFIRMED').run();
 if(mode==='content-drift')await realdb.prepare("UPDATE expense_events SET description='SYNTHETIC EDIT' WHERE expense_id='exp_aa'").run();preview=await operateMonthlyReport(h.env,'PREVIEW',workerHash);assert.equal(preview.status,'READY');assert.equal(preview.held,3);assert.equal(preview.unassignedDate,1);assert.deepEqual(preview.heldReasons,{SOURCE_INCOMPLETE:1,DATE_UNVERIFIED:1,INCIDENT_REVIEW:1});assert.deepEqual(preview.heldItems.map(x=>x.reason).sort(),['DATE_UNVERIFIED','INCIDENT_REVIEW','SOURCE_INCOMPLETE']);assert.equal(preview.stale,mode==='normal'?0:1);
 if(mode==='normal'){
  assert.equal(preview.ready,1);
  result=await operateMonthlyReport(h.env,'APPEND_ONE',workerHash,preview.candidate);
  assert.equal(result.status,'DONE');
  preview=await operateMonthlyReport(h.env,'PREVIEW',workerHash);
  assert.equal(preview.status,'READY');
  assert.equal(preview.ready,0);
  assert.equal(preview.held,3);
  assert.equal(preview.unassignedDate,1);
  assert.equal(posts,2);
  const projected=(await realdb.prepare('SELECT expense_id FROM monthly_report_intents ORDER BY expense_id').all()).results;
  assert.deepEqual(projected.map(x=>x.expense_id),['exp_aa','exp_bb']);
  assert.deepEqual((await realdb.prepare('SELECT * FROM expense_events ORDER BY expense_id').all()).results,expenseBefore);
 }
 if(mode==='version-bump'){assert.equal(preview.ready,2);result=await operateMonthlyReport(h.env,'APPEND_ONE',workerHash,preview.candidate);assert.equal((await operateMonthlyReport(h.env,'PREVIEW',workerHash)).stale,1);console.log('QA_VERSION_BUMP',JSON.stringify({status:result.status,posts,rows:(await realdb.prepare("SELECT expense_id,source_version,state FROM monthly_report_intents ORDER BY source_version").all()).results}));}
 if(mode==='undo'||mode==='content-drift'){assert.equal(preview.ready,1);result=await operateMonthlyReport(h.env,'APPEND_ONE',workerHash,preview.candidate);assert.equal(result.status,'DONE');assert.equal(posts,2);const after=await realdb.prepare("SELECT status,version,description FROM expense_events WHERE expense_id='exp_aa'").first();if(mode==='undo')assert.deepEqual(after,{status:'CANCELLED',version:2,description:'=literal'});else assert.deepEqual(after,{status:'CONFIRMED',version:1,description:'SYNTHETIC EDIT'});let next=await operateMonthlyReport(h.env,'PREVIEW',workerHash);assert.equal(next.stale,1);console.log('QA_STALE',JSON.stringify({mode,otherContinued:true,stale:next.stale,oldReceiptRetained:(await realdb.prepare("SELECT count(*) n FROM monthly_report_intents WHERE expense_id='exp_aa' AND state='VERIFIED'").first()).n}));}
 assert.deepEqual(await realdb.prepare("SELECT * FROM expense_events WHERE expense_id='exp_test'").first(),beforeExpense);const businessAfter={jobs:await realdb.prepare('SELECT * FROM sync_jobs ORDER BY job_id').all(),claims:await realdb.prepare('SELECT * FROM stable_workbook_claims').all(),projection:await realdb.prepare('SELECT * FROM stable_projection_writes').all()};for(const key of ['jobs','claims','projection'])assert.deepEqual(businessAfter[key].results,businessBefore[key].results);
 }finally{budgetClass.prototype.consumeRead=oldRead;budgetClass.prototype.claimMutation=oldClaim;if(mf)await mf.dispose();if(dir)(await import('node:fs')).rmSync(dir,{recursive:true,force:true});client.readMonthlyReportGrid=originalRead;client.getSheetGridInfo=originalInfo;client.batchUpdateSpreadsheetWithReply=originalPost;notice.stableNoticePaused=originalNotice;googleAuth.createGoogleOAuthLease=originalLease;h.close();}}});

test('failed-hold read-only proof selects exactly one pinned row and rejects all drift',async()=>{for(const mode of ['exact','payload','error','attempt','trace','resolved','other-open','revision']){const h=await fixture(false,true,'claim-token-recovery');try{
 h.setMode('timeout');await assert.rejects(h.run(),/synthetic lost response/);
 h.sqlite.prepare("UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED',notice_stamp='stamp',notice_identity='identity',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_token=?").run(h.claim);
 h.sqlite.exec("UPDATE sync_jobs SET status='REVIEW',lease_token=NULL,lease_until=NULL,last_error='STABLE_SYNC_REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id='job'");
 h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('failed','malipang-jobs','fixture','EXPENSE:exp_test:1',?,'Error: STABLE_JOB_HOLD_UNCERTAIN','OPEN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(JSON.stringify(h.job));
 const row=h.sqlite.prepare(DAILY_FAILED_INCIDENT_EVIDENCE_SQL).get('book');assert.ok(row);const hash=await failedDailyIncidentFingerprint(row);
 if(mode==='payload')h.sqlite.exec("UPDATE failed_jobs SET payload_json='{}' WHERE id='failed'");
 if(mode==='error')h.sqlite.exec("UPDATE failed_jobs SET error='DEAD_LETTER_MAX_RETRIES' WHERE id='failed'");
 if(mode==='attempt')h.sqlite.exec("UPDATE failed_jobs SET attempt_count=2 WHERE id='failed'");
 if(mode==='trace')h.sqlite.exec("UPDATE failed_jobs SET trace_id='other' WHERE id='failed'");
 if(mode==='resolved')h.sqlite.exec("UPDATE failed_jobs SET status='RESOLVED' WHERE id='failed'");
 if(mode==='other-open')h.sqlite.exec("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('other','other','other','EXPENSE:exp_test:2','{}','failure','OPEN',1,'now','now')");
 if(mode==='revision')h.sqlite.exec('UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1');
 assert.equal(!!await readFailedDailyIncidentEvidence(h.env,hash),mode==='exact');

 assert.equal(h.writes(),1);
 }finally{h.close();}}});
async function failedDailyProbeFixture(){
 const h=await fixture(false,true,'claim-token-recovery');
 try{
  h.setMode('timeout');await assert.rejects(h.run(),/synthetic lost response/);
  h.sqlite.prepare("UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED',notice_stamp='stamp',notice_identity='identity',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_token=?").run(h.claim);
  h.sqlite.exec("UPDATE sync_jobs SET status='REVIEW',lease_token=NULL,lease_until=NULL,last_error='STABLE_SYNC_REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id='job'");
  h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('failed','malipang-jobs','fixture','EXPENSE:exp_test:1',?,'Error: STABLE_JOB_HOLD_UNCERTAIN','OPEN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(JSON.stringify(h.job));
  return h;
 }catch(error){h.close();throw error;}
}
test('failed-hold provider probe is read-only and rejects changed failed row',async()=>{const h=await failedDailyProbeFixture(),oldStyle=notice.stableNoticeStyleFingerprint;try{
 h.formula().push(Array(29).fill(null));h.effective().push(Array(29).fill(null));
 const row=h.sqlite.prepare(DAILY_FAILED_INCIDENT_EVIDENCE_SQL).get('book'),hash=await failedDailyIncidentFingerprint(row);notice.stableNoticeStyleFingerprint=async()=> 'a'.repeat(64);
 const statements=[],prepare=h.DB.prepare;h.DB.prepare=function(sql){statements.push(sql);return prepare.call(this,sql)};
 client.batchUpdateSpreadsheetWithReply=async()=>{throw Error('unexpected provider mutation')};
 Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CF_VERSION_METADATA:{id:'synthetic-version'}});h.env.EXACT_DAILY_SETTLEMENT_ENABLED='true';const workerHash='synthetic-version';
 assert.equal(await probeExactFailedDailyOnly(h.env,hash,workerHash),true);assert.equal(h.writes(),1);
 assert.equal(await probeExactFailedDailyOnly(h.env,hash,'f'.repeat(64)),false);
 h.env.STABLE_RECOVERY_GATE_ENABLED='false';assert.equal(await probeExactFailedDailyOnly(h.env,hash,workerHash),true);
 const oldInfo=client.getSheetGridInfo;for(const [before,after] of [['false','true'],['true','false']]){h.env.STABLE_RECOVERY_GATE_ENABLED=before;let drifted=false;client.getSheetGridInfo=async(...args)=>{const value=await oldInfo(...args);if(!drifted){drifted=true;h.env.STABLE_RECOVERY_GATE_ENABLED=after;}return value;};assert.equal(await probeExactFailedDailyOnly(h.env,hash,workerHash),false);assert.equal(drifted,true);client.getSheetGridInfo=oldInfo;}
 for(const invalid of ['invalid','',undefined]){h.env.STABLE_RECOVERY_GATE_ENABLED=invalid;assert.equal(await probeExactFailedDailyOnly(h.env,hash,workerHash),false);}h.env.STABLE_RECOVERY_GATE_ENABLED='true';
 h.formula().at(-1)[28]='=1';assert.equal(await probeExactFailedDailyOnly(h.env,hash,workerHash),false);h.formula().at(-1)[28]=null;
 notice.stableNoticeStyleFingerprint=async()=>null;assert.equal(await probeExactFailedDailyOnly(h.env,hash,workerHash),false);notice.stableNoticeStyleFingerprint=async()=> 'a'.repeat(64);
 assert.ok(statements.length>0);assert.ok(statements.every(sql=>/^\s*SELECT\b/i.test(sql)));
 const get=client.batchGetSheetFormulaValues;let changed=false;
 client.batchGetSheetFormulaValues=async(...args)=>{if(!changed){changed=true;h.sqlite.exec("UPDATE failed_jobs SET attempt_count=2 WHERE id='failed'");}return get(...args);};
 assert.equal(await probeExactFailedDailyOnly(h.env,hash,workerHash),false);assert.equal(changed,true);
 assert.equal(h.sqlite.prepare("SELECT status FROM failed_jobs WHERE id='failed'").get().status,'OPEN');assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');assert.equal(h.writes(),1);
 }finally{notice.stableNoticeStyleFingerprint=oldStyle;h.close();}});

test('exact DAILY settlement validates request shape and owner observations',()=>{
 const fingerprint='a'.repeat(64),preimageDigest='b'.repeat(64);
 const settle={action:'SETTLE',fingerprint,preimageDigest,externalWritersFenced:true,ownerSupervising:true};
 for(const body of [null,[],{}, {action:'INSPECT',extra:true}, {action:'PROBE',fingerprint:'no'},
  {...settle,externalWritersFenced:false},{...settle,ownerSupervising:false},{...settle,extra:true}])
  assert.equal(parseExactDailyOperation(body),null);
 for(const body of [{action:'INSPECT'}, {action:'PROBE',fingerprint},settle])assert.deepEqual(parseExactDailyOperation(body),body);
});

test('exact DAILY accepts hash-only historical evidence in its explicit actions',()=>{
 const fingerprint='a'.repeat(64),preimageDigest='b'.repeat(64);
 const historicalReceipt={incidentFingerprint:fingerprint,archiveIdentityDigest:'b'.repeat(64),
  archiveGridDigest:'c'.repeat(64),approvedDeltaDigest:'d'.repeat(64),liveGridDigest:'e'.repeat(64)};
 const probe={action:'PROBE',fingerprint,historicalReceipt};
 assert.deepEqual(parseExactDailyOperation(probe),probe);
 const settle={action:'SETTLE_HISTORICAL',fingerprint,preimageDigest,historicalReceipt,externalWritersFenced:true,ownerSupervising:true};
 const inspect={action:'INSPECT_HISTORICAL',fingerprint};
 assert.deepEqual(parseExactDailyOperation(settle),settle);
 assert.deepEqual(parseExactDailyOperation(inspect),inspect);
 for(const body of [{...settle,ownerSupervising:false},{...settle,externalWritersFenced:false},
  {...settle,extra:true},{...settle,historicalReceipt:null},{...inspect,extra:true},
  {...inspect,fingerprint:undefined}])assert.equal(parseExactDailyOperation(body),null);
 for(const body of [{...probe,extra:true},{...probe,historicalReceipt:null},{...probe,
  historicalReceipt:{...historicalReceipt,archive:[['private']] }},{...probe,
  historicalReceipt:{...historicalReceipt,incidentFingerprint:preimageDigest}},
  {...probe,action:'SETTLE',preimageDigest,externalWritersFenced:true,ownerSupervising:true},
  {action:'INSPECT',historicalReceipt}])assert.equal(parseExactDailyOperation(body),null);
});

test('exact DAILY historical PROBE requires the deployed digest and refuses readback drift',async()=>{
 const h=await failedDailyProbeFixture(),oldStyle=notice.stableNoticeStyleFingerprint;
 const {handleAdmin}=require('../dist/admin/handler.js');
 try{
  const row=h.sqlite.prepare(DAILY_FAILED_INCIDENT_EVIDENCE_SQL).get('book');assert.ok(row);
  const fingerprint=await failedDailyIncidentFingerprint(row);
  const {receipt,pin}=await historicalDailyReceiptFixture(h,row,fingerprint);
  const version='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',token='a'.repeat(40);
  Object.assign(h.env,{ADMIN_TOKEN:token,CF_VERSION_METADATA:{id:version},EXACT_DAILY_SETTLEMENT_ENABLED:'true',
   STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});
  notice.stableNoticeStyleFingerprint=async()=> 'a'.repeat(64);
  client.batchUpdateSpreadsheetWithReply=async()=>{throw Error('unexpected provider mutation');};
  const request=(body,expectedVersion=version)=>handleAdmin(new Request('https://example.test/admin/stable-sync/exact-daily-settlement',{
   method:'POST',headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':expectedVersion},body:JSON.stringify(body),
  }),h.env,{});
  const statements=[],prepare=h.DB.prepare;h.DB.prepare=function(sql){statements.push(sql);return prepare.call(this,sql);};
  const state=()=>['stable_workbook_claims','sync_jobs','failed_jobs','stable_projection_writes','stable_expense_projection_preimages','expense_events']
   .map(table=>h.sqlite.prepare(`SELECT * FROM ${table}`).all());
  const before=state(),probe={action:'PROBE',fingerprint,historicalReceipt:receipt};
  assert.equal((await request(probe,'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee')).status,409);
  assert.deepEqual(await (await request(probe)).json(),{ok:false,outcome:'HELD',stage:'HISTORICAL_RECEIPT',servedVersion:version});
  h.env.EXACT_DAILY_HISTORICAL_RECEIPT_SHA256=pin;
  assert.deepEqual(await (await request({...probe,historicalReceipt:{...receipt,archiveIdentityDigest:'1'.repeat(64)}})).json(),
   {ok:false,outcome:'HELD',stage:'HISTORICAL_RECEIPT',servedVersion:version});
  assert.equal(statements.length,0,'version and receipt rejection precede D1 and provider work');
  h.env.EXACT_DAILY_SETTLEMENT_ENABLED='false';
  const withoutReceipt=await request({action:'PROBE',fingerprint});
  assert.equal(withoutReceipt.status,409);
  assert.deepEqual(await withoutReceipt.json(),
   {ok:false,outcome:'HELD',stage:'HISTORICAL_RECEIPT',servedVersion:version});
  const response=await request(probe),result=await response.json();
  assert.equal(response.status,200);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const target=h.formula()[row.target_row-1];
  const preimageDigest=createHash('sha256').update(JSON.stringify(Array.from({length:row.before_columns},(_,i)=>target[i]===''?null:target[i]??null))).digest('hex');
  assert.deepEqual(result,{ok:true,outcome:'MATCHED',fingerprint,preimageDigest,historicalReceiptDigest:pin,servedVersion:version});
  const settle={action:'SETTLE',fingerprint,preimageDigest,externalWritersFenced:true,ownerSupervising:true};
  assert.equal((await request({...settle,historicalReceipt:receipt})).status,400);
  h.env.EXACT_DAILY_SETTLEMENT_ENABLED='true';
  const statementsBeforeRejectedActions=statements.length;
  assert.deepEqual(await (await request(settle)).json(),{ok:false,outcome:'HELD',stage:'HISTORICAL_RECEIPT',servedVersion:version});
  assert.deepEqual(await (await request({action:'INSPECT'})).json(),{ok:false,outcome:'HELD',stage:'HISTORICAL_RECEIPT',servedVersion:version});
  assert.equal(statements.length,statementsBeforeRejectedActions);
  h.effective()[0][0]='different effective value';
  assert.deepEqual(await (await request(probe)).json(),{ok:false,outcome:'HELD',stage:'POSTIMAGE',servedVersion:version});
  assert.ok(statements.length>0&&statements.every(sql=>/^\s*SELECT\b/i.test(sql)));
  assert.deepEqual(state(),before);
  assert.equal(h.writes(),1);
 }finally{notice.stableNoticeStyleFingerprint=oldStyle;h.close();}
});

async function miniflareDailyFixture(sqlite){
 const {mkdtempSync,readdirSync,copyFileSync,rmSync}=await import('node:fs');
 const {join}=await import('node:path'),{tmpdir}=await import('node:os'),{Miniflare}=await import('miniflare');
 const dir=process.env.ISSUE348_KILL_D1_DIR||mkdtempSync(join(tmpdir(),'exact-daily-d1-'));
 let mf;
 const close=async()=>{try{if(mf)await mf.dispose();}finally{rmSync(dir,{recursive:true,force:true});}};
 try{
  const fixturePath=join(dir,'fixture.sqlite');sqlite.exec(`VACUUM INTO '${fixturePath.replaceAll("'","''")}'`);
  const options={modules:true,d1Databases:{DB:'fixture'},d1Persist:dir,script:'export default {async fetch(_r,e){await e.DB.prepare("SELECT 1").first();return new Response("ok")}}'};
  mf=new Miniflare(options);await mf.dispatchFetch('http://local/');await mf.dispose();mf=null;
  const folder=join(dir,'miniflare-D1DatabaseObject'),dbfile=readdirSync(folder).find(x=>x.endsWith('.sqlite'));
  for(const ext of ['-wal','-shm'])rmSync(join(folder,dbfile+ext),{force:true});
  copyFileSync(fixturePath,join(folder,dbfile));mf=new Miniflare(options);
  const db=await mf.getD1Database('DB');
  return {db,close};
 }catch(error){await close();throw error;}
}

for(const mode of ['received','lost','audit-rejected'])test(`historical DAILY settlement on Miniflare ${mode} preserves the original hold`,async()=>{
 const h=await failedDailyProbeFixture(),oldStyle=notice.stableNoticeStyleFingerprint;
 const {handleAdmin}=require('../dist/admin/handler.js');
 const {verifiedHeldDailyGuard}=require('../dist/admin/exact-daily-settlement.js');
 let local;
 try{
  const original=h.sqlite.prepare(DAILY_FAILED_INCIDENT_EVIDENCE_SQL).get('book');assert.ok(original);
  const fingerprint=await failedDailyIncidentFingerprint(original);
  const {receipt,pin}=await historicalDailyReceiptFixture(h,original,fingerprint);
  const token='a'.repeat(40),version='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  Object.assign(h.env,{ADMIN_TOKEN:token,CF_VERSION_METADATA:{id:version},EXACT_DAILY_SETTLEMENT_ENABLED:'true',
   EXACT_DAILY_HISTORICAL_RECEIPT_SHA256:pin,STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});
  notice.stableNoticeStyleFingerprint=async()=> 'a'.repeat(64);
  client.batchUpdateSpreadsheetWithReply=async()=>{throw Error('unexpected provider mutation');};
  const call=async(body)=>{
   const res=await handleAdmin(new Request('https://example.test/admin/stable-sync/exact-daily-settlement',{
    method:'POST',headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':h.env.CF_VERSION_METADATA.id},
    body:JSON.stringify(body),
   }),h.env,{});
   return res.json();
  };
  const probe=await call({action:'PROBE',historicalReceipt:receipt,fingerprint});assert.equal(probe.outcome,'MATCHED');
  const {preimageDigest}=probe;
  const approval=createHash('sha256').update(JSON.stringify(['issue296-historical-daily-settlement-v1',fingerprint,pin,preimageDigest])).digest('hex');
  const settle={action:'SETTLE_HISTORICAL',fingerprint,preimageDigest,historicalReceipt:receipt,externalWritersFenced:true,ownerSupervising:true};
  const inspect={action:'INSPECT_HISTORICAL',fingerprint};
  assert.equal((await call(settle)).stage,'HISTORICAL_SETTLEMENT_APPROVAL');
  h.env.EXACT_DAILY_HISTORICAL_SETTLEMENT_SHA256=approval;
  assert.equal((await call({...settle,preimageDigest:'1'.repeat(64)})).stage,'HISTORICAL_SETTLEMENT_APPROVAL');
  if(releaseSchemaOnly){
   assert.equal((await call(settle)).stage,'HISTORICAL_AUDIT_GUARD');
   h.sqlite.exec(readFileSync(new URL('../migrations-draft/0081_issue296_historical_daily_audit_draft.sql',import.meta.url),'utf8'));
  }
  if(mode==='audit-rejected')h.sqlite.exec("CREATE TRIGGER fixture_reject_historical_audit BEFORE INSERT ON admin_audit WHEN NEW.action='ISSUE296_HISTORICAL_DAILY_SETTLED' BEGIN SELECT RAISE(ABORT,'fixture audit insert rejected'); END");
  local=await miniflareDailyFixture(h.sqlite);
  const {db}=local;
  let batches=0;const journalChanges=new WeakSet();
  h.env.DB={prepare(sql){
   const stmt=db.prepare(sql);
   if(!sql.startsWith('UPDATE stable_projection_writes SET state=\'VERIFIED\''))return stmt;
   return {bind(...args){const bound=stmt.bind(...args);journalChanges.add(bound);return bound;}};
  },async batch(statements){
   const settlement=statements.some(stmt=>journalChanges.has(stmt));
   if(settlement)batches++;
   const result=await db.batch(statements);
   if(settlement&&mode==='lost')throw Error('fixture ACK lost after D1 commit');
   return result;
  }};
  const holdings=['stable_workbook_claims','sync_jobs','failed_jobs','expense_events','stable_recovery_epochs'];
  const state=()=>Promise.all(holdings.map(async name=>(await db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).results));
  const before=await state();
  for(const flag of ['CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED','CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED',
   'MONTHLY_REPORT_OPERATOR_ENABLED','CONTINUOUS_REVIEW_CLOSE_ENABLED','CONTINUOUS_REVOKE_REVIEW_CLOSE_ENABLED']){
   h.env[flag]='true';assert.equal((await call(settle)).stage,'CONFIG',flag);delete h.env[flag];
  }
  for(const flag of ['EXACT_DAILY_SETTLEMENT_ENABLED','STABLE_RECOVERY_GATE_ENABLED']){
   h.env[flag]='false';assert.equal((await call(settle)).stage,'CONFIG',flag);h.env[flag]='true';
  }
  h.formula()[0][0]='drift before historical settlement';
  assert.equal((await call(settle)).stage,'POSTIMAGE');
  h.formula()[0][0]='synthetic approved header edit';
  assert.equal(batches,0);
  const result=await call(settle);
  assert.equal(result.outcome,mode==='received'?'SETTLED':'UNCERTAIN');
  if(mode==='received')assert.equal(result.historicalSettlementDigest,approval);
  assert.equal(batches,1);
  const blockedReplay=mode!=='audit-rejected'?await call(settle):null;
  if(blockedReplay)assert.equal(blockedReplay.outcome,'HELD');
  assert.equal(batches,1);
  // Recovery authenticates the new served version and reads retained evidence without the write pins.
  delete h.env.EXACT_DAILY_HISTORICAL_SETTLEMENT_SHA256;delete h.env.EXACT_DAILY_HISTORICAL_RECEIPT_SHA256;
  h.env.CF_VERSION_METADATA={id:'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'};
  const after=await call(inspect),count=(await db.prepare('SELECT count(*) AS n FROM stable_expense_projection_preimages').first()).n;
  const entries=(await db.prepare("SELECT rowid,id,after_json FROM admin_audit WHERE action='ISSUE296_HISTORICAL_DAILY_SETTLED'").all()).results;
  assert.equal(after.outcome,'INSPECTED');assert.deepEqual(await state(),before);
  if(mode==='audit-rejected'){
   assert.equal(after.projectionState,'IN_FLIGHT');assert.equal(after.historicalReceiptDigest,null);
   assert.equal(after.historicalSettlementDigest,null);assert.equal(count,0);assert.deepEqual(entries,[]);
  }else{
   assert.equal(after.projectionState,'VERIFIED');assert.equal(after.preimageDigest,preimageDigest);
   assert.equal(after.historicalReceiptDigest,pin);assert.equal(after.historicalSettlementDigest,approval);assert.equal(count,1);
   assert.equal(entries.length,1);assert.deepEqual(JSON.parse(entries[0].after_json),[pin,approval,preimageDigest]);
   assert.equal((await call({action:'INSPECT'})).proofKind,'HISTORICAL');
   const e=await db.prepare(DAILY_FAILED_INCIDENT_EVIDENCE_SQL).bind('book').first();
   const guard=verifiedHeldDailyGuard(e,preimageDigest);
   assert.equal((await db.prepare(`SELECT CASE WHEN ${guard.sql} THEN 1 ELSE 0 END AS allowed`).bind(...guard.args).first()).allowed,0);
   for(const query of ["UPDATE admin_audit SET after_json='[]' WHERE id=?",'DELETE FROM admin_audit WHERE id=?',
    "INSERT OR REPLACE INTO admin_audit(id,action,entity_key,reason,created_at) VALUES(?,'fixture','entity','fixture','now')"])
    await assert.rejects(db.prepare(query).bind(entries[0].id).run(),/historical daily audit is immutable/);
   await assert.rejects(db.prepare("INSERT OR REPLACE INTO admin_audit(rowid,id,action,entity_key,reason,created_at) VALUES(?,'replaced','fixture','entity','fixture','now')")
    .bind(entries[0].rowid).run(),/historical daily audit is immutable/);
   await db.prepare("INSERT INTO admin_audit(id,action,entity_key,reason,created_at) VALUES('unrelated','fixture','entity','fixture','now')").run();
   await assert.rejects(db.prepare("UPDATE OR REPLACE admin_audit SET rowid=? WHERE id='unrelated'")
    .bind(entries[0].rowid).run(),/historical daily audit is immutable/);
   await db.prepare('DROP TRIGGER issue296_historical_daily_audit_no_delete').run();
   assert.equal((await call(inspect)).outcome,'HELD');
  }
  assert.equal(batches,1);assert.equal(h.writes(),1);
 }finally{notice.stableNoticeStyleFingerprint=oldStyle;if(local)await local.close();h.close();}
});

async function verifySerialWorkerChain({h,db,finish,completed,successorId,waitingId,version,tick,roundId,single,two,drift}){
 const {handleAdmin}=require('../dist/admin/handler.js');
 const {recoverPendingSheetJobs}=require('../dist/db/repositories.js');
 const worker=require('../dist/index.js').default;
 const secret='s'.repeat(40),env={...h.env,ADMIN_TOKEN:secret};
 const call=async(route,body)=>{
  const request=new Request('https://example.test/admin/stable-sync/'+route,{
   method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':version},
   body:JSON.stringify(body)
  });
  return (await handleAdmin(request,env,{})).json();
 };
 const operate=body=>call('normal-expense-pilot',body);
 const advance={...finish,action:'ADVANCE_ONE',nextJobId:successorId,proof:completed.proof,externalWritersFenced:true,ownerSupervising:true,...(roundId?{roundId}:{})};
 const read=(jobId,fingerprint)=>call('normal-pilot-readback',{action:'READBACK',jobId,fingerprint});
 const countAdvances=async()=>(await db.prepare("SELECT count(*) n FROM admin_audit WHERE action='ISSUE296_SERIAL_EXPENSE_HANDOVER'").first()).n;
 const before=(await db.prepare('SELECT expense_id,status,version,amount_satang FROM expense_events ORDER BY expense_id').all()).results;
 const methodNames=['batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues'];
 const originalReads=methodNames.map(name=>client[name]);
 const queued=[];
 env.JOB_QUEUE={send:async(body,options)=>queued.push({body,options})};
 try{
  // Honor the same narrow row and carrier ranges as the Sheets values API.
  for(const [i,name] of methodNames.entries())client[name]=async(env,ranges,policy)=>{
   const grid=i===0?h.formula():h.effective();
   const row=/!A(\d+):AC\1$/.exec(ranges[0]);
   if(ranges.length===2&&row&&/!Y1:Y\d+$/.test(ranges[1])){
    return [[grid[Number(row[1])-1].slice()],grid.map(r=>[r[24]])];
   }
   return originalReads[i](env,ranges,policy);
  };
  const valueRow=h.effective().find(row=>row[23]==='MALIPANG_EXPENSE:exp_pilot');
  assert.ok(valueRow);
  if(roundId){
   const record={...finish,action:'RECORD_VERIFIED',roundId,proof:completed.proof,externalWritersFenced:true,ownerSupervising:true};
   assert.equal((await operate(record)).outcome,'RECORDED');
   assert.equal((await operate(record)).outcome,'RECORDED');
   assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_verified_evidence WHERE round_id=?').bind(roundId).first()).n,1);
   if(drift){
    await db.prepare("UPDATE expense_events SET amount_satang=amount_satang+1 WHERE expense_id='exp_pilot'").run();
    const held=await call('serial-round-recovery',{action:'CLOSE_VERIFIED',roundId,ownerSupervising:true,externalWritersFenced:true});
    assert.notEqual(held.outcome,'CLOSED');
    assert.equal((await db.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').bind(roundId).first()).state,'OPEN');
    assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_round_results WHERE round_id=?').bind(roundId).first()).n,0);
    return;
   }
   if(single){
    const body={action:'CLOSE_VERIFIED',roundId,ownerSupervising:true,externalWritersFenced:true};
    await db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other-writer','HELD','now','now')").run();
    assert.notEqual((await call('serial-round-recovery',body)).outcome,'CLOSED');
    assert.equal((await db.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').bind(roundId).first()).state,'OPEN');
    await db.prepare("DELETE FROM stable_workbook_claims WHERE operation_token='other-writer'").run();
    assert.notEqual((await call('serial-round-recovery',body)).outcome,'CLOSED');
    // The independent base guard also rejects an incomplete implementation.
    const verifiedGuard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_verified_close_guard'").first();
    await db.prepare('DROP TRIGGER serial_pilot_verified_close_not_ready').run();
    await db.prepare('DROP TRIGGER serial_pilot_verified_close_guard').run();
    assert.notEqual((await call('serial-round-recovery',body)).outcome,'CLOSED');
    await db.prepare(verifiedGuard.sql).run();
    // Commit a result separately, then prove close rechecks it in its own
    // transaction. Fixture DDL below models corrupted immutable evidence.
    await db.prepare("INSERT INTO serial_pilot_round_results VALUES(?,?,'VERIFIED','VERIFIED_RECEIPT',NULL)").bind(roundId,finish.jobId).run();
    const closeDirect=()=>db.prepare("UPDATE serial_pilot_rounds SET state='CLOSED',closed_at='later',reason='ALL_VERIFIED' WHERE round_id=?").bind(roundId);
    await assert.rejects(db.batch([closeDirect(),db.prepare("SELECT json_extract('invalid','$')")]),/malformed JSON/);
    // The preceding control proves this exact positive close was valid before
    // the injected final failure. Each missing guard must independently abort
    // the same close, and D1 must roll back the DDL and leave the round OPEN.
    const integritySql=readFileSync(new URL('../migrations-draft/0079_serial_verified_close_draft.sql',import.meta.url),'utf8').split('CREATE TRIGGER serial_pilot_verified_close_guard')[0];
    const dependencyGroups=[...integritySql.matchAll(/name IN \(([\s\S]*?)\)\)<>(\d+)/g)];
    assert.equal(dependencyGroups.length,3);
    const dependencies=dependencyGroups.flatMap(([,list,count])=>{const names=[...list.matchAll(/'([a-z0-9_]+)'/g)].map(x=>x[1]);assert.equal(names.length,Number(count));return names;});
    assert.equal(new Set(dependencies).size,63);
    for(const name of [...new Set(['serial_pilot_verified_close_guard','serial_pilot_verified_close_integrity','serial_pilot_verified_close_chain','serial_pilot_verified_close_journal','serial_pilot_verified_close_mixed',...dependencies])]){
     await assert.rejects(db.batch([db.prepare('DROP TRIGGER '+name),closeDirect()]),/invalid round transition|verified close integrity unverified/,name);
     assert.equal((await db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name=?").bind(name).first()).n,1,name+' DDL rollback');
     assert.equal((await db.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').bind(roundId).first()).state,'OPEN',name+' round rollback');
    }
    await assert.rejects(db.batch([db.prepare("UPDATE expense_events SET amount_satang=amount_satang+1 WHERE expense_id='exp_pilot'"),closeDirect()]),/verified identity changed before close/);
    const revisionGuard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='stable_source_revision_expense_events_update'").first();
    await assert.rejects(db.batch([db.prepare('DROP TRIGGER stable_source_revision_expense_events_update'),db.prepare("UPDATE expense_events SET amount_satang=amount_satang+1 WHERE expense_id='exp_pilot'"),db.prepare(revisionGuard.sql),closeDirect()]),/verified identity changed before close/);
    await assert.rejects(db.batch([db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other-writer','HELD','now','now')"),closeDirect()]),/verified identity changed before close/);
    await assert.rejects(db.batch([db.prepare('DROP TRIGGER continuous_expense_projection_target_fence'),closeDirect()]),/verified close integrity unverified/);
    const projectionGuard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='stable_projection_transition'").first();
    await assert.rejects(db.batch([db.prepare('DROP TRIGGER stable_projection_transition'),db.prepare("UPDATE stable_projection_writes SET source_digest=? WHERE entity_id='exp_pilot' AND projection='EXPENSE_RAW'").bind('f'.repeat(64)),db.prepare(projectionGuard.sql),closeDirect()]),/verified journal changed before close/);
    const auditGuard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_fence_audit_no_update'").first();
    await assert.rejects(db.batch([db.prepare('DROP TRIGGER serial_pilot_fence_audit_no_update'),db.prepare("UPDATE admin_audit SET reason=? WHERE entity_key=? AND action='ISSUE296_PAUSED_NOTICE_HANDOVER'").bind('0'.repeat(64),finish.jobId),db.prepare(auditGuard.sql),closeDirect()]),/verified round chain unverified|verified identity changed before close/);
    const receipt=await db.prepare('SELECT proof_inputs FROM serial_pilot_verified_evidence WHERE round_id=? AND job_id=?').bind(roundId,finish.jobId).first(),receiptGuard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_verified_evidence_no_update'").first();
    for(const mutate of [items=>items.reverse(),items=>items.slice(1),items=>[...items.slice(1),items[1]],()=>null]){
     const value=JSON.parse(receipt.proof_inputs);value[9]=mutate(value[9]);
     await assert.rejects(db.batch([db.prepare('DROP TRIGGER serial_pilot_verified_evidence_no_update'),db.prepare('UPDATE serial_pilot_verified_evidence SET proof_inputs=? WHERE round_id=? AND job_id=?').bind(JSON.stringify(value),roundId,finish.jobId),db.prepare(receiptGuard.sql),closeDirect()]),/verified journal changed before close/);
    }
    const resultGuard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_pilot_results_no_delete'").first();
    await db.prepare('DROP TRIGGER serial_pilot_results_no_delete').run();await db.prepare('DELETE FROM serial_pilot_round_results WHERE round_id=?').bind(roundId).run();await db.prepare(resultGuard.sql).run();
    const closed=await call('serial-round-recovery',body);assert.equal(closed.outcome,'CLOSED');assert.equal(closed.selected,1);
    assert.deepEqual(closed.results.map(x=>[x.jobId,x.category,x.successorJobId]),[[finish.jobId,'VERIFIED',null]]);
    const again=await call('serial-round-recovery',body);assert.deepEqual(again.results,closed.results);
    // Simulate a privileged schema bypass: even a structurally plausible
    // terminal result must not be accepted with a conflicting durable edge.
    await db.prepare('DROP TRIGGER serial_pilot_fence_audit_no_update').run();
    await db.prepare("UPDATE admin_audit SET reason=? WHERE entity_key=? AND action='ISSUE296_PAUSED_NOTICE_HANDOVER'").bind('0'.repeat(64),finish.jobId).run();
    assert.notEqual((await call('serial-round-recovery',body)).outcome,'CLOSED');
    await db.prepare("UPDATE admin_audit SET reason=? WHERE entity_key=? AND action='ISSUE296_PAUSED_NOTICE_HANDOVER'").bind(finish.fingerprint,finish.jobId).run();
    const nextVersion='99999999-1111-2222-3333-444444444444',writesBefore=h.writes(),queuedBefore=queued.length;
    const auditsBefore=(await db.prepare('SELECT count(*) n FROM admin_audit').first()).n;
    env.CF_VERSION_METADATA={id:nextVersion};
    const historical=await handleAdmin(new Request('https://example.test/admin/stable-sync/serial-round-recovery',{
     method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':nextVersion},body:JSON.stringify({action:'READ',roundId})
    }),env,{});
    const recovered=await historical.json();
    assert.equal(recovered.outcome,'CLOSED');assert.deepEqual(recovered.results,closed.results);
    assert.equal(recovered.recordedResultsAreCurrentProviderProof,false);assert.equal(recovered.readRevalidatesRecordedIntegrity,false);
    assert.ok(recovered.receipts[0].verifiedAt);
    assert.equal((await db.prepare('SELECT count(*) n FROM admin_audit').first()).n,auditsBefore);
    assert.equal(h.writes(),writesBefore);assert.equal(queued.length,queuedBefore);
    env.CF_VERSION_METADATA={id:version};
    return;
   }
  }
  if(two){
   const beforeReservation=await call('serial-round-recovery',{action:'READ',roundId});
   assert.deepEqual(beforeReservation.reservationChain,{status:'OBSERVED',jobIds:[finish.jobId],workerVersion:version});
  }
  const oldAmount=valueRow[7];
  valueRow[7]=999;
  assert.equal((await operate(advance)).ok,false,'D1 completion alone cannot admit C');
  assert.equal(await countAdvances(),0);
  valueRow[7]=oldAmount;
  assert.equal((await read(finish.jobId,finish.fingerprint)).outcome,'MATCHED');
  for(const bad of [{proof:'0'.repeat(64)},{ownerSupervising:false},{externalWritersFenced:false}]){
   assert.notEqual((await operate({...advance,...bad})).ok,true);
  }
  assert.equal(await countAdvances(),0);

  const batch=env.DB.batch;
  try{
   // Another writer invalidates A's failure evidence after B's live readback.
   env.DB.batch=async statements=>{
    await db.prepare("UPDATE failed_jobs SET attempt_count=2 WHERE id='failed'").run();
    return batch.call(env.DB,statements);
   };
   assert.equal((await operate(advance)).ok,false);
   assert.equal(await countAdvances(),0,'an invalidated parked root must roll back the whole handover');
   await db.prepare("UPDATE failed_jobs SET attempt_count=1 WHERE id='failed'").run();

   // D1 commits the transfer but the caller loses the acknowledgement.
   env.DB.batch=async statements=>{
    await batch.call(env.DB,statements);
    throw Error('synthetic successor acknowledgement lost');
   };
   assert.equal((await operate(advance)).ok,false);
   assert.equal(await countAdvances(),1);
  }finally{env.DB.batch=batch;}
  if(two){
   const nextVersion='99999999-1111-2222-3333-444444444444';
   env.CF_VERSION_METADATA={id:nextVersion};
   const readHistorical=async()=>{const response=await handleAdmin(new Request('https://example.test/admin/stable-sync/serial-round-recovery',{
    method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':nextVersion},
    body:JSON.stringify({action:'READ',roundId})
   }),env,{});assert.equal(response.status,200);return response.json();};
   const readback=await readHistorical();
   assert.equal(readback.outcome,'OPEN');
   assert.deepEqual(readback.reservationChain,{status:'OBSERVED',jobIds:[finish.jobId,successorId],workerVersion:version});
   const prepare=env.DB.prepare;
   try{
    for(const fault of ['historical snapshot absent','optional lookup unavailable']){
     env.DB.prepare=function(sql){
      if(sql.includes('JOIN serial_pilot_reservation_snapshots saved')){
       if(fault==='optional lookup unavailable')throw Error('synthetic unavailable lookup');
       // Model reservations made before the snapshot migration, which were never backfilled.
       sql=sql.replace('JOIN serial_pilot_reservation_snapshots saved','JOIN (SELECT * FROM serial_pilot_reservation_snapshots WHERE 0) saved');
      }
      return prepare.call(this,sql);
     };
     const incomplete=await readHistorical();
     assert.equal(incomplete.outcome,'OPEN');assert.deepEqual(incomplete.reservationChain,{status:'UNKNOWN'});
     assert.equal(incomplete.observations.length,2);
    }
   }finally{env.DB.prepare=prepare;}
   assert.equal(await countAdvances(),1);
   env.CF_VERSION_METADATA={id:version};
  }
  const competing=await Promise.all([operate(advance),operate({...advance,nextJobId:waitingId})]);
  assert.equal(competing[1].ok,false,'stale B request cannot admit another child');
  assert.equal(await countAdvances(),1);
  const audit=await db.prepare("SELECT entity_key,json_extract(before_json,'$.predecessorJobId') predecessor FROM admin_audit WHERE id=?").bind('issue296:serial:'+finish.jobId).first();
  assert.deepEqual(audit,{entity_key:successorId,predecessor:finish.jobId});
  const finishC={...finish,jobId:successorId};
  assert.equal((await operate(finishC)).outcome,'IN_PROGRESS');
  assert.equal((await read(successorId,finish.fingerprint)).ok,false,'B evidence cannot satisfy an unwritten C');
  assert.equal(await recoverPendingSheetJobs(env,300),1);
  h.setMode('third-pilot');
  for(const expectedStatus of ['PENDING','PENDING','COMPLETED']){
   assert.equal(queued.length,1);
   const {body}=queued.shift();
   assert.equal(body.entityKey,'exp_serial');
   tick();
   let acknowledgements=0;
   await worker.queue({queue:'malipang-jobs',messages:[{body,attempts:1,ack(){acknowledgements++;},retry(){assert.fail('unexpected successor retry');}}]},env,{});
   assert.equal(acknowledgements,1);
   const state=await db.prepare('SELECT status,last_error FROM sync_jobs WHERE job_id=?').bind(successorId).first();
   assert.equal(state.status,expectedStatus,JSON.stringify(state));
   if(expectedStatus==='PENDING')assert.equal(queued[0]?.options?.delaySeconds,90);
  }
  assert.equal(queued.length,0);
  const proofC=await operate(finishC);
  assert.equal(proofC.outcome,'JOB_COMPLETE');
  assert.notEqual(proofC.proof,completed.proof);
  assert.equal((await read(successorId,finish.fingerprint)).outcome,'MATCHED');
  assert.deepEqual(await operate(finishC),proofC);
  assert.equal((await read(waitingId,finish.fingerprint)).ok,false);
  assert.equal((await db.prepare('SELECT status FROM sync_jobs WHERE job_id=?').bind(waitingId).first()).status,two?'REVIEW':'PENDING');
  assert.equal((await db.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").first()).status,'REVIEW');
  assert.equal((await db.prepare("SELECT status FROM failed_jobs WHERE id='failed'").first()).status,'OPEN');
  assert.deepEqual((await db.prepare('SELECT expense_id,status,version,amount_satang FROM expense_events ORDER BY expense_id').all()).results,before);
  const posted=h.effective().filter(row=>row[23]==='MALIPANG_EXPENSE:exp_serial');
  assert.equal(posted.length,1);
  assert.equal(posted[0][7],2.6);
  if(two){
   const recordC={...finishC,action:'RECORD_VERIFIED',roundId,proof:proofC.proof,externalWritersFenced:true,ownerSupervising:true};
   assert.equal((await operate(recordC)).outcome,'RECORDED');
   assert.notEqual((await call('serial-round-recovery',{action:'CLOSE_VERIFIED',roundId,ownerSupervising:true,externalWritersFenced:true})).outcome,'CLOSED');
   // Local fixture only: remove the not-ready barrier after installing the guards.
   await db.prepare('DROP TRIGGER serial_pilot_verified_close_not_ready').run();
   const closed=await call('serial-round-recovery',{action:'CLOSE_VERIFIED',roundId,ownerSupervising:true,externalWritersFenced:true});
   assert.equal(closed.outcome,'CLOSED');assert.equal(closed.selected,2);
   assert.deepEqual(closed.results.map(x=>[x.jobId,x.category,x.successorJobId]),[[finish.jobId,'VERIFIED',successorId],[successorId,'VERIFIED',null]]);
   return;
  }
  // A successor can itself become a proven predecessor; concurrent operator retries
  // must not create two admissions or reuse the original B -> C link.
  const advanceD={...advance,jobId:successorId,nextJobId:waitingId,proof:proofC.proof};
  const admitted=await Promise.all([operate(advanceD),operate(advanceD)]);
  assert.ok(admitted.some(result=>result.outcome==='RESERVED'),JSON.stringify(admitted));
  assert.equal(await countAdvances(),2);
  const open=await db.prepare("SELECT target_key FROM stable_recovery_epochs WHERE state='ARMED'").all();
  assert.deepEqual(open.results,[{target_key:'exp_wait'}]);
  assert.equal(h.writes(),6,'reservation alone cannot write to Sheets');
 }finally{
  for(const [i,name] of methodNames.entries())client[name]=originalReads[i];
 }
}

for(const finalAck of ['received','lost']) for(const roundMode of [false,true,...(finalAck==='received'?['single','two','drift','classification-notstarted-100','classification-notstarted-race','classification-notstarted-consumer','classification-notstarted','classification-drift','classification-race','classification-consumer','classification-test','hold-first','hold-expired','hold-drift','hold-revoked','hold-preexpired','release-test','release-race','ledger-test','ledger-final','ledger-final-zero','ledger-order','ledger-race','ledger-zero','worker-mock','worker-fault-scope','worker-fault-ack','worker-fault-race','worker-fault-postlost','worker-fault-raw-lost','worker-fault-detail-lost','worker-fault-budget','worker-fault-atomic','worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-barrier','worker-fault-final-ready-lost','worker-fault-final-ready-revoke','worker-fault-final-receipt-lost','worker-fault-final-complete-lost','worker-fault-final-guard-drift','worker-fault-final-scope-drift','lease-first','hold-race',...BPRED_MODES]:[])])
test('Miniflare exact DAILY settlement preserves both holds when the commit ACK is '+finalAck+(roundMode?' with round evidence'+(['single','two','drift','classification-notstarted-100','classification-notstarted-race','classification-notstarted-consumer','classification-notstarted','classification-drift','classification-race','classification-consumer','classification-test','hold-first','hold-expired','hold-drift','hold-revoked','hold-preexpired','release-test','release-race','ledger-test','ledger-final','ledger-final-zero','ledger-order','ledger-race','ledger-zero','worker-mock','worker-fault-scope','worker-fault-ack','worker-fault-race','worker-fault-postlost','worker-fault-raw-lost','worker-fault-detail-lost','worker-fault-budget','worker-fault-atomic','worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-barrier','worker-fault-final-ready-lost','worker-fault-final-ready-revoke','worker-fault-final-receipt-lost','worker-fault-final-complete-lost','worker-fault-final-guard-drift','worker-fault-final-scope-drift','lease-first','hold-race',...BPRED_MODES].includes(roundMode)?' '+(roundMode==='single'?'worker-mock close verified-single':roundMode==='two'?'worker-mock close verified-two':roundMode.startsWith('classification-')?'worker-mock close '+roundMode:roundMode==='ledger-final'?'worker-mock close finalhelper':roundMode==='ledger-final-zero'?'worker-mock close finalhelper-zero':roundMode.startsWith('worker-fault-')?'worker-mock close '+roundMode.slice('worker-fault-'.length):roundMode+' close'):''):''),async()=>{
 const h=await fixture(false,true,'claim-token-recovery',false,'รายวันต่อเนื่อง_แบบร่าง'),oldStyle=notice.stableNoticeStyleFingerprint;
 let local,wholeRunner,wholeFinish,wholeRestoreRead,wholeIdentityDir;
 const bounded=async(promise,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('WHOLE_TEST_TIMEOUT_'+label)),30000);})]);}finally{clearTimeout(timer);}};
 try{
  h.setMode('timeout');await assert.rejects(h.run(),/synthetic lost response/);
  const pilotId='10000000-1111-2222-3333-444444444444';
  h.sqlite.exec(`INSERT INTO continuous_cutover_operator(spreadsheet_id,operation_token,origin,state,created_at,updated_at) VALUES('book','claim-token-recovery','NEW','STARTING','now','now');
   UPDATE continuous_cutover_operator SET state='HELD'; UPDATE continuous_cutover_operator SET state='RELEASING'; UPDATE continuous_cutover_operator SET state='COMPLETE';
   INSERT INTO continuous_canary_operator(spreadsheet_id,expense_id,document_id,item_id,line_user_id,transaction_date,trace_id,state,created_at,updated_at) VALUES('book','exp_canary_test','doc_canary_test','item_canary_test','CANARY_NO_LINE_test','2026-11-15','trace_canary_test','DRAFT','now','now');
   UPDATE continuous_canary_operator SET state='CONFIRMING';UPDATE continuous_canary_operator SET state='CONFIRMED';UPDATE continuous_canary_operator SET state='ARMED_CONFIRM';
   UPDATE continuous_canary_operator SET state='DUPLICATE_ARMED',duplicate_epoch_id='duplicate_epoch';UPDATE continuous_canary_operator SET state='DUPLICATE_SEEN';UPDATE continuous_canary_operator SET state='DUPLICATE_VERIFIED';UPDATE continuous_canary_operator SET state='UNDOING';UPDATE continuous_canary_operator SET state='UNDONE';UPDATE continuous_canary_operator SET state='ARMED_UNDO';UPDATE continuous_canary_operator SET state='VERIFIED';
   INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_pilot','pilot-msg','owner','pilot',120,'transfer','SHOP_BANK','ingredients',date('now','+7 hours'),'CONFIRMED','now',1);
   INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,expense_id) VALUES('doc_pilot','doc-msg','owner','RECEIPT','CONFIRMED','now','exp_pilot');
   INSERT INTO expense_document_items(item_id,document_id,expense_id,description,line_total_satang,created_at,updated_at) VALUES('item_pilot','doc_pilot','exp_pilot','item',120,'now','now');
   INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES('link_pilot','exp_pilot','doc_pilot','PRIMARY_PURCHASE_DOCUMENT','EXACT_IDENTIFIER','now');
   INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('${pilotId}','EXPENSE','exp_pilot',1,'trace-pilot','PENDING','now');`);
  const successorId='20000000-1111-2222-3333-444444444444';
  const waitingId='30000000-1111-2222-3333-444444444444';
  for(const [jobId,expenseId] of ((String(roundMode).startsWith('classification-notstarted')||roundMode==='worker-fault-final-four')?[[successorId,'exp_serial']]:[[successorId,'exp_serial'],[waitingId,'exp_wait']])){
   h.sqlite.prepare(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version)
    VALUES(?,?,'owner',?,260,'transfer','SHOP_BANK','ingredients',date('now','+7 hours'),'CONFIRMED','now',1)`).run(expenseId,expenseId,expenseId);
   h.sqlite.prepare(`INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at)
    VALUES(?,'EXPENSE',?,1,?,'PENDING','2020-01-01T00:00:00.000Z')`).run(jobId,expenseId,expenseId);
  }
  const holdMode=['classification-notstarted-100','classification-notstarted-race','classification-notstarted-consumer','classification-notstarted','classification-drift','classification-race','classification-consumer','classification-test','hold-first','hold-expired','hold-drift','hold-revoked','hold-preexpired','release-test','release-race','ledger-test','ledger-final','ledger-final-zero','ledger-order','ledger-race','ledger-zero','worker-mock','worker-fault-scope','worker-fault-ack','worker-fault-race','worker-fault-postlost','worker-fault-raw-lost','worker-fault-detail-lost','worker-fault-budget','worker-fault-atomic','worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-barrier','worker-fault-final-ready-lost','worker-fault-final-ready-revoke','worker-fault-final-receipt-lost','worker-fault-final-complete-lost','worker-fault-final-guard-drift','worker-fault-final-scope-drift','lease-first','hold-race',...BPRED_MODES].includes(roundMode),namespace='a'.repeat(32),holdExpense=`exp_${namespace}_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,nextExpense=`exp_${namespace}_bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
  if(holdMode){
   h.sqlite.exec(`DELETE FROM sync_jobs WHERE job_id IN ('${pilotId}','${successorId}'); DROP TRIGGER serial_source_provenance_not_ready;
    INSERT INTO serial_source_provenance_activation VALUES(1,'book','${namespace}','now'); DROP TRIGGER serial_job_provenance_not_ready;
    INSERT INTO serial_job_provenance_activation VALUES(1,'book','now');
    INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version,serial_source_namespace) VALUES('${holdExpense}','hold-msg','owner','pilot',120,'transfer','SHOP_BANK','ingredients',date('now','+7 hours'),'WAITING_CONFIRM','now',1,'${namespace}');
    UPDATE expense_events SET status='CONFIRMED' WHERE expense_id='${holdExpense}';
    INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,serial_provenance_version) VALUES('${pilotId}','EXPENSE','${holdExpense}',1,'trace-pilot','PENDING','now',1);
    INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version,serial_source_namespace) VALUES('${nextExpense}','next-hold-msg','owner','next',260,'transfer','SHOP_BANK','ingredients',date('now','+7 hours'),'WAITING_CONFIRM','now',1,'${namespace}');
    UPDATE expense_events SET status='CONFIRMED' WHERE expense_id='${nextExpense}';
    INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,expense_id) VALUES('doc_next','doc-next','owner','RECEIPT','CONFIRMED','now','${nextExpense}');
    ${['ledger-zero','ledger-final-zero'].includes(roundMode)?'':`INSERT INTO expense_document_items(item_id,document_id,expense_id,description,line_total_satang,created_at,updated_at) VALUES('item_next','doc_next','${nextExpense}','item',160,'now','now'); INSERT INTO expense_document_items(item_id,document_id,expense_id,description,line_total_satang,created_at,updated_at) VALUES('item_next2','doc_next','${nextExpense}','item two',100,'now','now');`}
    INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES('link_next','${nextExpense}','doc_next','PRIMARY_PURCHASE_DOCUMENT','EXACT_IDENTIFIER','now');
    INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,serial_provenance_version) VALUES('${successorId}','EXPENSE','${nextExpense}',1,'next-hold','PENDING','2020-01-01T00:00:00.000Z',1);`);
  }
  if((String(roundMode).startsWith('classification-notstarted')||roundMode==='worker-fault-final-four')){
   const waitingExpense=`exp_${namespace}_cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
   h.sqlite.exec(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version,serial_source_namespace) VALUES('${waitingExpense}','wait-msg','owner','waiting',100,'transfer','SHOP_BANK','ingredients',date('now','+7 hours'),'WAITING_CONFIRM','now',1,'${namespace}');
    UPDATE expense_events SET status='CONFIRMED' WHERE expense_id='${waitingExpense}';
    INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,serial_provenance_version) VALUES('${waitingId}','EXPENSE','${waitingExpense}',1,'wait-hold','PENDING','2020-01-01T00:00:00.000Z',1);`);
  }
  const mixedUnresolvedId='40000000-9999-4222-8333-444444444444';
  if(roundMode==='worker-fault-final-four'){
   h.sqlite.exec(`INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_mixed_unknown','mixed-unknown','owner','unknown',100,'transfer','SHOP_BANK','ingredients',date('now','+7 hours'),'CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,serial_provenance_version) VALUES('${mixedUnresolvedId}','EXPENSE','exp_mixed_unknown',1,'mixed-unknown','PENDING','2021-01-01T00:00:00.000Z',0);`);
  }
  const extraWaiting=[];
  if(roundMode==='classification-notstarted-100'){
   for(let i=1;i<=97;i++){
    const id=`${(0x30000000+i).toString(16)}-1111-2222-3333-444444444444`,suffix=`${i.toString(16).padStart(8,'0')}-cccc-4ccc-8ccc-cccccccccccc`,expense=`exp_${namespace}_${suffix}`;
    h.sqlite.prepare("INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version,serial_source_namespace) VALUES(?,?,'owner','waiting',100,'transfer','SHOP_BANK','ingredients',date('now','+7 hours'),'WAITING_CONFIRM','now',1,?)").run(expense,`wait-${i}`,namespace);
    h.sqlite.prepare("UPDATE expense_events SET status='CONFIRMED' WHERE expense_id=?").run(expense);
    h.sqlite.prepare("INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,serial_provenance_version) VALUES(?,'EXPENSE',?,1,?,'PENDING','2021-01-01T00:00:00.000Z',1)").run(id,expense,`wait-${i}`);extraWaiting.push(id);
   }
  }
  h.sqlite.exec("UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED',notice_stamp='stamp',notice_identity='identity',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id='book'");
  h.sqlite.exec("UPDATE sync_jobs SET status='REVIEW',lease_token=NULL,lease_until=NULL,last_error='STABLE_SYNC_REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id='job'");
  h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('failed','malipang-jobs','fixture','EXPENSE:exp_test:1',?,'Error: STABLE_JOB_HOLD_UNCERTAIN','OPEN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(JSON.stringify(h.job));
  h.formula().push(Array(29).fill(null));h.effective().push(Array(29).fill(null));notice.stableNoticeStyleFingerprint=async()=> 'a'.repeat(64);
  local=await miniflareDailyFixture(h.sqlite);
  const {db}=local,version='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let fault='',batches=0;
  const updates=new WeakSet(),receipts=new WeakSet(),closes=new WeakSet(),holds=new WeakSet(),handoffs=new WeakSet(),releases=new WeakSet(),permits=new WeakSet(),authorizations=new WeakSet(),ledgerReceipts=new WeakSet(),finalReceipts=new WeakSet();let lostReceipt=false,lostClose=false,lostHold=false;
  h.env.DB={prepare(sql){
   const statement=db.prepare(sql);
   if(!sql.startsWith('UPDATE stable_projection_writes')&&!sql.includes('INSERT INTO serial_pilot_verified_evidence')&&!sql.includes('INSERT INTO serial_pilot_hold_evidence')&&!sql.includes('INSERT INTO serial_pilot_attested_handoffs')&&!sql.includes('serial_pilot_notice_release_not_ready')&&!sql.includes('INSERT INTO serial_pilot_continuation_permits')&&!sql.includes('INSERT INTO serial_pilot_continuation_authorizations')&&!sql.includes('INSERT INTO serial_pilot_ledger_stage_receipts')&&!sql.includes('INSERT INTO serial_pilot_final_receipts')&&!sql.startsWith('SELECT CASE WHEN (SELECT count(*) FROM admin_audit'))return statement;
   return {bind(...args){const bound=statement.bind(...args);if(sql.startsWith('UPDATE stable_projection_writes'))updates.add(bound);else if(sql.includes('INSERT INTO serial_pilot_verified_evidence'))receipts.add(bound);else if(sql.includes('INSERT INTO serial_pilot_hold_evidence'))holds.add(bound);else if(sql.includes('INSERT INTO serial_pilot_attested_handoffs'))handoffs.add(bound);else if(sql.startsWith('UPDATE stable_recovery_operations')&&sql.includes('serial_pilot_notice_release_not_ready'))releases.add(bound);else if(sql.includes('INSERT INTO serial_pilot_continuation_permits'))permits.add(bound);else if(sql.includes('INSERT INTO serial_pilot_continuation_authorizations'))authorizations.add(bound);else if(sql.includes('INSERT INTO serial_pilot_ledger_stage_receipts'))ledgerReceipts.add(bound);else if(sql.includes('INSERT INTO serial_pilot_final_receipts'))finalReceipts.add(bound);else closes.add(bound);return bound;}};
  },async batch(statements){
   if(finalReceipts.has(statements[0])){const result=await db.batch(statements);if(fault==='final-lost')throw Error('synthetic final receipt ACK lost');return result;}
   if(ledgerReceipts.has(statements[0])){const result=await db.batch(statements);if(fault==='ledger-lost')throw Error('synthetic ledger receipt ACK lost');return result;}
   if(permits.has(statements[0])||authorizations.has(statements[0])){const result=await db.batch(statements);if(fault==='permit-lost')throw Error('synthetic permit ACK lost');return result;}
   if(releases.has(statements[0])){if(fault==='release-rollback')return db.batch([statements[0],db.prepare("SELECT json_extract('invalid','$')"),...statements.slice(1)]);if(fault==='release-drop-after-update')return db.batch([...statements.slice(0,3),db.prepare('DROP TRIGGER continuous_daily_evidence_no_update'),...statements.slice(3)]);if(['release-revoked','ledger-release-revoked'].includes(fault))await db.prepare("INSERT INTO serial_pilot_oracle_revocations VALUES('book',?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind('f'.repeat(64)).run();if(fault==='release-drift'){await db.prepare('DROP TRIGGER serial_pilot_oracle_fence_no_update').run();await db.prepare("UPDATE serial_pilot_oracle_fence SET generation=2 WHERE spreadsheet_id='book'").run();}const result=await db.batch(statements);if(fault==='release-lost')throw Error('synthetic release ACK lost');return result;}
   if(handoffs.has(statements[0])){if(fault==='handoff-rollback')return db.batch([statements[0],db.prepare("SELECT json_extract('invalid','$')"),...statements.slice(1)]);if(fault==='handoff-revoked')await db.prepare("INSERT INTO serial_pilot_oracle_revocations VALUES('book',?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind('f'.repeat(64)).run();const result=await db.batch(statements);if(fault==='handoff-lost')throw Error('synthetic handoff ACK lost');return result;}
   if(holds.has(statements[0])){if(fault==='hold-rollback')return db.batch([statements[0],db.prepare("SELECT json_extract('invalid','$')"),...statements.slice(1)]);const result=await db.batch(statements);if(roundMode==='hold-first'&&!lostHold){lostHold=true;throw Error('synthetic hold ACK lost');}return result;}
   if(receipts.has(statements[0])){const result=await db.batch(statements);if(roundMode&&!lostReceipt){lostReceipt=true;throw Error('synthetic verified receipt ACK lost');}return result;}
   if(closes.has(statements[0])){const result=await db.batch(statements);if(['single','two'].includes(roundMode)&&!lostClose){lostClose=true;throw Error('synthetic verified close ACK lost');}return result;}
   if(!updates.has(statements[0]))return db.batch(statements);
   batches++;
   if(fault==='rollback')return db.batch([statements[0],db.prepare("SELECT json_extract('invalid-json','$')"),...statements.slice(1)]);
   if(fault==='race')await db.prepare("UPDATE failed_jobs SET attempt_count=2 WHERE id='failed'").run();
   const result=await db.batch(statements);if(fault==='lostAck')throw Error('synthetic D1 acknowledgement lost');return result;
  }};
  Object.assign(h.env,{STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',EXACT_DAILY_SETTLEMENT_ENABLED:'true',CF_VERSION_METADATA:{id:version}});
  const before=async()=>Promise.all(['stable_workbook_claims','sync_jobs','failed_jobs','expense_events','sync_alert_incidents'].map(async table=>(await db.prepare('SELECT * FROM '+table).all()).results));
  const baseline=await before(),call=operation=>operateExactDailySettlement(h.env,operation,version);
  const inspect=await call({action:'INSPECT'});assert.equal(inspect.outcome,'INSPECTED',JSON.stringify(inspect));assert.equal(inspect.projectionState,'IN_FLIGHT');
  const probe=await call({action:'PROBE',fingerprint:inspect.fingerprint});assert.equal(probe.outcome,'MATCHED',JSON.stringify(probe));
  const settle={action:'SETTLE',fingerprint:inspect.fingerprint,preimageDigest:probe.preimageDigest,externalWritersFenced:true,ownerSupervising:true};
  h.env.STABLE_RECOVERY_GATE_ENABLED='false';assert.equal((await call(settle)).stage,'CONFIG');h.env.STABLE_RECOVERY_GATE_ENABLED='true';
  h.env.MONTHLY_REPORT_OPERATOR_ENABLED='true';assert.equal((await call(settle)).stage,'CONFIG');h.env.MONTHLY_REPORT_OPERATOR_ENABLED='false';
  h.env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED='true';assert.equal((await call(settle)).stage,'CONFIG');h.env.CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED='false';
  assert.equal((await call({...settle,preimageDigest:'f'.repeat(64)})).stage,'PREIMAGE');assert.equal(batches,0);
  for(const failure of ['rollback','race']){
   fault=failure;const result=await call(settle);assert.equal(result.outcome,'UNCERTAIN',JSON.stringify(result));
   if(fault==='race')await db.prepare("UPDATE failed_jobs SET attempt_count=1 WHERE id='failed'").run();
   assert.equal((await call({action:'INSPECT'})).projectionState,'IN_FLIGHT');
   assert.equal((await db.prepare('SELECT count(*) n FROM stable_expense_projection_preimages').first()).n,0);
  }
  fault=finalAck==='lost'?'lostAck':'';
  const done=await call(settle);assert.equal(done.outcome,finalAck==='lost'?'UNCERTAIN':'SETTLED',JSON.stringify(done));
  const recovered=await call({action:'INSPECT'});assert.equal(recovered.projectionState,'VERIFIED',JSON.stringify(recovered));assert.equal(recovered.preimageDigest,probe.preimageDigest);assert.equal(recovered.fingerprint,inspect.fingerprint);
  const {verifiedHeldDailyGuard}=require('../dist/admin/exact-daily-settlement.js');
  const pinned=await readFailedDailyIncidentEvidence(h.env,recovered.fingerprint),guard=verifiedHeldDailyGuard(pinned,recovered.preimageDigest);
  assert.equal((await db.prepare('SELECT 1 ok WHERE '+guard.sql).bind(...guard.args).first()).ok,1);
  assert.equal((await call(settle)).outcome,'HELD');assert.equal(batches,3);
  assert.deepEqual(await before(),baseline);assert.equal(h.writes(),1);
  const {operateParkedPilot,parseParkedPilot}=require('../dist/admin/parked-expense-handover.js');
  const {takePausedPilot}=require('../dist/sheets/parked-notice-adoption.js');
  let roundId='40000000-1111-2222-3333-444444444444';
  const whole=roundMode==='worker-fault-final-whole',wholeActions=[];
  if(roundMode){
   await db.prepare('DROP TRIGGER serial_pilot_fence_not_ready').run(); // synthetic local D1 only
   await db.prepare("INSERT INTO serial_pilot_round_fence_activation VALUES(1,'2000-01-01T00:00:00.000Z')").run();
   await db.prepare("UPDATE sync_jobs SET updated_at='2019-01-01T00:00:00.000Z' WHERE job_id=?").bind(pilotId).run();
   if(['single','drift'].includes(roundMode))await db.prepare("UPDATE sync_jobs SET status='REVIEW' WHERE job_id IN (?,?)").bind(successorId,waitingId).run();
   if(holdMode&&!(String(roundMode).startsWith('classification-notstarted')||roundMode==='worker-fault-final-four'))await db.prepare("UPDATE sync_jobs SET status='REVIEW' WHERE job_id=?").bind(waitingId).run();
   if(roundMode==='two')await db.prepare("UPDATE sync_jobs SET status='REVIEW' WHERE job_id=?").bind(waitingId).run();
   const {handleAdmin}=require('../dist/admin/handler.js'),secret='s'.repeat(40);
   Object.assign(h.env,{ADMIN_TOKEN:secret,CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED:'true',SHEETS_SYNC_ENABLED:'true',UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED:'false'});
   if(whole){
    // Isolated local mock: the runner owns OPEN/HANDOVER/HOLD/RECORD/CLOSE.
    // Google, the external fence/oracle and backup/deployment responses remain synthetic.
    Object.assign(h.env,{APP_ENV:'test',SERIAL_PILOT_HOLD_ENABLED:'true',SERIAL_SOURCE_PROVENANCE_ENABLED:'true',SERIAL_JOB_PROVENANCE_ENABLED:'true',SERIAL_ATTESTED_HANDOFF_ENABLED:'true',SERIAL_MOCK_CONTINUATION_ENABLED:'true',SERIAL_MOCK_FINAL_COMPLETION_ENABLED:'true',SERIAL_MOCK_CLASSIFICATION_ENABLED:'true'});
    for(const name of ['serial_pilot_hold_not_ready','serial_pilot_oracle_fence_not_ready','serial_pilot_attested_handoff_not_ready','serial_pilot_oracle_revoke_not_ready'])await db.prepare('DROP TRIGGER '+name).run();
    await db.prepare("INSERT INTO serial_pilot_oracle_fence VALUES('book',?,1,'now')").bind('f'.repeat(64)).run();
    const {runNormalPilot}=await import('../scripts/prod-normal-queue-pilot.mjs'),{createHash}=await import('node:crypto');
    const {readAttestedHandoffContext,advanceAttestedHeldPilot}=require('../dist/admin/serial-attested-handoff.js'),{quiescencePayload}=require('../dist/admin/serial-quiescence-attestation.js');
    const readback=require('../dist/admin/normal-pilot-readback.js'),oldRead=readback.verifyNormalPilotRow;readback.verifyNormalPilotRow=async()=>true;wholeRestoreRead=()=>{readback.verifyNormalPilotRow=oldRead;};
    const sha='a'.repeat(40),runner={GITHUB_SHA:sha,EXPECTED_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',PILOT_PHASE:'RUN_SERIAL',PILOT_ROUND_MODE:'true',PILOT_LOCAL_IDENTITY:'true',PILOT_LOCAL_MOCK:'true',EXPECTED_WORKER_VERSION_SHA256:createHash('sha256').update(version).digest('hex'),CLOUDFLARE_API_TOKEN:'local',CLOUDFLARE_ACCOUNT_ID:'local',MALIPANG_ADMIN_TOKEN:secret,MALIPANG_WORKER_URL:'https://localhost/',BACKUP_RUN_ID:'123',GITHUB_TOKEN:'local',EXTERNAL_WRITERS_FENCED:'true',OWNER_SUPERVISING:'true'};
    let edgeResolve,edgeReject,releaseFinish;const edgeReady=new Promise((resolve,reject)=>{edgeResolve=resolve;edgeReject=reject;}),finishGate=new Promise(resolve=>{releaseFinish=resolve;});wholeFinish=releaseFinish;
    const fetcher=async(input,opts={})=>{const url=String(input);
     if(url.includes('/deployments?'))return Response.json({success:true,result:{deployments:[{versions:[{version_id:version,percentage:100}]}]}});
     if(url.includes('/d1/database/')){const {sql}=JSON.parse(opts.body);assert.match(sql,/^SELECT /);const rows=await db.prepare(sql).all();return Response.json({success:true,result:[{success:true,results:rows.results}]});}
     if(url.includes('/actions/runs/')){const job={name:'ops',id:1234,status:'completed',conclusion:'success',steps:[{name:'Backup and migration rehearsal',conclusion:'success'}]};return Response.json(url.includes('/jobs?')?{jobs:[job]}:{path:'.github/workflows/prod-ops-readonly.yml',event:'workflow_dispatch',status:'completed',conclusion:'success',head_sha:sha,created_at:new Date().toISOString()});}
     if(url.endsWith('/jobs/1234/logs'))return new Response(null,{status:302,headers:{location:'https://log.invalid/download'}});
     if(url==='https://log.invalid/download')return new Response(['export','backup_upload','backup_checksum','restore','integrity_before','foreign_keys_before','preexisting_rows_unchanged','integrity_after','foreign_keys_after','smoke_all'].map(k=>'- '+k+': PASS').join('\n'));
     assert.equal(new URL(url).origin,'https://localhost');const action=JSON.parse(opts.body).action;wholeActions.push(action);
     if(action==='FINISH_STATUS'&&!await finishGate)throw Error('WHOLE_TEST_CANCELLED');
     return handleAdmin(new Request(url,{method:opts.method,headers:opts.headers,body:opts.body}),h.env,{});
    };
    let attestation,key,context;const coordinator={
     async prepare(args){wholeActions.push('MOCK_PREPARE');roundId=args.roundId;context=await readAttestedHandoffContext(h.env,roundId,pilotId,successorId,version,()=>true);assert.ok(context);assert.equal(context.context.roundId,roundId);
      const signer=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);key=new Uint8Array(await crypto.subtle.exportKey('raw',signer.publicKey));
      attestation={...context.context,domain:'MALIPANG_SERIAL_QUIESCENCE_V1',nonce:'55555555-1111-2222-3333-444444444444',issuedAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),signature:''};
      attestation.signature=Buffer.from(await crypto.subtle.sign('Ed25519',signer.privateKey,quiescencePayload(attestation))).toString('base64url');
      return {...args,nonce:attestation.nonce,payloadDigest:createHash('sha256').update(quiescencePayload(attestation)).digest('hex'),claimDigest:context.context.claimDigest};},
     async reserve(intent){wholeActions.push('MOCK_RESERVE');assert.equal(intent.nonce,attestation.nonce);const result=await advanceAttestedHeldPilot(h.env,attestation,key,()=>true);assert.equal(result.outcome,'RESERVED',JSON.stringify(result));edgeResolve();},
     async inspect(expected){wholeActions.push('MOCK_INSPECT');const h=await db.prepare('SELECT claim_token FROM serial_pilot_attested_handoffs WHERE round_id=? AND predecessor_job_id=? AND successor_job_id=? AND nonce=? AND successor_epoch_id=? AND payload_digest=? AND worker_version=?').bind(expected.roundId,expected.predecessorJobId,expected.successorJobId,expected.nonce,expected.epochId,expected.payloadDigest,expected.workerVersion).first();return h?{...expected,outcome:'RESERVATION_RECORDED',claimDigest:createHash('sha256').update(h.claim_token).digest('hex')}:null;}
    };
    const {mkdtempSync,realpathSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{localIdentityStore}=await import('./helpers/serial-local-identity.mjs');
    wholeIdentityDir=realpathSync(mkdtempSync(join(tmpdir(),'serial-whole-identity-')));
    wholeRunner=runNormalPilot(runner,fetcher,async()=>{},coordinator,localIdentityStore(wholeIdentityDir));wholeRunner.catch(edgeReject);await bounded(edgeReady,'HANDOFF');
   }else{
   const request=new Request('https://synthetic.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'OPEN_INITIAL',roundId,fingerprint:inspect.fingerprint,preimageDigest:probe.preimageDigest,jobs:['single','drift'].includes(roundMode)?[pilotId]:(String(roundMode).startsWith('classification-notstarted')||roundMode==='worker-fault-final-four')?[pilotId,successorId,waitingId,...extraWaiting,...(roundMode==='worker-fault-final-four'?[mixedUnresolvedId]:[])]:roundMode==='two'||holdMode?[pilotId,successorId]:[pilotId,successorId,waitingId],ownerSupervising:true,externalWritersFenced:true})});
   const opened=await handleAdmin(request,h.env,{});assert.equal(opened.status,200,JSON.stringify(await opened.json()));
   }
  }
  const action={...settle,action:'HANDOVER_ONE',jobId:pilotId,...(roundMode?{roundId}:{})};
  const check={action:'INSPECT_HANDOVER',jobId:pilotId,fingerprint:inspect.fingerprint};
  const finish={...check,action:'FINISH_STATUS'};
  if(!whole){
  assert.deepEqual(parseParkedPilot(finish),finish);
  assert.equal(parseParkedPilot({...finish,extra:true}),null);
  assert.equal(parseParkedPilot({...action,ownerSupervising:false}),null);
  assert.equal(parseParkedPilot({...check,extra:1}),null);
  assert.deepEqual(parseParkedPilot(action),action);
  Object.assign(h.env,{CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED:'true',SHEETS_SYNC_ENABLED:'true',UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED:'false'});
  }
  const operate=value=>operateParkedPilot(h.env,value,version);
  if(releaseSchemaOnly&&!roundMode){
   // Release schema (0067): INSPECT, PROBE and SETTLE above ran on Miniflare D1.
   // KNOWN GAP (#296 phase B, not released): FINISH_STATUS reads serial tables and stays UNVERIFIED,
   // yet HANDOVER still reserves the pilot (claim HELD, epoch ARMED). The route is unreachable while
   // CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED is unset and the recovery gate is false. A separate runtime
   // change must make HANDOVER refuse here before phase B; it will flip these assertions.
   assert.deepEqual(await operate(finish),{ok:false,outcome:'UNVERIFIED'});
   assert.deepEqual(await operate(action),{ok:true,outcome:'RESERVED'});
   assert.deepEqual(await operate(finish),{ok:false,outcome:'UNVERIFIED'});
   assert.equal((await db.prepare("SELECT count(*) n FROM stable_workbook_claims WHERE state='HELD' AND phase='PILOT_RESERVED'").first()).n,1);
   return;
  }
  if(!whole){
  assert.deepEqual(await operate(finish),{ok:true,outcome:'NOT_STARTED'});
  assert.deepEqual(await operate(check),{ok:true,outcome:'ABSENT'});
  assert.equal((await operateParkedPilot(h.env,action,'wrong-version')).outcome,'HELD');
  assert.equal((await operate({...action,preimageDigest:'c'.repeat(64)})).outcome,'HELD');
  await db.prepare("UPDATE sync_jobs SET next_attempt_at='2099-01-01' WHERE job_id=?").bind(pilotId).run();
  assert.equal((await operate(action)).outcome,'UNCERTAIN'); // arming affected zero; batch rolls back the old claim delete
  assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE operation_token='claim-token-recovery'").first()).state,'REVIEW');
  assert.equal((await operate(check)).outcome,'ABSENT');
  await db.prepare("UPDATE sync_jobs SET next_attempt_at=NULL WHERE job_id=?").bind(pilotId).run();
  assert.deepEqual(await operate(action),{ok:true,outcome:'RESERVED'});
  }
  if(holdMode){
   Object.assign(h.env,{SERIAL_PILOT_HOLD_ENABLED:'true',SERIAL_SOURCE_PROVENANCE_ENABLED:'true',SERIAL_JOB_PROVENANCE_ENABLED:'true'});
   const {handleAdmin}=require('../dist/admin/handler.js'),secret='s'.repeat(40),{claimSheetSyncJob}=require('../dist/sheets/sync.js');
   const worker=require('../dist/index.js').default;
   const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:holdExpense,entityVersion:1,traceId:'trace-pilot'};
   const hold=async()=>{const req=new Request('https://synthetic.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'HOLD_RESERVED',roundId,jobId:pilotId,fingerprint:inspect.fingerprint,ownerSupervising:true,externalWritersFenced:true})});return (await handleAdmin(req,h.env,{})).json();};
   let att;
   if(!whole){
   assert.equal((await hold()).outcome,'HELD');assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_hold_evidence').first()).n,0);
   await db.prepare('DROP TRIGGER serial_pilot_hold_not_ready').run(); // local fixture only
   if(['classification-notstarted-100','classification-notstarted-race','classification-notstarted-consumer','classification-notstarted','classification-drift','classification-race','classification-consumer','classification-test','hold-first','hold-expired','hold-drift','hold-revoked','hold-preexpired','release-test','release-race','ledger-test','ledger-final','ledger-final-zero','ledger-order','ledger-race','ledger-zero','worker-mock','worker-fault-scope','worker-fault-ack','worker-fault-race','worker-fault-postlost','worker-fault-raw-lost','worker-fault-detail-lost','worker-fault-budget','worker-fault-atomic','worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-barrier','worker-fault-final-ready-lost','worker-fault-final-ready-revoke','worker-fault-final-receipt-lost','worker-fault-final-complete-lost','worker-fault-final-guard-drift','worker-fault-final-scope-drift'].includes(roundMode)){
    const prepare=h.env.DB.prepare,oldSheetId=h.env.CONTINUOUS_DAILY_SHEET_ID;
    h.env.DB.prepare=function(sql){const statement=prepare.call(this,sql);if(!sql.startsWith('SELECT 1 AS held'))return statement;return {bind(...args){const bound=statement.bind(...args);return {async all(){const result=await bound.all();h.env.CONTINUOUS_DAILY_SHEET_ID='99999';return result;}};}};};
    assert.notEqual((await hold()).outcome,'RECONCILIATION_REQUIRED');
    assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_hold_evidence').first()).n,0);
    h.env.DB.prepare=prepare;h.env.CONTINUOUS_DAILY_SHEET_ID=oldSheetId;
    fault='hold-rollback';assert.equal((await hold()).outcome,'UNCERTAIN');fault='';
    assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_hold_evidence').first()).n,0);
    assert.equal((await db.prepare('SELECT status FROM sync_jobs WHERE job_id=?').bind(pilotId).first()).status,'PENDING');
   }
   }
   if(roundMode==='hold-race'){
    const [result,lease]=await Promise.all([hold(),claimSheetSyncJob(h.env,job)]);
    assert.equal(result.outcome==='RECONCILIATION_REQUIRED',lease===null);
    assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_hold_evidence').first()).n,lease?0:1);
   }else if(roundMode==='lease-first'){
    assert.ok(await claimSheetSyncJob(h.env,job));assert.notEqual((await hold()).outcome,'RECONCILIATION_REQUIRED');
    assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_hold_evidence').first()).n,0);
   }else{
    if(!whole){
    const result=await hold();assert.equal(result.outcome,'RECONCILIATION_REQUIRED',JSON.stringify(result));
    assert.equal((await hold()).outcome,'RECONCILIATION_REQUIRED');assert.equal(await claimSheetSyncJob(h.env,job),null);
    assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_hold_evidence').first()).n,1);
    const retained=await db.prepare("SELECT c.phase,c.state,e.state epoch FROM stable_workbook_claims c JOIN stable_recovery_epochs e ON e.spreadsheet_id=c.spreadsheet_id WHERE c.spreadsheet_id='book' AND e.state='ARMED'").first();
    assert.deepEqual(retained,{phase:'PILOT_RESERVED',state:'HELD',epoch:'ARMED'});
    const readRequest=new Request('https://synthetic.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'READ',roundId})});
    const readResult=await (await handleAdmin(readRequest,h.env,{})).json();assert.equal(readResult.observations[0].holdReason,'SERIAL_PILOT_B_REVIEW');assert.equal(readResult.provenanceObservationsAreProof,false);
    const beforeWrites=h.writes();let ack=0,retry=0;
    await worker.queue({queue:'malipang-jobs',messages:[{body:job,attempts:1,ack(){ack++;},retry(){retry++;}}]},h.env,{});
    assert.equal(ack,1);assert.equal(retry,0);assert.equal(h.writes(),beforeWrites);
    await db.prepare('DROP TRIGGER serial_pilot_oracle_fence_not_ready').run(); // local mock only
    await db.prepare('DROP TRIGGER serial_pilot_attested_handoff_not_ready').run(); // local mock only
    await db.prepare('DROP TRIGGER serial_pilot_oracle_revoke_not_ready').run(); // local mock only
    await db.prepare("INSERT INTO serial_pilot_oracle_fence VALUES('book',?,1,'now')").bind('f'.repeat(64)).run();
    const {readAttestedHandoffContext,advanceAttestedHeldPilot}=require('../dist/admin/serial-attested-handoff.js');
    const snapshot=await readAttestedHandoffContext(h.env,roundId,pilotId,successorId,version,()=>true);
    assert.ok(snapshot,JSON.stringify({jobs:(await db.prepare('SELECT job_id,status,attempt_count,serial_provenance_version,serial_lease_generation FROM sync_jobs WHERE job_id IN (?,?)').bind(pilotId,successorId).all()).results,epochs:(await db.prepare("SELECT epoch_id,state,target_key FROM stable_recovery_epochs WHERE epoch_id LIKE 'normal_pilot296_%'").all()).results,barriers:(await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('serial_pilot_fence_not_ready','serial_pilot_hold_not_ready','serial_job_provenance_not_ready','serial_source_provenance_not_ready','serial_pilot_oracle_fence_not_ready','serial_pilot_attested_handoff_not_ready')").all()).results}));assert.equal(snapshot.context.successorJobId,successorId);assert.equal(snapshot.context.predecessorGeneration,0);
    await db.prepare("INSERT INTO serial_pilot_oracle_revocations VALUES('book',?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind('f'.repeat(64)).run();
    assert.equal(await readAttestedHandoffContext(h.env,roundId,pilotId,successorId,version,()=>true),null);
    await db.prepare("INSERT INTO serial_pilot_oracle_fence VALUES('other-book',?,1,'now')").bind('e'.repeat(64)).run();
    const revokedRow=await db.prepare("SELECT rowid FROM serial_pilot_oracle_revocations WHERE spreadsheet_id='book'").first();
    await assert.rejects(db.prepare("INSERT OR REPLACE INTO serial_pilot_oracle_revocations(rowid,spreadsheet_id,fence_digest,fence_generation,revoked_at) VALUES(?,'other-book',?,1,'now')").bind(revokedRow.rowid,'e'.repeat(64)).run());
    assert.equal((await db.prepare("SELECT count(*) n FROM serial_pilot_oracle_revocations WHERE spreadsheet_id='book'").first()).n,1);
    await db.prepare('DROP TRIGGER serial_pilot_oracle_revoke_no_delete').run();await db.prepare('DELETE FROM serial_pilot_oracle_revocations').run();
    await db.prepare("CREATE TRIGGER serial_pilot_oracle_revoke_no_delete BEFORE DELETE ON serial_pilot_oracle_revocations BEGIN SELECT RAISE(ABORT,'oracle revocation retained'); END").run();
    const {quiescencePayload}=require('../dist/admin/serial-quiescence-attestation.js');
    const signer=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),key=new Uint8Array(await crypto.subtle.exportKey('raw',signer.publicKey));
    att={...snapshot.context,domain:'MALIPANG_SERIAL_QUIESCENCE_V1',nonce:'55555555-1111-2222-3333-444444444444',issuedAt:new Date(Date.now()-10000).toISOString(),expiresAt:new Date(Date.now()+120000).toISOString(),signature:''};
    att.signature=Buffer.from(await crypto.subtle.sign('Ed25519',signer.privateKey,quiescencePayload(att))).toString('base64url');
    if(BPRED_MODES.includes(roundMode)){await runBPredicateScenario(roundMode,{env:h.env,att,key,snapshot,advance:advanceAttestedHeldPilot,readContext:readAttestedHandoffContext,roundId,version,pilotId,successorId});return;}
    assert.equal((await advanceAttestedHeldPilot(h.env,{...att,signature:'A'.repeat(86)},key,()=>true)).outcome,'HELD');
    const expired={...att,nonce:'66666666-1111-2222-3333-444444444444',issuedAt:new Date(Date.now()-180000).toISOString(),expiresAt:new Date(Date.now()-1000).toISOString()};
    expired.signature=Buffer.from(await crypto.subtle.sign('Ed25519',signer.privateKey,quiescencePayload(expired))).toString('base64url');
    assert.equal((await advanceAttestedHeldPilot(h.env,expired,key,()=>true)).outcome,'HELD');
    assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_attested_handoffs').first()).n,0);
    const originalBatch=h.env.DB.batch;
    h.env.DB.batch=async statements=>{await db.prepare('DROP TRIGGER serial_pilot_oracle_fence_no_update').run();await db.prepare("UPDATE serial_pilot_oracle_fence SET generation=2 WHERE spreadsheet_id='book'").run();return originalBatch.call(h.env.DB,statements);};
    assert.notEqual((await advanceAttestedHeldPilot(h.env,att,key,()=>true)).outcome,'RESERVED');
    h.env.DB.batch=originalBatch;assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_attested_handoffs').first()).n,0);
    await db.prepare("UPDATE serial_pilot_oracle_fence SET generation=1 WHERE spreadsheet_id='book'").run();
    await db.prepare("CREATE TRIGGER serial_pilot_oracle_fence_no_update BEFORE UPDATE ON serial_pilot_oracle_fence BEGIN SELECT RAISE(ABORT,'oracle fence immutable'); END").run();
    fault='handoff-revoked';
    assert.notEqual((await advanceAttestedHeldPilot(h.env,att,key,()=>true)).outcome,'RESERVED');
    assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_attested_handoffs').first()).n,0);
    await db.prepare('DROP TRIGGER serial_pilot_oracle_revoke_no_delete').run();await db.prepare('DELETE FROM serial_pilot_oracle_revocations').run();
    await db.prepare("CREATE TRIGGER serial_pilot_oracle_revoke_no_delete BEFORE DELETE ON serial_pilot_oracle_revocations BEGIN SELECT RAISE(ABORT,'oracle revocation retained'); END").run();
    fault='handoff-rollback';
    assert.notEqual((await advanceAttestedHeldPilot(h.env,att,key,()=>true)).outcome,'RESERVED');
    assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_attested_handoffs').first()).n,0);
    assert.equal((await db.prepare("SELECT state FROM stable_recovery_epochs WHERE epoch_id=?").bind(snapshot.context.predecessorEpochId).first()).state,'ARMED');
    fault='handoff-lost';
    const advanced=await advanceAttestedHeldPilot(h.env,att,key,()=>true);
    assert.equal(advanced.outcome,'RESERVATION_RECORDED',JSON.stringify(advanced));
    fault='';
    assert.equal((await advanceAttestedHeldPilot(h.env,att,key,()=>true)).outcome,'RESERVATION_RECORDED');
    assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_attested_handoffs').first()).n,1);
    if(String(roundMode).startsWith('classification-notstarted')){
     // Synthetic completion shape only: remove and restore the claim-delete guard in this isolated D1 fixture.
     await db.prepare('DROP TRIGGER serial_classification_not_ready').run();
     const guard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_continuation_claim_delete'").first();
     await db.prepare('DROP TRIGGER serial_continuation_claim_delete').run();await db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'").run();await db.prepare(guard.sql).run();
     const fields=await db.prepare(`SELECT h.round_id,h.predecessor_job_id job_id,h.successor_job_id,hold.source_namespace,h.source_revision,h.fence_digest,h.fence_generation,h.nonce,h.worker_version FROM serial_pilot_attested_handoffs h JOIN serial_pilot_hold_evidence hold ON hold.round_id=h.round_id AND hold.job_id=h.predecessor_job_id WHERE h.round_id=?`).bind(roundId).first();
     const closeGuard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='continuous_review_close_insert'").first();
     const noticeGuard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='continuous_notice_status_attempt_insert'").first();
     const fakeClose=(token,book,expense)=>db.prepare("INSERT INTO continuous_review_notice_close(operation_token,spreadsheet_id,epoch_id,expense_id,source_version,projection,journal_entity,operation_kind,notice_identity,paused_stamp,next_stamp,style_digest,state,created_at,updated_at) VALUES(?,?, 'epoch',?,1,'DAILY',?,'CONFIRM','identity','paused','next',?,'TIME_IN_FLIGHT','now','now')").bind(token,book,expense,expense,'a'.repeat(64));
     const fakeNotice=(token,book)=>db.prepare("INSERT INTO continuous_notice_status_attempts VALUES(?,?,'พร้อมแก้ไข','พร้อมแก้ไข','next',0,'now')").bind(token,book);
     // Synthetic notice rows emulate immutable prior history for another job.
     await db.batch([db.prepare('DROP TRIGGER continuous_review_close_insert'),db.prepare('DROP TRIGGER continuous_notice_status_attempt_insert'),fakeClose('other-notice','book','other-expense'),fakeNotice('other-notice','book'),db.prepare(closeGuard.sql),db.prepare(noticeGuard.sql)]);
     if(['classification-notstarted-consumer','classification-notstarted-race','classification-notstarted-100'].includes(roundMode)){
      h.env.APP_ENV='test';h.env.SERIAL_MOCK_CLASSIFICATION_ENABLED='true';
      const make=()=>new Request('https://synthetic.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'CLOSE_MOCK_PARKED',roundId,ownerSupervising:true,externalWritersFenced:true})});
      const original=h.env.DB.batch;
      if(roundMode==='classification-notstarted-race')h.env.DB.batch=async statements=>{await db.prepare("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z',serial_lease_generation=1 WHERE job_id=?").bind(waitingId).run();return original.call(h.env.DB,statements);};
      const response=await handleAdmin(make(),h.env,{}),body=await response.json();h.env.DB.batch=original;assert.equal(response.status,200,JSON.stringify(body));
      assert.deepEqual(body.results.map(x=>x.category),['PARKED','RECONCILE',roundMode==='classification-notstarted-race'?'RECONCILE':'NOT_STARTED',...extraWaiting.map(()=>'NOT_STARTED')]);
      assert.equal((await (await handleAdmin(make(),h.env,{})).json()).outcome,'CLOSED');return;
     }
     const evidence=(job,category,label,successor)=>db.prepare('INSERT INTO serial_pilot_classification_evidence VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(roundId,job,category,label,successor,fields.source_namespace,fields.source_revision,fields.fence_digest,fields.fence_generation,fields.nonce,fields.worker_version);
     await evidence(pilotId,'PARKED','MOCK_ATTESTED_HANDOFF',successorId).run();
     await evidence(waitingId,'NOT_STARTED','MOCK_NEVER_STARTED',null).run();
     await db.prepare("INSERT INTO serial_pilot_round_results VALUES(?,?,'PARKED','MOCK_ATTESTED_HANDOFF',?)").bind(roundId,pilotId,successorId).run();
     await db.prepare("INSERT INTO serial_pilot_round_results VALUES(?,?,'RECONCILE','UNVERIFIED',NULL)").bind(roundId,successorId).run();
     await db.prepare("INSERT INTO serial_pilot_round_results VALUES(?,?,'NOT_STARTED','MOCK_NEVER_STARTED',NULL)").bind(roundId,waitingId).run();
     const close=()=>db.prepare("UPDATE serial_pilot_rounds SET state='CLOSED',closed_at='later',reason='mock' WHERE round_id=?").bind(roundId);
     const waitingExpense=`exp_${namespace}_cccccccc-cccc-4ccc-8ccc-cccccccccccc`;
     for(const [token,closeBook,expense,noticeBook] of [['target-notice','book',waitingExpense,'book'],['wrong-book','other-book','other-expense','book']]){
      await assert.rejects(db.batch([db.prepare('DROP TRIGGER continuous_review_close_insert'),db.prepare('DROP TRIGGER continuous_notice_status_attempt_insert'),fakeClose(token,closeBook,expense),fakeNotice(token,noticeBook),db.prepare(closeGuard.sql),db.prepare(noticeGuard.sql),close()]),/not-started classification changed before close/);
     }
     await assert.rejects(db.batch([db.prepare('DROP TRIGGER continuous_notice_status_attempt_insert'),fakeNotice('orphan','book'),db.prepare(noticeGuard.sql),close()]),/not-started classification changed before close/);
     await assert.rejects(db.batch([db.prepare('DROP TRIGGER continuous_notice_status_attempt_insert'),close()]),/classification integrity changed before close|invalid round transition/);
     await assert.rejects(db.batch([db.prepare("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z',serial_lease_generation=1 WHERE job_id=?").bind(waitingId),close()]),/not-started classification changed before close/);
     assert.equal((await db.prepare('SELECT status FROM sync_jobs WHERE job_id=?').bind(waitingId).first()).status,'PENDING');
     await close().run();return;
    }
    if(['classification-consumer','classification-race','classification-drift'].includes(roundMode)){
     await db.prepare('DROP TRIGGER serial_classification_not_ready').run();
     h.env.APP_ENV='test';h.env.SERIAL_MOCK_CLASSIFICATION_ENABLED='false';
     const make=()=>new Request('https://synthetic.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'CLOSE_MOCK_PARKED',roundId,ownerSupervising:true,externalWritersFenced:true})});
     assert.equal((await handleAdmin(make(),h.env,{})).status,409);
     assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_classification_evidence').first()).n,0);
     h.env.SERIAL_MOCK_CLASSIFICATION_ENABLED='true';h.env.APP_ENV='production';assert.equal((await handleAdmin(make(),h.env,{})).status,409);h.env.APP_ENV='test';
     if(roundMode==='classification-drift'){
      const original=h.env.DB.batch;h.env.DB.batch=async statements=>{const result=await original.call(h.env.DB,statements);h.env.SERIAL_MOCK_CLASSIFICATION_ENABLED='false';return result;};
      const response=await handleAdmin(make(),h.env,{}),body=await response.json();h.env.DB.batch=original;
      assert.equal(response.status,409);assert.equal(body.outcome,'UNCERTAIN');
      assert.equal((await db.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').bind(roundId).first()).state,'CLOSED');
      h.env.SERIAL_MOCK_CLASSIFICATION_ENABLED='true';assert.equal((await (await handleAdmin(make(),h.env,{})).json()).outcome,'CLOSED');
      assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_classification_evidence').first()).n,1);return;
     }
     if(roundMode==='classification-race'){
      const responses=await Promise.all([handleAdmin(make(),h.env,{}),handleAdmin(make(),h.env,{})]);
      assert.ok(responses.some(x=>x.status===200));assert.ok(responses.every(x=>x.status===200||x.status===409));
      assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_classification_evidence').first()).n,1);
      assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_round_results WHERE round_id=?').bind(roundId).first()).n,2);
      assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_attested_handoffs').first()).n,1);return;
     }
     const original=h.env.DB.batch;let once=true;h.env.DB.batch=async statements=>{const result=await original.call(h.env.DB,statements);if(once){once=false;throw Error('synthetic close ACK lost');}return result;};
     const response=await handleAdmin(make(),h.env,{}),body=await response.json();h.env.DB.batch=original;
     assert.equal(response.status,200,JSON.stringify(body));assert.equal(body.outcome,'CLOSED');assert.deepEqual(body.results.map(x=>x.category),['PARKED','RECONCILE']);
     const again=await (await handleAdmin(make(),h.env,{})).json();assert.equal(again.outcome,'CLOSED');
     assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_attested_handoffs').first()).n,1);
     // Synthetic corrupted D1 lineage: bypass trusted DDL to test historical readback.
     await db.prepare('DROP TRIGGER serial_pilot_fence_reservation').run();await db.prepare('DROP TRIGGER serial_pilot_snapshot_audit').run();
     const fakeBefore=JSON.stringify({book:'book',predecessorJobId:'90000000-1111-2222-3333-444444444444',proof:'a'.repeat(64)}),fakeAfter=JSON.stringify({roundId,epoch:'normal_pilot296_fake',version});
     await db.prepare("INSERT INTO admin_audit VALUES(?,?,?,?,?,?,?)").bind('issue296:serial:90000000-1111-2222-3333-444444444444','ISSUE296_SERIAL_EXPENSE_HANDOVER',successorId,inspect.fingerprint,fakeBefore,fakeAfter,'now').run();
     const corrupt=await handleAdmin(make(),h.env,{});assert.equal(corrupt.status,409);assert.equal((await corrupt.json()).outcome,'HELD');return;
    }
    if(roundMode==='classification-test'){
     // Local-only fixture: oracle and fence are synthetic; do not activate these barriers elsewhere.
     await db.prepare('DROP TRIGGER serial_classification_not_ready').run();
     const fields=await db.prepare(`SELECT h.round_id,h.predecessor_job_id job_id,h.successor_job_id,hold.source_namespace,h.source_revision,h.fence_digest,h.fence_generation,h.nonce,h.worker_version FROM serial_pilot_attested_handoffs h JOIN serial_pilot_hold_evidence hold ON hold.round_id=h.round_id AND hold.job_id=h.predecessor_job_id WHERE h.round_id=?`).bind(roundId).first();
     const insert=()=>db.prepare(`INSERT INTO serial_pilot_classification_evidence VALUES(?,?,'PARKED','MOCK_ATTESTED_HANDOFF',?,?,?,?,?,?,?)`).bind(fields.round_id,fields.job_id,fields.successor_job_id,fields.source_namespace,fields.source_revision,fields.fence_digest,fields.fence_generation,fields.nonce,fields.worker_version);
     await insert().run();
     await db.prepare("INSERT INTO serial_pilot_round_results VALUES(?,?,'PARKED','MOCK_ATTESTED_HANDOFF',?)").bind(roundId,pilotId,successorId).run();
     await db.prepare("INSERT INTO serial_pilot_round_results VALUES(?,?,'RECONCILE','UNVERIFIED',NULL)").bind(roundId,successorId).run();
     const close=()=>db.prepare("UPDATE serial_pilot_rounds SET state='CLOSED',closed_at='later',reason='mock' WHERE round_id=?").bind(roundId);
     for(const name of ['serial_classification_parked_guard','serial_classification_not_started_guard','serial_classification_integrity_guard','serial_classification_no_replace','serial_classification_no_update','serial_classification_no_delete','serial_classification_close_parked','serial_classification_close_not_started','serial_classification_close_integrity']){
      const row=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").bind(name).first();
      await db.prepare('DROP TRIGGER '+name).run();await assert.rejects(close().run());await db.prepare(row.sql).run();
     }
     await assert.rejects(db.batch([db.prepare("INSERT INTO serial_pilot_oracle_revocations VALUES('book',?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind('f'.repeat(64)),close()]));
     assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_oracle_revocations').first()).n,0);
     await assert.rejects(db.batch([db.prepare('UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1'),close()]),/parked classification changed before close/);
     await assert.rejects(db.batch([db.prepare("UPDATE sync_jobs SET status='FAILED' WHERE job_id=?").bind(pilotId),close()]),/parked classification changed before close/);
     await close().run();assert.equal((await db.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').bind(roundId).first()).state,'CLOSED');
     return;
    }
    }
    h.env.SERIAL_ATTESTED_HANDOFF_ENABLED='true';
    if(['worker-mock','worker-fault-scope','worker-fault-ack','worker-fault-race','worker-fault-postlost','worker-fault-raw-lost','worker-fault-detail-lost','worker-fault-budget','worker-fault-atomic','worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-barrier','worker-fault-final-ready-lost','worker-fault-final-ready-revoke','worker-fault-final-receipt-lost','worker-fault-final-complete-lost','worker-fault-final-guard-drift','worker-fault-final-scope-drift'].includes(roundMode)){
     const reserved=await db.prepare("SELECT rowid,operation_token,phase FROM stable_workbook_claims WHERE spreadsheet_id='book'").first();
     assert.equal(reserved.phase,'PILOT_RESERVED');
     assert.equal(await realStableClaimOwned({...h.env,SERIAL_ATTESTED_HANDOFF_ENABLED:'false',SERIAL_MOCK_CONTINUATION_ENABLED:'false',APP_ENV:'production'},reserved.operation_token),false,'reserved attested claim cannot fall back after restart');
     await assert.rejects(()=>db.prepare("UPDATE stable_workbook_claims SET phase='OPERATION' WHERE spreadsheet_id='book'").run());
     await assert.rejects(()=>db.prepare("UPDATE stable_workbook_claims SET phase=NULL WHERE spreadsheet_id='book'").run());
     await assert.rejects(()=>db.prepare("UPDATE stable_workbook_claims SET spreadsheet_id=NULL WHERE spreadsheet_id='book'").run());
     await assert.rejects(()=>db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'").run());
     await assert.rejects(()=>db.prepare("INSERT OR REPLACE INTO stable_workbook_claims(rowid,spreadsheet_id,operation_token,state,created_at,updated_at) VALUES(?,'other-book','other-token','HELD','now','now')").bind(reserved.rowid).run());
     h.env.SERIAL_MOCK_CONTINUATION_ENABLED='true';
     for(const name of ['serial_pilot_notice_release_not_ready','serial_continuation_session_not_ready','serial_continuation_permit_not_ready','serial_continuation_authorization_not_ready','serial_ledger_stage_not_ready'])await db.prepare('DROP TRIGGER '+name).run();
     if(roundMode.startsWith('worker-fault-final-')){
      h.env.SERIAL_MOCK_FINAL_COMPLETION_ENABLED='true';
      if(roundMode!=='worker-fault-final-barrier')for(const name of ['serial_final_receipt_not_ready','serial_final_completion_not_ready','serial_continuation_completion_not_ready'])await db.prepare('DROP TRIGGER '+name).run();
     }
    }
    if(['hold-first','hold-expired','hold-drift','hold-revoked','hold-preexpired','release-test','release-race','ledger-test','ledger-final','ledger-final-zero','ledger-order','ledger-race','ledger-zero'].includes(roundMode)){h.env.APP_ENV='test';h.env.SERIAL_MOCK_CONTINUATION_ENABLED='true';}
    if(roundMode==='hold-preexpired'){await db.prepare('DROP TRIGGER serial_pilot_attested_handoff_no_update').run();await db.prepare("UPDATE serial_pilot_attested_handoffs SET expires_at='2000-01-01T00:00:00.000Z' WHERE nonce=?").bind(att.nonce).run();await db.prepare("CREATE TRIGGER serial_pilot_attested_handoff_no_update BEFORE UPDATE ON serial_pilot_attested_handoffs BEGIN SELECT RAISE(ABORT,'attested handoff immutable'); END").run();}
    const nextJob={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:nextExpense,entityVersion:1,traceId:'next-hold'};
    const originalFetch=globalThis.fetch,originalToken=googleAuth.getGoogleAccessToken,model=client.batchUpdateSpreadsheetWithReply;
    const originalCoverage=coverage.readLegacyDailyCoverage,originalBegin=notice.beginStableNotice,originalEnd=notice.endStableNotice,originalPaused=notice.stableNoticePaused,originalReadPaused=notice.readStablePausedNotice,originalOwned=claimApi.stableWorkbookClaimOwned;
    if(['worker-mock','worker-fault-scope','worker-fault-ack','worker-fault-race','worker-fault-postlost','worker-fault-raw-lost','worker-fault-detail-lost','worker-fault-budget','worker-fault-atomic','worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-barrier','worker-fault-final-ready-lost','worker-fault-final-ready-revoke','worker-fault-final-receipt-lost','worker-fault-final-complete-lost','worker-fault-final-guard-drift','worker-fault-final-scope-drift'].includes(roundMode)){notice.stableNoticePaused=async()=>true;notice.readStablePausedNotice=async()=>({stamp:'stamp',identity:'identity'});claimApi.stableWorkbookClaimOwned=realStableClaimOwned;}
    let posts=0,acks=0,noticeEnds=0,noticeWrites=0,noticeState='PAUSED',callbackError;const queued=[];
    h.setMode('second-pilot');h.env.JOB_QUEUE.send=async(body,options)=>queued.push({body,options});
    try{
     const date=(await db.prepare('SELECT transaction_date FROM expense_events WHERE expense_id=?').bind(nextExpense).first()).transaction_date;
     coverage.readLegacyDailyCoverage=async(...args)=>{const x=await originalCoverage(...args);return {...x,coverage:{...x.coverage,year:Number(date.slice(0,4)),month:Number(date.slice(5,7))}};};
     googleAuth.getGoogleAccessToken=async()=> 'local-test-token';client.batchUpdateSpreadsheetWithReply=h.realBatchUpdate;
     globalThis.fetch=async(input,init)=>{assert.equal(String(input),'https://sheets.googleapis.com/v4/spreadsheets/book:batchUpdate');posts++;const reply=await model(h.env,JSON.parse(init.body).requests,async()=>{});
      const killAt=roundMode==='worker-fault-postlost'?1:roundMode==='worker-fault-raw-lost'?2:roundMode==='worker-fault-detail-lost'?3:0;
      if(killAt===posts&&process.env.ISSUE348_KILL_STATE_FILE){
       // Model provider has committed; persist its synthetic state before the
       // parent kills this process group without delivering the response.
       const env=Object.fromEntries(Object.entries(h.env).filter(([,value])=>typeof value==='string'));env.CF_VERSION_METADATA=h.env.CF_VERSION_METADATA;
       const fd=openSync(process.env.ISSUE348_KILL_STATE_FILE,'wx',0o600);
       try{writeFileSync(fd,JSON.stringify({job:nextJob,jobId:successorId,roundId,env,posts,formula:h.formula(),effective:h.effective(),raw:h.rawEffective(),detail:h.detailEffective()}));fsyncSync(fd);}finally{closeSync(fd);}
       process.send?.({cut:'provider-committed'});await new Promise(()=>{});
      }
      if(roundMode==='worker-fault-postlost'||roundMode==='worker-fault-raw-lost'&&posts===2||roundMode==='worker-fault-detail-lost'&&posts===3)throw Error('synthetic provider response lost after commit');if(roundMode==='hold-drift')await db.prepare('DROP TRIGGER serial_source_provenance_update_guard').run();if(roundMode==='hold-revoked')await db.prepare("INSERT INTO serial_pilot_oracle_revocations VALUES('book',?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind('f'.repeat(64)).run();if(roundMode==='hold-expired'){await db.prepare('DROP TRIGGER serial_pilot_attested_handoff_no_update').run();await db.prepare("UPDATE serial_pilot_attested_handoffs SET expires_at='2000-01-01T00:00:00.000Z' WHERE nonce=?").bind(att.nonce).run();await db.prepare("CREATE TRIGGER serial_pilot_attested_handoff_no_update BEFORE UPDATE ON serial_pilot_attested_handoffs BEGIN SELECT RAISE(ABORT,'attested handoff immutable'); END").run();}return Response.json(reply);};
     notice.beginStableNotice=async(env,token,_wait,canWrite)=>{await canWrite();await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='next',notice_identity='identity' WHERE state='HELD' AND operation_token=?").bind(token).run();noticeState='PAUSED';
      if(['worker-mock','worker-fault-scope','worker-fault-ack','worker-fault-race','worker-fault-postlost','worker-fault-raw-lost','worker-fault-detail-lost','worker-fault-budget','worker-fault-atomic','worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-barrier','worker-fault-final-ready-lost','worker-fault-final-ready-revoke','worker-fault-final-receipt-lost','worker-fault-final-complete-lost','worker-fault-final-guard-drift','worker-fault-final-scope-drift'].includes(roundMode)){
       // A restarted isolate or cloned binding has no in-memory pin. The durable
       // serial phase must deny legacy ownership even if both mock flags are off.
       const serial=await env.DB.prepare("SELECT rowid,phase FROM stable_workbook_claims WHERE operation_token=?").bind(token).first();
       assert.ok(['SERIAL_PILOT_ADOPTED','SERIAL_CONTINUATION'].includes(serial.phase));
       await assert.rejects(()=>env.DB.prepare("DELETE FROM stable_workbook_claims WHERE operation_token=?").bind(token).run());
       await assert.rejects(()=>env.DB.prepare("UPDATE stable_workbook_claims SET phase='OPERATION' WHERE operation_token=?").bind(token).run());
       await assert.rejects(()=>env.DB.prepare("INSERT OR REPLACE INTO stable_workbook_claims(rowid,spreadsheet_id,operation_token,state,created_at,updated_at) VALUES(?,'other-book','other-token','HELD','now','now')").bind(serial.rowid).run());
       await env.DB.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('other-book','other-token','HELD','now','now')").run();
       await assert.rejects(()=>env.DB.prepare("UPDATE OR REPLACE stable_workbook_claims SET operation_token=? WHERE spreadsheet_id='other-book'").bind(token).run());
       await assert.rejects(()=>env.DB.prepare("UPDATE OR REPLACE stable_workbook_claims SET rowid=? WHERE spreadsheet_id='other-book'").bind(serial.rowid).run());
       await env.DB.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='other-book'").run();
       const restarted={...env,SERIAL_ATTESTED_HANDOFF_ENABLED:'false',SERIAL_MOCK_CONTINUATION_ENABLED:'false',APP_ENV:'production'};
       assert.equal(await realStableClaimOwned(restarted,token),false,'serial claim cannot fall back after restart/flag drift');
       assert.equal(await realStableClaimOwned(env,'wrong-token'),false);
       const previous=env.SERIAL_MOCK_CONTINUATION_ENABLED;env.SERIAL_MOCK_CONTINUATION_ENABLED='false';
       try{assert.equal(await realStableClaimOwned(env,token),false,'captured flag drift must fail closed');}finally{env.SERIAL_MOCK_CONTINUATION_ENABLED=previous;}
       assert.equal(await realStableClaimOwned(env,token),true,'restored scope retains the original pin');
      }
     };
     notice.endStableNotice=async(_env,_token,_bounded,preflight)=>{try{
      noticeEnds++;const isTerminal=roundMode.startsWith('worker-fault-final-')&&(await db.prepare('SELECT status FROM sync_jobs WHERE job_id=?').bind(successorId).first())?.status==='COMPLETED';
      if(isTerminal&&roundMode==='worker-fault-final-guard-drift')await db.prepare('DROP TRIGGER serial_final_completion_guard').run();
      if(preflight)await preflight();
      // Synthetic provider model commits READY before any injected response loss.
      noticeWrites++;noticeState='READY';
      if(isTerminal&&roundMode==='worker-fault-final-ready-revoke')await db.prepare("INSERT INTO serial_pilot_oracle_revocations VALUES('book',?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind('f'.repeat(64)).run();
      if(isTerminal&&roundMode==='worker-fault-final-scope-drift')h.env.SERIAL_MOCK_FINAL_COMPLETION_ENABLED='false';
      if(isTerminal&&roundMode==='worker-fault-final-ready-lost')throw Error('SHEETS_MUTATION_OUTCOME_UNKNOWN');
      if(['release-test','release-race','ledger-test','ledger-final','ledger-final-zero','ledger-order','ledger-race','ledger-zero'].includes(roundMode)){
       const edge=await db.prepare("SELECT reason,before_json,after_json FROM admin_audit WHERE id=?").bind('issue296:serial:'+pilotId).first();
       const prior=JSON.parse(edge.before_json),after=JSON.parse(edge.after_json),ticket={token:_token,epoch:after.epoch,stamp:prior.stamp,identity:prior.identity,style:prior.style,version:after.version,revision:prior.revision,fingerprint:edge.reason,attestedMode:true};
       const {releaseAttestedNoticeDraft}=require('../dist/sheets/serial-notice-release-draft.js'),digest={postimageDigest:'a'.repeat(64),observedAt:new Date(Date.now()-1000).toISOString()};
       assert.equal(await releaseAttestedNoticeDraft(h.env,ticket,digest,()=>true),'UNVERIFIED');
       await db.prepare('DROP TRIGGER serial_pilot_notice_release_not_ready').run();
       await db.prepare('DROP TRIGGER serial_continuation_session_not_ready').run();
       await db.prepare('DROP TRIGGER serial_continuation_permit_not_ready').run();
       await db.prepare('DROP TRIGGER serial_continuation_authorization_not_ready').run();
       await db.prepare('DROP TRIGGER serial_ledger_stage_not_ready').run();
       const ddl=(await import('node:fs')).readFileSync(new URL('../migrations-draft/0074_serial_continuation_fence_draft.sql',import.meta.url),'utf8');
       await db.prepare('DROP TRIGGER serial_continuation_claim_insert').run();
       assert.equal(await releaseAttestedNoticeDraft(h.env,ticket,digest,()=>true),'UNVERIFIED');
       assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).state,'HELD');
       const claimGuard=ddl.match(/CREATE TRIGGER IF NOT EXISTS serial_continuation_claim_insert[\s\S]*? END;/);assert.ok(claimGuard);await db.prepare(claimGuard[0]).run();
       assert.equal(await releaseAttestedNoticeDraft(h.env,ticket,{...digest,observedAt:'2000-01-01T00:00:00.000Z'},()=>true),'UNVERIFIED');
       assert.equal(await releaseAttestedNoticeDraft(h.env,ticket,{...digest,observedAt:'2099-01-01T00:00:00.000Z'},()=>true),'UNVERIFIED');
       await db.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('synthetic-c-failure','malipang-jobs','c-failure',?,'{}','DEAD_LETTER_MAX_RETRIES','OPEN',1,'now','now')").bind('EXPENSE:'+nextExpense+':1').run();
       assert.equal(await releaseAttestedNoticeDraft(h.env,ticket,digest,()=>true),'UNVERIFIED');
       assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").bind(_token).first()).state,'ADMITTED');
       await db.prepare("UPDATE failed_jobs SET status='RESOLVED' WHERE id='synthetic-c-failure'").run();
       fault='release-revoked';assert.equal(await releaseAttestedNoticeDraft(h.env,ticket,digest,()=>true),'UNVERIFIED');
       assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).state,'HELD');
       assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").bind(_token).first()).state,'ADMITTED');
       await db.prepare('DROP TRIGGER serial_pilot_oracle_revoke_no_delete').run();await db.prepare('DELETE FROM serial_pilot_oracle_revocations').run();
       await db.prepare("CREATE TRIGGER serial_pilot_oracle_revoke_no_delete BEFORE DELETE ON serial_pilot_oracle_revocations BEGIN SELECT RAISE(ABORT,'oracle revocation retained'); END").run();
       fault='release-drift';assert.equal(await releaseAttestedNoticeDraft(h.env,ticket,digest,()=>true),'UNVERIFIED');
       assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).state,'HELD');
       assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").bind(_token).first()).state,'ADMITTED');
       await db.prepare("UPDATE serial_pilot_oracle_fence SET generation=1 WHERE spreadsheet_id='book'").run();
       await db.prepare("CREATE TRIGGER serial_pilot_oracle_fence_no_update BEFORE UPDATE ON serial_pilot_oracle_fence BEGIN SELECT RAISE(ABORT,'oracle fence immutable'); END").run();
       fault='release-drop-after-update';assert.equal(await releaseAttestedNoticeDraft(h.env,ticket,digest,()=>true),'UNVERIFIED');
       assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='continuous_daily_evidence_no_update'").first());
       fault='release-rollback';assert.equal(await releaseAttestedNoticeDraft(h.env,ticket,digest,()=>true),'UNVERIFIED');
       assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_notice_release_receipts').first()).n,0);
       assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").bind(_token).first()).state,'ADMITTED');
       fault='';
       if(roundMode==='release-race'){const results=await Promise.all([releaseAttestedNoticeDraft(h.env,ticket,digest,()=>true),releaseAttestedNoticeDraft(h.env,ticket,digest,()=>true)]);assert.equal(results.filter(x=>x==='RELEASED').length,1,JSON.stringify(results));assert.ok(results.every(x=>['RELEASED','RELEASE_RECORDED','UNVERIFIED'].includes(x)));}
       else{fault='release-lost';assert.equal(await releaseAttestedNoticeDraft(h.env,ticket,digest,()=>true),'RELEASE_RECORDED');fault='';}
       await assert.rejects(db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other-writer','HELD','now','now')").run());
       const continuationLease=await claimSheetSyncJob(h.env,nextJob);assert.ok(continuationLease);
       // Renewal advances lease generation without advancing the business stage.
       await db.prepare("UPDATE sync_jobs SET lease_until='2099-01-01T00:00:00.000Z',serial_lease_generation=serial_lease_generation+1 WHERE job_id=? AND lease_token=?").bind(successorId,continuationLease).run();
       const generation=(await db.prepare('SELECT serial_lease_generation n FROM sync_jobs WHERE job_id=?').bind(successorId).first()).n;
       const authorization=db.prepare("INSERT INTO serial_pilot_continuation_authorizations VALUES('stale-continuation',?,?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(after.epoch,successorId,continuationLease,generation,_token,version);
       const permit=db.prepare("INSERT INTO serial_pilot_continuation_permits VALUES('stale-continuation',?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(after.epoch,successorId,continuationLease,generation,version);
       const claim=db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','stale-continuation','HELD','now','now')");
       await assert.rejects(db.batch([authorization,permit,db.prepare("UPDATE stable_recovery_epochs SET state='REVIEW' WHERE epoch_id=?").bind(after.epoch),claim]));
       assert.equal((await db.prepare("SELECT state FROM stable_recovery_epochs WHERE epoch_id=?").bind(after.epoch).first()).state,'ARMED');
       await assert.rejects(db.batch([authorization,permit,db.prepare("UPDATE sync_jobs SET lease_until='2098-01-01T00:00:00.000Z',serial_lease_generation=serial_lease_generation+1 WHERE job_id=? AND lease_token=?").bind(successorId,continuationLease),claim]));
       assert.equal((await db.prepare('SELECT serial_lease_generation n FROM sync_jobs WHERE job_id=?').bind(successorId).first()).n,generation);
       await assert.rejects(db.batch([authorization,permit,db.prepare("SELECT json_extract('invalid','$')"),claim]));
       assert.equal((await db.prepare("SELECT count(*) n FROM serial_pilot_continuation_permits WHERE operation_token='stale-continuation'").first()).n,0);
       assert.equal((await db.prepare("SELECT count(*) n FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).n,0);
       // Separate committed auth/permit without a claim is inert after lease renewal.
       await db.batch([authorization,permit]);
       await db.prepare("UPDATE sync_jobs SET lease_until='2097-01-01T00:00:00.000Z',serial_lease_generation=serial_lease_generation+1 WHERE job_id=? AND lease_token=?").bind(successorId,continuationLease).run();
       await assert.rejects(db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','stale-continuation','HELD','now','now')").run());
       const {claimAttestedContinuationDraft,continuationFenceOwned}=require('../dist/sheets/serial-notice-release-draft.js');
       const sourceTrigger=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_source_provenance_update_guard'").first();
       await db.prepare('DROP TRIGGER serial_source_provenance_update_guard').run();
       assert.equal(await claimAttestedContinuationDraft(h.env,nextJob,continuationLease,'continuation',()=>true),'UNVERIFIED');
       assert.equal((await db.prepare("SELECT count(*) n FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).n,0);
       await db.prepare(sourceTrigger.sql).run();
       fault='permit-lost';assert.equal(await claimAttestedContinuationDraft(h.env,nextJob,continuationLease,'lost-continuation',()=>true),'UNVERIFIED');fault='';
       assert.equal((await db.prepare("SELECT operation_token FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).operation_token,'lost-continuation');
       assert.equal(await claimAttestedContinuationDraft(h.env,nextJob,continuationLease,'lost-continuation',()=>true),'UNVERIFIED');
       // Only this local fixture removes committed evidence to exercise a second path.
       await db.prepare('DROP TRIGGER serial_continuation_claim_delete').run();await db.prepare('DROP TRIGGER serial_continuation_permit_no_delete').run();await db.prepare('DROP TRIGGER serial_continuation_authorization_no_delete').run();
       await db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'").run();await db.prepare("DELETE FROM serial_pilot_continuation_permits WHERE operation_token='lost-continuation'").run();await db.prepare("DELETE FROM serial_pilot_continuation_authorizations WHERE operation_token='lost-continuation'").run();
       for(const name of ['serial_continuation_claim_delete','serial_continuation_permit_no_delete','serial_continuation_authorization_no_delete']){const match=ddl.match(new RegExp('CREATE TRIGGER IF NOT EXISTS '+name+'[\\s\\S]*? END;'));assert.ok(match);await db.prepare(match[0]).run();}
       assert.equal(await claimAttestedContinuationDraft(h.env,nextJob,continuationLease,'continuation',()=>true),'CLAIMED');
       if(['ledger-test','ledger-final','ledger-final-zero','ledger-order','ledger-race','ledger-zero','worker-mock','worker-fault-scope','worker-fault-ack','worker-fault-race','worker-fault-postlost','worker-fault-raw-lost','worker-fault-detail-lost','worker-fault-budget','worker-fault-atomic','worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-barrier','worker-fault-final-ready-lost','worker-fault-final-ready-revoke','worker-fault-final-receipt-lost','worker-fault-final-complete-lost','worker-fault-final-guard-drift','worker-fault-final-scope-drift'].includes(roundMode)){
        const {admitStableRecovery}=require('../dist/sheets/stable-recovery-admission.js');assert.equal(await admitStableRecovery(h.env,nextJob,'continuation'),true);
        const source=await readStableExpenseSource(h.env,nextJob,continuationLease,'continuation');assert.ok(source);
        const {writeCarrierLedgerUnderClaim}=require('../dist/sheets/atomic-expense-ledger-writer.js');
        await writeCarrierLedgerUnderClaim(h.env,nextJob,continuationLease,'continuation',source,'EXPENSE_RAW');
        await db.prepare("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL,last_error='STABLE_STAGE_CONTINUE' WHERE job_id=? AND lease_token=?").bind(successorId,continuationLease).run();
        const {recordAttestedLedgerStageDraft}=require('../dist/sheets/serial-notice-release-draft.js'),observation={postimageDigest:'c'.repeat(64),observedAt:new Date().toISOString()};
        await db.prepare("CREATE TRIGGER serial_ledger_stage_not_ready BEFORE INSERT ON serial_pilot_ledger_stage_receipts BEGIN SELECT RAISE(ABORT,'ledger stage receipt not ready'); END").run();
        assert.equal(await recordAttestedLedgerStageDraft(h.env,'continuation',observation,()=>true),'UNVERIFIED');
        await db.prepare('DROP TRIGGER serial_ledger_stage_not_ready').run();
        assert.equal(await recordAttestedLedgerStageDraft(h.env,'continuation',{...observation,observedAt:'2000-01-01T00:00:00.000Z'},()=>true),'UNVERIFIED');
        const rawId=h.env.CONTINUOUS_RAW_SHEET_ID;h.env.CONTINUOUS_RAW_SHEET_ID='99';assert.equal(await recordAttestedLedgerStageDraft(h.env,'continuation',observation,()=>true),'UNVERIFIED');h.env.CONTINUOUS_RAW_SHEET_ID=rawId;
        fault='ledger-lost';assert.equal(await recordAttestedLedgerStageDraft(h.env,'continuation',observation,()=>true),'RECEIPT_RECORDED');fault='';
        assert.equal(await recordAttestedLedgerStageDraft(h.env,'continuation',observation,()=>true),'RECEIPT_RECORDED');
        assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_ledger_stage_receipts').first()).n,1);
        assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).state,'HELD');
        assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token='continuation'").first()).state,'ADMITTED');
        const {releaseAttestedLedgerStageDraft}=require('../dist/sheets/serial-notice-release-draft.js');
        let previousToken='continuation',previousObservation=observation;
        // A privileged writer can forge a row in this local trust-boundary
        // test; the stage release must reject unmatched extra evidence.
        await db.prepare(`INSERT INTO serial_pilot_ledger_stage_receipts(operation_token,epoch_id,spreadsheet_id,job_id,entity_id,projection,source_version,source_digest,source_revision,sheet_id,sheet_name,before_digest,payload_digest,ledger_marker,worker_version,nonce,notice_algorithm,notice_postimage_digest,observed_at,recorded_at) SELECT 'fake-ledger-token',epoch_id,spreadsheet_id,job_id,job_id||'|fake','DETAIL',source_version,source_digest,source_revision,sheet_id,sheet_name,before_digest,payload_digest,ledger_marker,worker_version,nonce,notice_algorithm,notice_postimage_digest,observed_at,recorded_at FROM serial_pilot_ledger_stage_receipts WHERE operation_token=?`).bind(previousToken).run();
        assert.equal(await releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true),'UNVERIFIED');
        const ledgerDelete=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_ledger_stage_no_delete'").first();
        await db.prepare('DROP TRIGGER serial_ledger_stage_no_delete').run();await db.prepare("DELETE FROM serial_pilot_ledger_stage_receipts WHERE operation_token='fake-ledger-token'").run();await db.prepare(ledgerDelete.sql).run();
        assert.equal(await releaseAttestedLedgerStageDraft(h.env,'wrong-token',previousObservation,()=>true),'UNVERIFIED');
        assert.equal(await releaseAttestedLedgerStageDraft(h.env,previousToken,{...previousObservation,postimageDigest:'0'.repeat(64)},()=>true),'UNVERIFIED');
        const revBefore=(await db.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').first()).revision;
        await db.prepare('UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1').run();
        assert.equal(await releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true),'UNVERIFIED');
        const monotonicTrigger=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='stable_source_revision_monotonic'").first();
        await db.prepare('DROP TRIGGER stable_source_revision_monotonic').run();await db.prepare('UPDATE stable_source_revision SET revision=? WHERE singleton=1').bind(revBefore).run();await db.prepare(monotonicTrigger.sql).run();
        const ledgerUpdate=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='continuous_ledger_evidence_no_update'").first();
        const ledgerMarker=(await db.prepare("SELECT marker FROM continuous_ledger_write_evidence WHERE operation_token=?").bind(previousToken).first()).marker;
        await db.prepare('DROP TRIGGER continuous_ledger_evidence_no_update').run();await db.prepare("UPDATE continuous_ledger_write_evidence SET marker=? WHERE operation_token=?").bind('LWC_'+(ledgerMarker==='LWC_'+'0'.repeat(32)?'1':'0').repeat(32),previousToken).run();
        assert.equal(await releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true),'UNVERIFIED');
        await db.prepare("UPDATE continuous_ledger_write_evidence SET marker=? WHERE operation_token=?").bind(ledgerMarker,previousToken).run();await db.prepare(ledgerUpdate.sql).run();
        const deleteGuard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_continuation_claim_delete'").first();
        await db.prepare('DROP TRIGGER serial_continuation_claim_delete').run();assert.equal(await releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true),'UNVERIFIED');await db.prepare(deleteGuard.sql).run();
        assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).state,'HELD');
        assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").bind(previousToken).first()).state,'ADMITTED');
        fault='ledger-release-revoked';assert.equal(await releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true),'UNVERIFIED');fault='';
        assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).state,'HELD');
        assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").bind(previousToken).first()).state,'ADMITTED');
        await db.prepare('DROP TRIGGER serial_pilot_oracle_revoke_no_delete').run();await db.prepare('DELETE FROM serial_pilot_oracle_revocations').run();
        await db.prepare("CREATE TRIGGER serial_pilot_oracle_revoke_no_delete BEFORE DELETE ON serial_pilot_oracle_revocations BEGIN SELECT RAISE(ABORT,'oracle revocation retained'); END").run();
        fault='release-rollback';assert.equal(await releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true),'UNVERIFIED');fault='';
        for(const [index,itemId] of (['ledger-zero','ledger-final-zero'].includes(roundMode)?[]:roundMode==='ledger-order'?['item_next2']:['item_next','item_next2']).entries()){
         if(index===0&&roundMode==='ledger-race'){
          const results=await Promise.all([releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true),releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true)]);
          assert.equal(results.filter(x=>x==='RELEASED').length,1,JSON.stringify(results));
         }else if(index===0){fault='release-lost';assert.equal(await releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true),'RELEASE_RECORDED');fault='';}
         else assert.equal(await releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true),'RELEASED');
         assert.equal(await releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true),'RELEASE_RECORDED');
         const detailLease=await claimSheetSyncJob(h.env,nextJob);assert.ok(detailLease);
         const detailToken='detail-token-'+index;
         assert.equal(await claimAttestedContinuationDraft(h.env,nextJob,detailLease,detailToken,()=>true),'CLAIMED');
         assert.equal(await admitStableRecovery(h.env,nextJob,detailToken),true);
         const detailSource=await readStableExpenseSource(h.env,nextJob,detailLease,detailToken);assert.ok(detailSource);
         await writeCarrierLedgerUnderClaim(h.env,nextJob,detailLease,detailToken,detailSource,'DETAIL',itemId);
         await db.prepare("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL,last_error='STABLE_STAGE_CONTINUE' WHERE job_id=? AND lease_token=?").bind(successorId,detailLease).run();
         const detailObservation={postimageDigest:(index===0?'d':'e').repeat(64),observedAt:new Date().toISOString()};
         const recorded=await recordAttestedLedgerStageDraft(h.env,detailToken,detailObservation,()=>true);
         assert.equal(recorded,roundMode==='ledger-order'?'UNVERIFIED':'RECORDED');
         if(roundMode==='ledger-order'){assert.equal((await db.prepare("SELECT count(*) n FROM serial_pilot_ledger_stage_receipts WHERE projection='DETAIL'").first()).n,0);return;}
         previousToken=detailToken;previousObservation=detailObservation;
        }
        assert.equal((await db.prepare("SELECT count(*) n FROM serial_pilot_ledger_stage_receipts WHERE projection='DETAIL'").first()).n,['ledger-zero','ledger-final-zero'].includes(roundMode)?0:2);
        assert.equal(await releaseAttestedLedgerStageDraft(h.env,previousToken,previousObservation,()=>true),'RELEASED');
        const finalLease=await claimSheetSyncJob(h.env,nextJob);assert.ok(finalLease);const finalToken='final-token-1';
        assert.equal(await claimAttestedContinuationDraft(h.env,nextJob,finalLease,finalToken,()=>true),'CLAIMED');
        assert.equal(await admitStableRecovery(h.env,nextJob,finalToken),true);
        const finalSource=await readStableExpenseSource(h.env,nextJob,finalLease,finalToken);assert.ok(finalSource);
        const journals=(await db.prepare("SELECT entity_id,projection,sheet_id,sheet_name,source_version,source_digest,state,operation_token FROM stable_projection_writes WHERE spreadsheet_id='book' AND entity_type='EXPENSE' AND (entity_id=? OR substr(entity_id,1,length(?)+1)=?||'|')").bind(nextExpense,nextExpense,nextExpense).all()).results;
        h.setMode('third-pilot');const {verifyStableExpenseProjections}=require('../dist/sheets/stable-expense-final-check.js');
        const rawRow=h.rawEffective().find(row=>row[0]===nextExpense);assert.ok(rawRow);const oldRaw=rawRow[3];rawRow[3]=999;
        await assert.rejects(verifyStableExpenseProjections(h.env,nextJob,finalSource,journals));rawRow[3]=oldRaw;
        const finalGuard=async()=>{const current=await readStableExpenseSource(h.env,nextJob,finalLease,finalToken);return !!current&&current.digest===finalSource.digest&&current.revision===finalSource.revision&&await continuationFenceOwned(h.env,finalToken,()=>true)==='OWNED';};
        const postsBeforeProof=posts;let guardCalls=0;
        await assert.rejects(verifyStableExpenseProjections(h.env,nextJob,finalSource,journals,undefined,undefined,undefined,true,async()=>++guardCalls===1&&await finalGuard()),/STABLE_FINAL_PROOF_UNVERIFIED/);
        assert.equal(guardCalls,2);assert.equal(posts,postsBeforeProof);
        const savedRawSheet=h.env.CONTINUOUS_RAW_SHEET;
        await assert.rejects(verifyStableExpenseProjections(h.env,nextJob,finalSource,journals,undefined,undefined,undefined,true,async()=>{h.env.CONTINUOUS_RAW_SHEET='changed';return true;}),/STABLE_FINAL_PROOF_UNVERIFIED/);
        h.env.CONTINUOUS_RAW_SHEET=savedRawSheet;assert.equal(posts,postsBeforeProof);
        const providerProof=await verifyStableExpenseProjections(h.env,nextJob,finalSource,journals,undefined,undefined,undefined,true,finalGuard);assert.match(providerProof.providerDigest,/^[a-f0-9]{64}$/);
        if(roundMode==='ledger-final'){
         const {consumeCapturedProjectionProof}=require('../dist/sheets/stable-expense-final-check.js');
         const bound=await verifyStableExpenseProjections(h.env,nextJob,finalSource,journals,undefined,undefined,undefined,true,finalGuard,{claim:finalToken,lease:finalLease});
         assert.equal(Object.isFrozen(bound),true);assert.equal(consumeCapturedProjectionProof({...bound},h.env,nextJob,finalToken,finalLease),false,'cloned proof has no binding');
         assert.equal(consumeCapturedProjectionProof(bound,h.env,nextJob,finalToken,finalLease),true);assert.equal(consumeCapturedProjectionProof(bound,h.env,nextJob,finalToken,finalLease),false,'proof is single use');
         for(const [changedEnv,changedJob,changedToken,changedLease] of [[h.env,nextJob,'other-token',finalLease],[h.env,nextJob,finalToken,'other-lease'],[h.env,{...nextJob,entityKey:'other-job'},finalToken,finalLease],[{...h.env,GOOGLE_SPREADSHEET_ID:'other-book'},nextJob,finalToken,finalLease],[{...h.env,DB:{}},nextJob,finalToken,finalLease]]){
          const wrong=await verifyStableExpenseProjections(h.env,nextJob,finalSource,journals,undefined,undefined,undefined,true,finalGuard,{claim:finalToken,lease:finalLease});
          assert.equal(consumeCapturedProjectionProof(wrong,changedEnv,changedJob,changedToken,changedLease),false);assert.equal(consumeCapturedProjectionProof(wrong,h.env,nextJob,finalToken,finalLease),false);
         }
        }
        // Simulate the final job transition only; actual Worker wiring remains absent.
        await db.prepare("UPDATE sync_jobs SET status='COMPLETED',lease_token=NULL,lease_until=NULL,last_error=NULL,next_attempt_at=NULL WHERE job_id=? AND lease_token=?").bind(successorId,finalLease).run();
        const {recordAttestedFinalDraft}=require('../dist/sheets/serial-notice-release-draft.js'),finalObservation={providerDigest:providerProof.providerDigest,providerObservedAt:providerProof.providerObservedAt,noticeDigest:'2'.repeat(64),noticeObservedAt:new Date().toISOString()};
        assert.equal(await recordAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED');
        await db.prepare('DROP TRIGGER serial_final_receipt_not_ready').run();
        if(['ledger-final','ledger-final-zero'].includes(roundMode)){
         const {preflightAttestedFinalDraft}=require('../dist/sheets/serial-notice-release-draft.js');
         assert.equal(await preflightAttestedFinalDraft(h.env,finalToken,providerProof,()=>true),false,'completion barriers prevent READY preflight');
         const names=['serial_final_completion_not_ready','serial_continuation_completion_not_ready'],saved=[];
         for(const name of names){saved.push((await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").bind(name).first()).sql);await db.prepare('DROP TRIGGER '+name).run();}
         assert.equal(await preflightAttestedFinalDraft(h.env,finalToken,providerProof,()=>true),true,'valid preflight is read-only');
         assert.equal(await preflightAttestedFinalDraft(h.env,finalToken,{...providerProof,sourceRevision:providerProof.sourceRevision+1},()=>true),false,'revision mismatch');
         assert.equal(await preflightAttestedFinalDraft(h.env,finalToken,{...providerProof,sourceDigest:'f'.repeat(64)},()=>true),false,'source digest mismatch');
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_final_receipts').first()).n,0);
         assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).state,'HELD');
         for(const sql of saved)await db.prepare(sql).run();
        }
        await db.prepare(`INSERT INTO serial_pilot_ledger_stage_receipts(operation_token,epoch_id,spreadsheet_id,job_id,entity_id,projection,source_version,source_digest,source_revision,sheet_id,sheet_name,before_digest,payload_digest,ledger_marker,worker_version,nonce,notice_algorithm,notice_postimage_digest,observed_at,recorded_at) SELECT 'fake-final-extra',epoch_id,spreadsheet_id,job_id,job_id||'|fake','DETAIL',source_version,source_digest,source_revision,sheet_id,sheet_name,before_digest,payload_digest,ledger_marker,worker_version,nonce,notice_algorithm,notice_postimage_digest,observed_at,recorded_at FROM serial_pilot_ledger_stage_receipts WHERE operation_token='continuation'`).run();
        assert.equal(await recordAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED');
        const extraDelete=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_ledger_stage_no_delete'").first();await db.prepare('DROP TRIGGER serial_ledger_stage_no_delete').run();await db.prepare("DELETE FROM serial_pilot_ledger_stage_receipts WHERE operation_token='fake-final-extra'").run();await db.prepare(extraDelete.sql).run();
        assert.equal(await recordAttestedFinalDraft(h.env,'wrong-token',finalObservation,()=>true),'UNVERIFIED');
        assert.equal(await recordAttestedFinalDraft(h.env,finalToken,{...finalObservation,providerObservedAt:'2000-01-01T00:00:00.000Z'},()=>true),'UNVERIFIED');
        if(!['ledger-zero','ledger-final-zero'].includes(roundMode)){
        const detailReceipt=await db.prepare("SELECT * FROM serial_pilot_ledger_stage_receipts WHERE projection='DETAIL' AND entity_id=?").bind(nextExpense+'|item_next2').first();assert.ok(detailReceipt);
        const receiptDelete=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_ledger_stage_no_delete'").first();
        await db.prepare('DROP TRIGGER serial_ledger_stage_no_delete').run();await db.prepare("DELETE FROM serial_pilot_ledger_stage_receipts WHERE operation_token=?").bind(detailReceipt.operation_token).run();await db.prepare(receiptDelete.sql).run();
        assert.equal(await recordAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED');
        const fields=Object.keys(detailReceipt);await db.prepare('INSERT INTO serial_pilot_ledger_stage_receipts('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')').bind(...fields.map(key=>detailReceipt[key])).run();
        const receiptUpdate=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_ledger_stage_no_update'").first();
        await db.prepare('DROP TRIGGER serial_ledger_stage_no_update').run();await db.prepare("UPDATE serial_pilot_ledger_stage_receipts SET nonce='wrong-nonce' WHERE operation_token=?").bind(detailReceipt.operation_token).run();await db.prepare(receiptUpdate.sql).run();
        assert.equal(await recordAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED');
        await db.prepare('DROP TRIGGER serial_ledger_stage_no_update').run();await db.prepare('UPDATE serial_pilot_ledger_stage_receipts SET nonce=? WHERE operation_token=?').bind(detailReceipt.nonce,detailReceipt.operation_token).run();await db.prepare(receiptUpdate.sql).run();
        }
        await db.prepare("INSERT INTO serial_pilot_oracle_revocations VALUES('book',?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind('f'.repeat(64)).run();
        assert.equal(await recordAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED');
        await db.prepare('DROP TRIGGER serial_pilot_oracle_revoke_no_delete').run();await db.prepare('DELETE FROM serial_pilot_oracle_revocations').run();await db.prepare("CREATE TRIGGER serial_pilot_oracle_revoke_no_delete BEFORE DELETE ON serial_pilot_oracle_revocations BEGIN SELECT RAISE(ABORT,'oracle revocation retained'); END").run();
        const detailId=h.env.CONTINUOUS_DETAIL_SHEET_ID;h.env.CONTINUOUS_DETAIL_SHEET_ID='99';assert.equal(await recordAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED');h.env.CONTINUOUS_DETAIL_SHEET_ID=detailId;
        fault='final-lost';assert.equal(await recordAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'RECEIPT_RECORDED');fault='';
        assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_final_receipts').first()).n,1);
        assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).state,'HELD');
        assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").bind(finalToken).first()).state,'ADMITTED');
        if(['ledger-final','ledger-final-zero'].includes(roundMode)){
         const {completeAttestedFinalDraft}=require('../dist/sheets/serial-notice-release-draft.js');
         Object.assign(h.env,{APP_ENV:'test',SERIAL_MOCK_CONTINUATION_ENABLED:'true',SERIAL_MOCK_FINAL_COMPLETION_ENABLED:'true'});
         assert.equal(await completeAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED','closed barriers prevent completion');
         assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).state,'HELD');
         await db.prepare('DROP TRIGGER serial_final_completion_not_ready').run();await db.prepare('DROP TRIGGER serial_continuation_completion_not_ready').run();
         // Synthetic privileged fixture edits exercise stale proof after receipt;
         // production DDL and writers remain separately trusted/gated.
         await db.prepare(`INSERT INTO serial_pilot_ledger_stage_receipts(operation_token,epoch_id,spreadsheet_id,job_id,entity_id,projection,source_version,source_digest,source_revision,sheet_id,sheet_name,before_digest,payload_digest,ledger_marker,worker_version,nonce,notice_algorithm,notice_postimage_digest,observed_at,recorded_at) SELECT 'fake-after-final',epoch_id,spreadsheet_id,job_id,job_id||'|fake','DETAIL',source_version,source_digest,source_revision,sheet_id,sheet_name,before_digest,payload_digest,ledger_marker,worker_version,nonce,notice_algorithm,notice_postimage_digest,observed_at,recorded_at FROM serial_pilot_ledger_stage_receipts WHERE operation_token='continuation'`).run();
         assert.equal(await completeAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED','extra receipt after final observation');
         const deleteReceipt=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='serial_ledger_stage_no_delete'").first();await db.prepare('DROP TRIGGER serial_ledger_stage_no_delete').run();await db.prepare("DELETE FROM serial_pilot_ledger_stage_receipts WHERE operation_token='fake-after-final'").run();await db.prepare(deleteReceipt.sql).run();
         if(roundMode==='ledger-final'){
          const detail=await db.prepare("SELECT * FROM serial_pilot_ledger_stage_receipts WHERE projection='DETAIL' AND entity_id=?").bind(nextExpense+'|item_next').first();assert.ok(detail);
          await db.prepare('DROP TRIGGER serial_ledger_stage_no_delete').run();await db.prepare("DELETE FROM serial_pilot_ledger_stage_receipts WHERE operation_token=?").bind(detail.operation_token).run();await db.prepare(deleteReceipt.sql).run();
          assert.equal(await completeAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED','missing DETAIL receipt after final observation');
          const fields=Object.keys(detail);await db.prepare('INSERT INTO serial_pilot_ledger_stage_receipts('+fields.join(',')+') VALUES('+fields.map(()=>'?').join(',')+')').bind(...fields.map(key=>detail[key])).run();
         }
         const beforeSource=await db.prepare('SELECT description FROM expense_events WHERE expense_id=?').bind(nextExpense).first(),beforeRevision=await db.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').first();
         await db.prepare('UPDATE expense_events SET description=? WHERE expense_id=?').bind('synthetic changed source',nextExpense).run();
         assert.equal(await completeAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED','source revision drift after final observation');
         await db.prepare('UPDATE expense_events SET description=? WHERE expense_id=?').bind(beforeSource.description,nextExpense).run();
         const revisionGuard=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='stable_source_revision_monotonic'").first();await db.prepare('DROP TRIGGER stable_source_revision_monotonic').run();await db.prepare('UPDATE stable_source_revision SET revision=? WHERE singleton=1').bind(beforeRevision.revision).run();await db.prepare(revisionGuard.sql).run();
         const falseValues=[finalToken,after.epoch,'book',successorId,att.nonce,version,Number(h.env.CONTINUOUS_DAILY_SHEET_ID),h.env.CONTINUOUS_DAILY_SHEET,Number(h.env.CONTINUOUS_RAW_SHEET_ID),h.env.CONTINUOUS_RAW_SHEET,Number(h.env.CONTINUOUS_DETAIL_SHEET_ID),h.env.CONTINUOUS_DETAIL_SHEET,'f'.repeat(64),finalObservation.noticeDigest,finalObservation.providerObservedAt,finalObservation.noticeObservedAt,new Date().toISOString()];
         const directStatement=()=>db.prepare('INSERT INTO serial_pilot_final_completions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(...falseValues);
         await assert.rejects(()=>directStatement().run(),'direct forged provider digest must fail');
         falseValues[12]=finalObservation.providerDigest;
         await assert.rejects(()=>db.batch([directStatement(),db.prepare("SELECT json_extract('invalid','$')")]),/malformed JSON|JSON/i,'valid control reaches the injected rollback');
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_final_completions').first()).n,0);assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").bind(finalToken).first()).state,'ADMITTED');
         for(const index of [0,2,14,15]){const previous=falseValues[index];falseValues[index]=null;await assert.rejects(()=>directStatement().run(),'NULL identity or observation time must fail');falseValues[index]=previous;}
         for(const name of ['serial_final_completion_guard','serial_final_completion_integrity','serial_final_completion_apply','serial_final_completion_no_replace','serial_final_completion_no_update','serial_final_completion_no_delete','serial_final_release_delete','serial_continuation_claim_phase','serial_continuation_claim_delete','serial_continuation_completion_guard']){
          const saved=await db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").bind(name).first();assert.ok(saved?.sql,name);await db.prepare('DROP TRIGGER '+name).run();
          try{assert.equal(await completeAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED','missing '+name);}finally{await db.prepare(saved.sql).run();}
          assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").bind(finalToken).first()).state,'ADMITTED');assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).state,'HELD');
         }
         const faults=[
          "CREATE TRIGGER local_final_fail BEFORE UPDATE ON stable_recovery_operations WHEN NEW.operation_token='final-token-1' AND NEW.state='VERIFIED' BEGIN SELECT RAISE(ABORT,'synthetic operation failure'); END",
          "CREATE TRIGGER local_final_fail BEFORE UPDATE ON stable_recovery_epochs WHEN NEW.state='COMPLETE' BEGIN SELECT RAISE(ABORT,'synthetic epoch failure'); END",
          "CREATE TRIGGER local_final_fail BEFORE UPDATE ON stable_workbook_claims WHEN NEW.phase='SERIAL_FINAL_RELEASE' BEGIN SELECT RAISE(ABORT,'synthetic phase failure'); END",
          "CREATE TRIGGER local_final_fail BEFORE DELETE ON stable_workbook_claims WHEN OLD.phase='SERIAL_FINAL_RELEASE' BEGIN SELECT RAISE(ABORT,'synthetic delete failure'); END",
          "CREATE TRIGGER local_final_fail BEFORE INSERT ON serial_pilot_continuation_completions BEGIN SELECT RAISE(ABORT,'synthetic completion failure'); END"
         ];
         for(const sql of faults){await db.prepare(sql).run();const base=h.env.DB.prepare;let raised;
          h.env.DB.prepare=function(query){const statement=base.call(this,query);if(!query.startsWith('INSERT INTO serial_pilot_final_completions('))return statement;return{bind(...args){const bound=statement.bind(...args);return{async all(){try{return await bound.all();}catch(error){raised=error;throw error;}}};}};};
          try{assert.equal(await completeAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED');assert.match(String(raised),/synthetic (operation|epoch|phase|delete|completion) failure/);}finally{h.env.DB.prepare=base;await db.prepare('DROP TRIGGER local_final_fail').run();}
          assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").bind(finalToken).first()).state,'ADMITTED');assert.equal((await db.prepare('SELECT state FROM stable_recovery_epochs WHERE epoch_id=?').bind(after.epoch).first()).state,'ARMED');
          const claim=await db.prepare("SELECT state,phase FROM stable_workbook_claims WHERE spreadsheet_id='book'").first();assert.equal(claim.state,'HELD');assert.equal(claim.phase,'SERIAL_CONTINUATION');assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_final_completions').first()).n,0);
         }
         await db.prepare("INSERT INTO serial_pilot_oracle_revocations VALUES('book',?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind('f'.repeat(64)).run();assert.equal(await completeAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'UNVERIFIED');
         await db.prepare('DROP TRIGGER serial_pilot_oracle_revoke_no_delete').run();await db.prepare('DELETE FROM serial_pilot_oracle_revocations').run();await db.prepare("CREATE TRIGGER serial_pilot_oracle_revoke_no_delete BEFORE DELETE ON serial_pilot_oracle_revocations BEGIN SELECT RAISE(ABORT,'oracle revocation retained'); END").run();
         const basePrepare=h.env.DB.prepare;let lost=false,driverError;
         h.env.DB.prepare=function(sql){const statement=basePrepare.call(this,sql);if(!sql.startsWith('INSERT INTO serial_pilot_final_completions('))return statement;return{bind(...args){const bound=statement.bind(...args);return{async all(){let result;try{result=await bound.all();}catch(error){driverError=error;throw error;}lost=true;throw Error('synthetic final completion ACK lost');}};}};};
         try{const outcomes=await Promise.all([completeAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),completeAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true)]);assert.deepEqual(outcomes,['COMPLETION_RECORDED','COMPLETION_RECORDED'],String(driverError));}finally{h.env.DB.prepare=basePrepare;}
         assert.equal(lost,true);assert.equal((await db.prepare("SELECT state FROM stable_recovery_operations WHERE operation_token=?").bind(finalToken).first()).state,'VERIFIED');
         assert.equal((await db.prepare('SELECT state FROM stable_recovery_epochs WHERE epoch_id=?').bind(after.epoch).first()).state,'COMPLETE');
         assert.equal(await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first(),null);
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_continuation_completions').first()).n,1);
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_final_completions').first()).n,1);
         await db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','new-writer','HELD','now','now')").run();
         assert.equal(await completeAttestedFinalDraft(h.env,finalToken,finalObservation,()=>true),'COMPLETION_RECORDED');
         assert.equal((await db.prepare("SELECT operation_token FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).operation_token,'new-writer');
         return;
        }
        await db.prepare('DROP TRIGGER serial_continuation_completion_not_ready').run();
        await assert.rejects(db.prepare("INSERT INTO serial_pilot_continuation_completions VALUES(?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind(after.epoch).run());
        return;
       }
       assert.equal(await continuationFenceOwned(h.env,'continuation',()=>true),'OWNED');
       assert.equal(await continuationFenceOwned(h.env,'wrong-token',()=>true),'UNVERIFIED');
       h.env.SERIAL_ATTESTED_HANDOFF_ENABLED='false';assert.equal(await continuationFenceOwned(h.env,'continuation',()=>true),'UNVERIFIED');h.env.SERIAL_ATTESTED_HANDOFF_ENABLED='true';
       assert.equal(await claimAttestedContinuationDraft(h.env,nextJob,continuationLease,'continuation',()=>true),'UNVERIFIED');
       const protectedClaim=await db.prepare("SELECT rowid FROM stable_workbook_claims WHERE spreadsheet_id='book'").first();
       await assert.rejects(db.prepare("INSERT OR REPLACE INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('elsewhere','continuation','HELD','now','now')").run());
       await assert.rejects(db.prepare("INSERT OR REPLACE INTO stable_workbook_claims(rowid,spreadsheet_id,operation_token,state,created_at,updated_at) VALUES(?,'elsewhere','other-token','HELD','now','now')").bind(protectedClaim.rowid).run());
       await db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('elsewhere','other-token','HELD','now','now')").run();
       await assert.rejects(db.prepare("UPDATE OR REPLACE stable_workbook_claims SET spreadsheet_id='book' WHERE spreadsheet_id='elsewhere'").run());
       await assert.rejects(db.prepare("UPDATE OR REPLACE stable_workbook_claims SET operation_token='continuation' WHERE spreadsheet_id='elsewhere'").run());
       await db.prepare("INSERT INTO serial_pilot_oracle_revocations VALUES('book',?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind('f'.repeat(64)).run();
       assert.equal(await continuationFenceOwned(h.env,'continuation',()=>true),'UNVERIFIED');
       await assert.rejects(db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'").run());
       assert.equal((await db.prepare("SELECT operation_token FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).operation_token,'continuation');
       // Privileged DDL bypass is synthetic: historical replay must not touch a new claim.
       await db.prepare('DROP TRIGGER serial_continuation_claim_insert').run();await db.prepare('DROP TRIGGER serial_continuation_claim_conflict').run();await db.prepare('DROP TRIGGER serial_continuation_claim_delete').run();
       await db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book'").run();
       await db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other-writer','HELD','now','now')").run();
       assert.equal(await releaseAttestedNoticeDraft(h.env,ticket,digest,()=>true),'RELEASE_RECORDED');
       assert.equal((await db.prepare("SELECT operation_token FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).operation_token,'other-writer');
       await db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='book' AND operation_token='other-writer'").run();
       assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_notice_release_receipts').first()).n,1);
       await db.prepare("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL,last_error='STABLE_STAGE_CONTINUE' WHERE job_id=?").bind(successorId).run();
      }
      return {postimageDigest:'a'.repeat(64),observedAt:new Date().toISOString()};
     }catch(error){callbackError=error;throw error;}};
     if(['worker-mock','worker-fault-scope','worker-fault-ack','worker-fault-race','worker-fault-postlost','worker-fault-raw-lost','worker-fault-detail-lost','worker-fault-budget','worker-fault-atomic','worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-barrier','worker-fault-final-ready-lost','worker-fault-final-ready-revoke','worker-fault-final-receipt-lost','worker-fault-final-complete-lost','worker-fault-final-guard-drift','worker-fault-final-scope-drift'].includes(roundMode)){
      // Incompatible handoff modes fail before acquiring a claim or writing.
      const previousHandoff=h.env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED;
      h.env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED='true';
      try{await assert.rejects(()=>claimApi.withStableWorkbookClaim(h.env,async()=>{assert.fail('mixed handoff dispatched');}),/SERIAL_MOCK_HANDOFF_INCOMPATIBLE/);}finally{h.env.CONTINUOUS_NORMAL_NOTICE_HANDOFF_ENABLED=previousHandoff;}
      assert.equal(posts,0);
      if(roundMode==='worker-fault-atomic'){
       await db.prepare('CREATE TABLE local_final_ops(id TEXT PRIMARY KEY,state TEXT)').run();
       await db.prepare('CREATE TABLE local_final_epochs(id TEXT PRIMARY KEY,state TEXT)').run();
       await db.prepare('CREATE TABLE local_final_claims(id TEXT PRIMARY KEY)').run();
       await db.prepare('CREATE TABLE local_final_receipts(id TEXT PRIMARY KEY)').run();
       await db.prepare("INSERT INTO local_final_ops VALUES('item','ADMITTED')").run();await db.prepare("INSERT INTO local_final_epochs VALUES('item','ARMED')").run();await db.prepare("INSERT INTO local_final_claims VALUES('item')").run();
       await db.prepare(`CREATE TRIGGER local_final_apply AFTER INSERT ON local_final_receipts BEGIN
        UPDATE local_final_ops SET state='VERIFIED' WHERE id='item' AND state='ADMITTED';
        SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'operation missing') END;
        UPDATE local_final_epochs SET state='COMPLETE' WHERE id=NEW.id AND state='ARMED';
        SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'epoch missing') END;
        DELETE FROM local_final_claims WHERE id=NEW.id;
        SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT,'claim missing') END;
       END`).run();
       await assert.rejects(()=>db.prepare("INSERT INTO local_final_receipts VALUES('wrong') RETURNING id").all());
       assert.equal((await db.prepare('SELECT state FROM local_final_ops').first()).state,'ADMITTED');assert.equal((await db.prepare('SELECT count(*) n FROM local_final_receipts').first()).n,0);assert.equal((await db.prepare('SELECT count(*) n FROM local_final_claims').first()).n,1);
       const applied=await db.prepare("INSERT INTO local_final_receipts VALUES('item') RETURNING id").all();assert.equal(applied.success,true);assert.deepEqual(applied.results.map(x=>x.id),['item']);
       assert.equal((await db.prepare('SELECT state FROM local_final_ops').first()).state,'VERIFIED');assert.equal((await db.prepare('SELECT state FROM local_final_epochs').first()).state,'COMPLETE');assert.equal((await db.prepare('SELECT count(*) n FROM local_final_claims').first()).n,0);
       // Treat a dropped response as unknown and read the same durable result.
       assert.equal((await db.prepare("SELECT id FROM local_final_receipts WHERE id='item'").first()).id,'item');assert.equal(posts,0);return;
      }
      if(roundMode==='worker-fault-budget'){
       await db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,created_at,updated_at) VALUES('quota-book','quota-token','HELD','stamp','identity','now','now')").run();
       let reads=0;const sourceDb=h.env.DB,countedDb={prepare(sql){if(sql.startsWith('SELECT'))reads++;return sourceDb.prepare(sql);},batch(statements){return sourceDb.batch(statements);}};
       const legacy={...h.env,DB:countedDb,GOOGLE_SPREADSHEET_ID:'quota-book',SERIAL_ATTESTED_HANDOFF_ENABLED:'false',SERIAL_MOCK_CONTINUATION_ENABLED:'false'};
       const began=performance.now();for(let i=0;i<5;i++)assert.equal(await realStableClaimOwned(legacy,'quota-token'),true);
       const elapsed=performance.now()-began;assert.equal(reads,5,'one D1 SELECT per unpinned ownership after notice read');
       console.log('local D1 legacy ownership probe',{checks:5,selects:reads,elapsedMs:Math.round(elapsed)});
       await db.prepare("DELETE FROM stable_workbook_claims WHERE spreadsheet_id='quota-book'").run();assert.equal(posts,0);return;
      }
      if(['worker-fault-scope','worker-fault-ack'].includes(roundMode)){
       const basePrepare=h.env.DB.prepare;let injected=false;
       h.env.DB.prepare=function(sql){const statement=basePrepare.call(this,sql),target=roundMode==='worker-fault-scope'?sql.startsWith("SELECT json_extract(a.after_json,'$.token') token"):sql.startsWith("UPDATE stable_workbook_claims SET phase='PILOT_TAKEN'");if(!target)return statement;return{bind(...args){const bound=statement.bind(...args);return{async all(){const result=await bound.all();injected=true;if(roundMode==='worker-fault-scope'){h.env.SERIAL_MOCK_CONTINUATION_ENABLED='false';return result;}throw Error('synthetic take ACK lost');}};}};};
       try{await worker.queue({queue:'malipang-jobs',messages:[{body:nextJob,attempts:1,ack(){acks++;},retry(){}}]},h.env,{});}finally{h.env.DB.prepare=basePrepare;h.env.SERIAL_MOCK_CONTINUATION_ENABLED='true';}
       assert.equal(injected,true);assert.equal(posts,0,'uncertain take must not write provider');
       const claim=await db.prepare("SELECT state,phase FROM stable_workbook_claims WHERE spreadsheet_id='book'").first();assert.equal(claim.state,'HELD');assert.equal(claim.phase,roundMode==='worker-fault-scope'?'PILOT_RESERVED':'PILOT_TAKEN');
       assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_continuation_sessions').first()).n,0);
       await worker.queue({queue:'malipang-jobs',messages:[{body:nextJob,attempts:1,ack(){},retry(){}}]},h.env,{});assert.equal(posts,0,'stale delivery must not repeat provider work');
       return;
      }
      if(roundMode==='worker-fault-postlost'){
       await worker.queue({queue:'malipang-jobs',messages:[{body:nextJob,attempts:1,ack(){acks++;},retry(){}}]},h.env,{});
       assert.equal(posts,1);const claim=await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first();assert.ok(['HELD','REVIEW'].includes(claim?.state));
       const intent=await db.prepare("SELECT state FROM stable_projection_writes WHERE spreadsheet_id='book' AND entity_id=? AND projection='DAILY'").bind(nextExpense).first();assert.ok(['IN_FLIGHT','REVIEW'].includes(intent?.state));
       assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_continuation_sessions').first()).n,0);
       await worker.queue({queue:'malipang-jobs',messages:[{body:nextJob,attempts:1,ack(){},retry(){}}]},h.env,{});assert.equal(posts,1,'unknown provider outcome must not be resent');return;
      }
      if(['worker-fault-raw-lost','worker-fault-detail-lost'].includes(roundMode)){
       const realNow=Date.now,target=roundMode==='worker-fault-raw-lost'?2:3;let step=0;
       try{
        for(;step<target;step++){
         Date.now=()=>realNow()+step*90000;const body=step===0?nextJob:queued.shift()?.body;assert.ok(body,'missing staged delivery');
         await worker.queue({queue:'malipang-jobs',messages:[{body,attempts:1,ack(){acks++;},retry(){}}]},h.env,{});
         if(step===0)h.setMode('third-pilot');
        }
        assert.equal(posts,target);const claim=await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first();assert.ok(['HELD','REVIEW'].includes(claim?.state));
        const projection=target===2?'EXPENSE_RAW':'DETAIL',entity=target===2?nextExpense:nextExpense+'|item_next';
        const intent=await db.prepare("SELECT state FROM stable_projection_writes WHERE spreadsheet_id='book' AND entity_id=? AND projection=?").bind(entity,projection).first();assert.ok(['IN_FLIGHT','REVIEW'].includes(intent?.state));
        assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_continuation_sessions').first()).n,1);
        assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_ledger_stage_receipts').first()).n,target-2);
        await worker.queue({queue:'malipang-jobs',messages:[{body:nextJob,attempts:1,ack(){},retry(){}}]},h.env,{});assert.equal(posts,target,'unknown provider outcome must not be resent');
       }finally{Date.now=realNow;}
       return;
      }
      if(roundMode==='worker-fault-race'){
       const realNow=Date.now;let step=0;
       const compete=async(one,two)=>{
        let began,release;const started=new Promise(resolve=>{began=resolve;}),gate=new Promise(resolve=>{release=resolve;}),normalFetch=globalThis.fetch;
        globalThis.fetch=async(...args)=>{began();await gate;return normalFetch(...args);};
        try{
         const first=worker.queue({queue:'malipang-jobs',messages:[{body:one,attempts:1,ack(){acks++;},retry(){}}]},h.env,{});
         await Promise.race([started,first.then(()=>{throw Error('first delivery ended before provider dispatch');})]);
         try{await worker.queue({queue:'malipang-jobs',messages:[{body:two,attempts:1,ack(){acks++;},retry(){}}]},h.env,{});}finally{release();}
         await first;
        }finally{globalThis.fetch=normalFetch;}
        if(callbackError)throw callbackError;
       };
       try{
        for(const stage of ['DAILY','RAW','DETAIL1','DETAIL2']){
         Date.now=()=>realNow()+step*90000;
         const messages=stage==='DAILY'?[nextJob,nextJob]:queued.splice(0).map(x=>x.body);
         assert.ok(messages.length>=1&&messages.length<=2,stage+' queue length');
         assert.ok(messages.every(x=>x.entityKey===nextJob.entityKey&&x.entityVersion===nextJob.entityVersion));
         await compete(messages[0],messages[1]??messages[0]);
         assert.equal(posts,step+1,stage+' must have only one provider POST');
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_attested_handoffs').first()).n,1);
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_notice_release_receipts').first()).n,1);
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_ledger_stage_receipts').first()).n,step);
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_continuation_sessions').first()).n,1);
         if(stage==='DAILY')h.setMode('third-pilot');step++;
        }
        Date.now=()=>realNow()+step*90000;const finalMessages=queued.splice(0).map(x=>x.body);
        assert.ok(finalMessages.length>=1&&finalMessages.length<=2);
        const endsBeforeFinal=noticeEnds;
        await Promise.all([finalMessages[0],finalMessages[1]??finalMessages[0]].map(body=>worker.queue({queue:'malipang-jobs',messages:[{body,attempts:1,ack(){acks++;},retry(){}}]},h.env,{})));
        assert.equal(posts,4,'duplicate FINAL must not send provider POST');assert.equal(noticeEnds,endsBeforeFinal,'FINAL must not send READY');
        const claim=await db.prepare("SELECT state,review_reason FROM stable_workbook_claims WHERE spreadsheet_id='book'").first();assert.equal(claim?.state,'REVIEW');assert.equal(claim.review_reason,'SERIAL_FINAL_COMPLETION_NOT_READY');
        assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_final_receipts').first()).n,0);
        assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_continuation_completions').first()).n,0);
       }finally{Date.now=realNow;}
       return;
      }
      const realNow=Date.now;let step=0;
      try{
       Date.now=()=>realNow()+step*90000;
       for(const stage of ['DAILY','RAW','DETAIL1','DETAIL2']){
        const body=stage==='DAILY'?nextJob:queued.shift()?.body;assert.ok(body,stage+' missing continuation');
        await worker.queue({queue:'malipang-jobs',messages:[{body,attempts:1,ack(){acks++;},retry(){assert.fail('unexpected '+stage+' retry');}}]},h.env,{});
        if(callbackError)throw callbackError;
        const state=await db.prepare('SELECT status,last_error FROM sync_jobs WHERE job_id=?').bind(successorId).first();
        assert.equal(state.status,'PENDING',stage+' '+JSON.stringify(state));assert.equal(state.last_error,'STABLE_STAGE_CONTINUE');if(stage==='DAILY')h.setMode('third-pilot');step++;
       }
       assert.equal(posts,4);assert.equal(acks,4);assert.equal(queued.length,1);
       assert.equal((await db.prepare("SELECT count(*) n FROM serial_pilot_ledger_stage_receipts WHERE projection='DETAIL'").first()).n,2);
       const endsBeforeFinal=noticeEnds,writesBeforeFinal=noticeWrites,body=queued.shift().body,isFinalMode=roundMode.startsWith('worker-fault-final-');
       let completeLost=false,basePrepare;
       if(roundMode==='worker-fault-final-receipt-lost')fault='final-lost';
       if(roundMode==='worker-fault-final-complete-lost'){
        basePrepare=h.env.DB.prepare;h.env.DB.prepare=function(sql){const statement=basePrepare.call(this,sql);if(!sql.startsWith('INSERT INTO serial_pilot_final_completions('))return statement;return{bind(...args){const bound=statement.bind(...args);return{async all(){const result=await bound.all();completeLost=true;throw Error('synthetic final completion ACK lost');}};}};};
       }
       try{await worker.queue({queue:'malipang-jobs',messages:[{body,attempts:1,ack(){acks++;},retry(){}}]},h.env,{});}finally{fault='';if(basePrepare)h.env.DB.prepare=basePrepare;if(roundMode==='worker-fault-final-scope-drift')h.env.SERIAL_MOCK_FINAL_COMPLETION_ENABLED='true';}
       const held=await db.prepare("SELECT state,review_reason FROM stable_workbook_claims WHERE spreadsheet_id='book'").first();
       const completed=['worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-complete-lost'].includes(roundMode);
       if(completed){assert.equal(held,null);assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_continuation_completions').first()).n,1);assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_final_receipts').first()).n,1);assert.equal(noticeEnds,endsBeforeFinal+1);assert.equal(noticeWrites,writesBeforeFinal+1);assert.equal(noticeState,'READY');if(roundMode==='worker-fault-final-complete-lost')assert.equal(completeLost,true);}
       else{
        assert.equal(held?.state,'REVIEW');assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_continuation_completions').first()).n,0);
        if(!isFinalMode||roundMode==='worker-fault-final-barrier'){assert.equal(noticeEnds,endsBeforeFinal,'FINAL must not send READY when unavailable');assert.equal(noticeWrites,writesBeforeFinal);assert.equal(noticeState,'PAUSED');assert.equal(held.review_reason,'SERIAL_FINAL_COMPLETION_NOT_READY');}
        else if(roundMode==='worker-fault-final-guard-drift'){assert.equal(noticeEnds,endsBeforeFinal+1);assert.equal(noticeWrites,writesBeforeFinal,'drift before callback must not send READY');assert.equal(noticeState,'PAUSED');}
        else{assert.equal(noticeEnds,endsBeforeFinal+1);assert.equal(noticeWrites,writesBeforeFinal+1);assert.equal(noticeState,'READY','READY may already be visible while claim stays REVIEW');}
        assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_final_receipts').first()).n,roundMode==='worker-fault-final-receipt-lost'?1:0);
       }
       if(['worker-fault-final-success','worker-fault-final-four','worker-fault-final-runner','worker-fault-final-whole'].includes(roundMode)){
        const serial=require('../dist/admin/serial-expense-handover.js'),readback=require('../dist/admin/normal-pilot-readback.js');
        const identity={jobId:successorId,fingerprint:inspect.fingerprint,roundId},status=await serial.finishStatus(h.env,identity,version);
        assert.equal(status.outcome,'JOB_COMPLETE',JSON.stringify(status));
        // The provider readback is modeled here and covered separately.
        if(!whole){
         const original=readback.verifyNormalPilotRow;readback.verifyNormalPilotRow=async()=>true;
         try{assert.equal((await serial.recordVerifiedPilot(h.env,{...identity,action:'RECORD_VERIFIED',proof:status.proof,ownerSupervising:true,externalWritersFenced:true},version,()=>true)).outcome,'RECORDED');}finally{readback.verifyNormalPilotRow=original;}
        }
        await db.prepare('DROP TRIGGER serial_classification_not_ready').run();await db.prepare('DROP TRIGGER serial_pilot_verified_close_not_ready').run();h.env.SERIAL_MOCK_CLASSIFICATION_ENABLED='true';
        if(whole){
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_verified_evidence WHERE round_id=?').bind(roundId).first()).n,0,'runner must create the first verified receipt');
         wholeFinish(true);const result=await bounded(wholeRunner,'CLOSE');wholeRestoreRead();assert.equal(result.outcome,'PILOT_MOCK_ROUND_RECORDED');assert.deepEqual(result.jobs.map(x=>x.category),['PARKED','VERIFIED']);
         const receipts=(await db.prepare('SELECT job_id,worker_version,proof,proof_algorithm FROM serial_pilot_verified_evidence WHERE round_id=?').bind(roundId).all()).results;
         assert.deepEqual(receipts,[{job_id:successorId,worker_version:version,proof:status.proof,proof_algorithm:'pilot-finish-v2'}],'runner records the exact C proof once');
         const ordered=['OPEN_INITIAL','HANDOVER_ONE','HOLD_RESERVED','MOCK_PREPARE','MOCK_RESERVE','MOCK_INSPECT','FINISH_STATUS','READBACK','RECORD_VERIFIED','CLOSE_MOCK_PARKED'];
         let previous=-1;for(const name of ordered){const at=wholeActions.indexOf(name);assert.ok(at>previous,`${name} order: ${wholeActions.join(',')}`);previous=at;}
         for(const name of ['OPEN_INITIAL','HANDOVER_ONE','HOLD_RESERVED','MOCK_PREPARE','MOCK_RESERVE','MOCK_INSPECT','RECORD_VERIFIED','CLOSE_MOCK_PARKED'])assert.equal(wholeActions.filter(x=>x===name).length,1,name);
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_hold_evidence WHERE round_id=? AND job_id=?').bind(roundId,pilotId).first()).n,1);
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_attested_handoffs WHERE round_id=? AND predecessor_job_id=? AND successor_job_id=?').bind(roundId,pilotId,successorId).first()).n,1);
         assert.equal((await db.prepare("SELECT count(*) n FROM admin_audit WHERE action='ISSUE296_SERIAL_EXPENSE_HANDOVER' AND json_extract(after_json,'$.roundId')=?").bind(roundId).first()).n,1);
         assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_round_results WHERE round_id=?').bind(roundId).first()).n,2);
         return;
        }
        if(roundMode==='worker-fault-final-runner'){
         const {runNormalPilot}=await import('../scripts/prod-normal-queue-pilot.mjs'),sha='a'.repeat(40),{createHash}=await import('node:crypto');
         const runner={GITHUB_SHA:sha,EXPECTED_SHA:sha,GITHUB_REF:'refs/heads/main',GITHUB_RUN_ATTEMPT:'1',PILOT_PHASE:'RUN_SERIAL',PILOT_ROUND_MODE:'true',PILOT_LOCAL_IDENTITY:'true',PILOT_LOCAL_MOCK:'true',EXPECTED_WORKER_VERSION_SHA256:createHash('sha256').update(version).digest('hex'),CLOUDFLARE_API_TOKEN:'local',CLOUDFLARE_ACCOUNT_ID:'local',MALIPANG_ADMIN_TOKEN:secret,MALIPANG_WORKER_URL:'https://localhost/',BACKUP_RUN_ID:'123',GITHUB_TOKEN:'local',EXTERNAL_WRITERS_FENCED:'true',OWNER_SUPERVISING:'true'};
         let lost=true;const actions=[];
         const fetcher=async(input,opts={})=>{const url=String(input);
          if(url.includes('/deployments?'))return Response.json({success:true,result:{deployments:[{versions:[{version_id:version,percentage:100}]}]}});
          if(url.includes('/d1/database/')){const {sql}=JSON.parse(opts.body);assert.match(sql,/^SELECT /);const rows=await db.prepare(sql).all();return Response.json({success:true,result:[{success:true,results:rows.results}]});}
          if(url.includes('/actions/runs/')){const job={name:'ops',id:1234,status:'completed',conclusion:'success',steps:[{name:'Backup and migration rehearsal',conclusion:'success'}]};return Response.json(url.includes('/jobs?')?{jobs:[job]}:{path:'.github/workflows/prod-ops-readonly.yml',event:'workflow_dispatch',status:'completed',conclusion:'success',head_sha:sha,created_at:new Date().toISOString()});}
          if(url.endsWith('/jobs/1234/logs'))return new Response(null,{status:302,headers:{location:'https://log.invalid/download'}});
          if(url==='https://log.invalid/download')return new Response(['export','backup_upload','backup_checksum','restore','integrity_before','foreign_keys_before','preexisting_rows_unchanged','integrity_after','foreign_keys_after','smoke_all'].map(k=>'- '+k+': PASS').join('\n'));
          assert.equal(new URL(url).origin,'https://localhost');const action=JSON.parse(opts.body).action;actions.push(action);
          const response=await handleAdmin(new Request(url,{method:opts.method,headers:opts.headers,body:opts.body}),h.env,{});
          if(action==='CLOSE_MOCK_PARKED'&&lost){lost=false;throw Error('synthetic close ACK lost');}return response;
         };
         const coordinator={async prepare(){assert.fail('resumed C must not prepare a new attestation');},async reserve(){assert.fail('resumed C must not reserve again');},async inspect(expected){const handoff=await db.prepare('SELECT claim_token FROM serial_pilot_attested_handoffs WHERE round_id=? AND predecessor_job_id=? AND successor_job_id=? AND nonce=? AND successor_epoch_id=? AND payload_digest=? AND worker_version=?').bind(expected.roundId,expected.predecessorJobId,expected.successorJobId,expected.nonce,expected.epochId,expected.payloadDigest,expected.workerVersion).first();return handoff?{...expected,outcome:'RESERVATION_RECORDED',claimDigest:createHash('sha256').update(handoff.claim_token).digest('hex')}:null;},async proveQuiescence(ctx){const fence=await db.prepare('SELECT nonce,fence_digest,fence_generation FROM serial_pilot_attested_handoffs WHERE round_id=? AND worker_version=?').bind(ctx.roundId,ctx.workerVersion).first();return fence?{...ctx,state:'QUIESCENT_FENCED',nonce:fence.nonce,fenceDigest:fence.fence_digest,fenceGeneration:fence.fence_generation}:null;}};
         const oldRead=readback.verifyNormalPilotRow;readback.verifyNormalPilotRow=async()=>true;
         try{await assert.rejects(runNormalPilot(runner,fetcher,async()=>{},coordinator,{claim:async()=>({state:'EXISTING',roundId})}),/PILOT_ROUND_IDENTITY_NEEDS_RECONCILIATION/);}finally{readback.verifyNormalPilotRow=oldRead;}
         assert.equal(actions.filter(x=>x==='RECORD_VERIFIED'||x==='CLOSE_MOCK_PARKED').length,0,'restart must not resend potentially in-flight transitions');assert.equal(actions.at(-1),'READ');
         assert.equal((await db.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').bind(roundId).first()).state,'OPEN');
         const recovery={...runner,PILOT_PHASE:'RECOVER_ROUND',PILOT_ROUND_ID:roundId};
         const beforeRecovery=actions.length,writesBefore=h.writes();
         await assert.rejects(runNormalPilot(recovery,fetcher),error=>{
          assert.equal(error.message,'PILOT_ROUND_TRANSITION_NEEDS_RECONCILIATION');
          assert.deepEqual(error.serialProgress.reservationChain,{jobIds:[pilotId,successorId],workerVersion:version});
          assert.equal(error.serialProgress.jobs[0].successorJobId,successorId);
          return true;
         });
         assert.deepEqual(actions.slice(beforeRecovery),['READ']);
         assert.equal(h.writes(),writesBefore);
         const mockClose={...runner,PILOT_PHASE:'CLOSE_MOCK_ROUND',PILOT_ROUND_ID:roundId};
         for(const change of [p=>({...p,nonce:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'}),p=>({...p,fenceDigest:'e'.repeat(64)}),p=>({...p,fenceGeneration:p.fenceGeneration+1})]){
          const wrong={...coordinator,proveQuiescence:async ctx=>change(await coordinator.proveQuiescence(ctx))};
          await assert.rejects(runNormalPilot(mockClose,fetcher,async()=>{},wrong),/PILOT_MOCK_QUIESCENCE_REQUIRED/);
          assert.equal(actions.filter(x=>x==='CLOSE_MOCK_PARKED').length,0,'well-formed wrong proof cannot dispatch close');
          assert.equal((await db.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').bind(roundId).first()).state,'OPEN');
         }
         // A separate mock oracle now asserts quiescence. The runner binds it
         // to D1 before a single close; the injected lost ACK is read back.
         const closed=await runNormalPilot(mockClose,fetcher,async()=>{},coordinator);
         const afterClose=actions.length;
         assert.deepEqual(await runNormalPilot(recovery,fetcher),closed);
         assert.deepEqual(actions.slice(afterClose),['READ']);
         assert.equal(h.writes(),writesBefore);
         assert.equal(closed.outcome,'PILOT_MOCK_ROUND_RECORDED');assert.deepEqual(closed.jobs.map(x=>x.category),['PARKED','VERIFIED']);
         assert.equal(actions.filter(x=>x==='RECORD_VERIFIED').length,0);assert.equal(actions.filter(x=>x==='CLOSE_MOCK_PARKED').length,1);assert.equal(actions.at(-1),'READ');
         assert.equal((await db.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').bind(roundId).first()).state,'CLOSED');
         return;
        }
        const request=()=>new Request('https://synthetic.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'CLOSE_MOCK_PARKED',roundId,ownerSupervising:true,externalWritersFenced:true})});
        if(roundMode==='worker-fault-final-four'){
         const batch=h.env.DB.batch;
         for(const mutation of [db.prepare('UPDATE stable_source_revision SET revision=revision+1 WHERE singleton=1'),db.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','competing-writer','HELD','now','now')"),db.prepare("INSERT INTO serial_pilot_oracle_revocations VALUES('book',?,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))").bind('f'.repeat(64))]){
          h.env.DB.batch=statements=>batch.call(h.env.DB,[mutation,...statements]);const denied=await handleAdmin(request(),h.env,{});assert.equal(denied.status,409);assert.equal((await denied.json()).outcome,'UNCERTAIN');
          assert.equal((await db.prepare('SELECT state FROM serial_pilot_rounds WHERE round_id=?').bind(roundId).first()).state,'OPEN');assert.equal((await db.prepare('SELECT count(*) n FROM serial_pilot_classification_evidence').first()).n,0);
         }
         h.env.DB.batch=batch;
        }
        const originalBatch=h.env.DB.batch;let lost=true;h.env.DB.batch=async statements=>{const result=await originalBatch.call(h.env.DB,statements);if(lost){lost=false;throw Error('synthetic close ACK lost');}return result;};
        const closed=await handleAdmin(request(),h.env,{}),result=await closed.json();h.env.DB.batch=originalBatch;assert.equal(closed.status,200,JSON.stringify(result));assert.deepEqual(result.results.map(x=>x.category),roundMode==='worker-fault-final-four'?['PARKED','VERIFIED','NOT_STARTED','RECONCILE']:['PARKED','VERIFIED']);
        assert.equal((await (await handleAdmin(request(),h.env,{})).json()).outcome,'CLOSED');
       }

       const beforeStale=posts,endsAfterFinal=noticeEnds;await worker.queue({queue:'malipang-jobs',messages:[{body:nextJob,attempts:1,ack(){},retry(){}}]},h.env,{});assert.equal(posts,beforeStale);assert.equal(noticeEnds,endsAfterFinal);
      }finally{Date.now=realNow;}
      return;
     }
     await worker.queue({queue:'malipang-jobs',messages:[{body:nextJob,attempts:1,ack(){acks++;},retry(){assert.fail('unexpected C retry');}}]},h.env,{});
     if(['hold-expired','hold-drift','hold-revoked'].includes(roundMode))assert.match(callbackError?.message??'',/PILOT_STAGE_UNVERIFIED/,'injected fault must reject notice readiness');
     else if(callbackError)throw callbackError;
     const state=await db.prepare("SELECT j.status,j.last_error,c.state claim_state,c.review_reason FROM sync_jobs j LEFT JOIN stable_workbook_claims c ON c.spreadsheet_id='book' WHERE j.job_id=?").bind(successorId).first();
     if(['ledger-test','ledger-final','ledger-final-zero','ledger-order','ledger-race','ledger-zero','worker-mock','worker-fault-scope','worker-fault-ack','worker-fault-race','worker-fault-postlost','worker-fault-raw-lost','worker-fault-detail-lost','worker-fault-budget','worker-fault-atomic','worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-barrier','worker-fault-final-ready-lost','worker-fault-final-ready-revoke','worker-fault-final-receipt-lost','worker-fault-final-complete-lost','worker-fault-final-guard-drift','worker-fault-final-scope-drift'].includes(roundMode)){assert.equal(state.claim_state,'HELD');assert.equal(posts,['ledger-zero','ledger-final-zero'].includes(roundMode)?2:roundMode==='ledger-order'?3:4);assert.equal(acks,1);return;}
     if(['release-test','release-race'].includes(roundMode)){assert.equal(state.claim_state,null);assert.equal(posts,1);assert.equal(acks,1);return;}
     assert.equal(state.claim_state,'REVIEW',JSON.stringify(state));
     if(roundMode==='hold-preexpired'){assert.equal(state.review_reason,'PILOT_TAKE_PREIMAGE');assert.equal(posts,0);}
     else{assert.equal(state.status,'PENDING',JSON.stringify(state));assert.equal(state.last_error,'STABLE_STAGE_CONTINUE');assert.equal(state.review_reason,['hold-expired','hold-drift','hold-revoked'].includes(roundMode)?'PILOT_STAGE_UNVERIFIED':'ATTESTED_PILOT_RELEASE_UNVERIFIED');assert.equal(posts,1);}
     assert.equal(acks,1);assert.equal(queued.length,0);
     await worker.queue({queue:'malipang-jobs',messages:[{body:nextJob,attempts:1,ack(){acks++;},retry(){}}]},h.env,{});
     assert.equal(posts,roundMode==='hold-preexpired'?0:1,'stale C delivery must not send another provider request');
     assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").first()).state,'REVIEW');
    }finally{globalThis.fetch=originalFetch;googleAuth.getGoogleAccessToken=originalToken;client.batchUpdateSpreadsheetWithReply=model;coverage.readLegacyDailyCoverage=originalCoverage;notice.beginStableNotice=originalBegin;notice.endStableNotice=originalEnd;notice.stableNoticePaused=originalPaused;notice.readStablePausedNotice=originalReadPaused;claimApi.stableWorkbookClaimOwned=originalOwned;}
   }
   assert.equal((await db.prepare("SELECT count(*) n FROM admin_audit WHERE action='ISSUE296_SERIAL_EXPENSE_HANDOVER'").first()).n,['classification-notstarted-100','classification-notstarted-race','classification-notstarted-consumer','classification-notstarted','classification-drift','classification-race','classification-consumer','classification-test','hold-first','hold-expired','hold-drift','hold-revoked','hold-preexpired','release-test','release-race','ledger-test','ledger-final','ledger-final-zero','ledger-order','ledger-race','ledger-zero','worker-mock','worker-fault-scope','worker-fault-ack','worker-fault-race','worker-fault-postlost','worker-fault-raw-lost','worker-fault-detail-lost','worker-fault-budget','worker-fault-atomic','worker-fault-final-runner','worker-fault-final-whole','worker-fault-final-four','worker-fault-final-success','worker-fault-final-barrier','worker-fault-final-ready-lost','worker-fault-final-ready-revoke','worker-fault-final-receipt-lost','worker-fault-final-complete-lost','worker-fault-final-guard-drift','worker-fault-final-scope-drift'].includes(roundMode)?1:0);
   return;
  }
  const progress=await operate({...finish,action:'FINISH_PROGRESS'});
  assert.equal(progress.outcome,'PROGRESS');assert.equal(progress.verifiedStages,0);assert.deepEqual(progress.stageProofs,[]);
  assert.deepEqual(await operate(finish),{ok:true,outcome:'IN_PROGRESS'});
  assert.deepEqual(await operate({...finish,fingerprint:'f'.repeat(64)}),{ok:false,outcome:'UNVERIFIED'});
  const otherVersion='bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.deepEqual(await operateParkedPilot({...h.env,CF_VERSION_METADATA:{id:otherVersion}},finish,otherVersion),{ok:false,outcome:'UNVERIFIED'});
  assert.equal((await operate(action)).outcome,'HELD');
  assert.equal((await operate(check)).outcome,'RESERVED');
  assert.equal((await db.prepare("SELECT count(*) n FROM stable_recovery_epochs WHERE state='ARMED'").first()).n,1);
  const pilot={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_pilot',entityVersion:1,traceId:'trace-pilot'};
  await db.prepare("UPDATE sync_jobs SET status='PROCESSING',lease_token='pilot-lease',lease_until='2099',attempt_count=1 WHERE job_id=?").bind(pilotId).run();
  assert.equal(await takePausedPilot(h.env,pilot,'wrong-lease'),null);
  const originalBegin=notice.beginStableNotice,originalEnd=notice.endStableNotice;
  let begins=0,ends=0;
  notice.beginStableNotice=async()=>{begins++;throw Error('unexpected begin notice');};
  notice.endStableNotice=async(_env,_token,_bounded,preflight)=>{if(!ends)assert.ok(preflight);if(preflight)await preflight();ends++;};
  try{
   if(finalAck==='received'){
    // Deliver through the real Worker queue entry point and production Sheets
    // HTTP client. Only the external provider and notice fixture are simulated.
    const worker=require('../dist/index.js').default;
    const originalFetch=globalThis.fetch,originalToken=googleAuth.getGoogleAccessToken,model=client.batchUpdateSpreadsheetWithReply;
    const originalCoverage=coverage.readLegacyDailyCoverage;
    h.setMode('second-pilot');let posts=0,acks=0;h.env.JOB_QUEUE.send=async(_job,options)=>{assert.equal(options.delaySeconds,90);};
    await db.prepare("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL,attempt_count=0 WHERE job_id=?").bind(pilotId).run();
    try{
     const date=(await db.prepare("SELECT transaction_date FROM expense_events WHERE expense_id='exp_pilot'").first()).transaction_date;
     coverage.readLegacyDailyCoverage=async(...args)=>{const x=await originalCoverage(...args);return {...x,coverage:{...x.coverage,year:Number(date.slice(0,4)),month:Number(date.slice(5,7))}};};
     googleAuth.getGoogleAccessToken=async()=> 'local-test-token';
     client.batchUpdateSpreadsheetWithReply=h.realBatchUpdate;
     globalThis.fetch=async(input,init)=>{
      assert.equal(String(input),'https://sheets.googleapis.com/v4/spreadsheets/book:batchUpdate');
      assert.equal(init.method,'POST');posts++;
      return Response.json(await model(h.env,JSON.parse(init.body).requests,async()=>{}));
     };
     await worker.queue({queue:'malipang-jobs',messages:[{body:pilot,attempts:1,ack(){acks++;},retry(){assert.fail('unexpected pilot retry');}}]},h.env,{});
     const state=await db.prepare("SELECT j.status,j.last_error,c.phase,c.review_reason FROM sync_jobs j LEFT JOIN stable_workbook_claims c ON c.spreadsheet_id='book' WHERE j.job_id=?").bind(pilotId).first();
     assert.equal(posts,1,JSON.stringify(state));assert.equal(acks,1,JSON.stringify(state));
     assert.equal(state.status,'PENDING');assert.equal(state.last_error,'STABLE_STAGE_CONTINUE');
     assert.equal((await operate(check)).outcome,'STAGE_VERIFIED',JSON.stringify(state));
     assert.deepEqual(await operate(finish),{ok:true,outcome:'IN_PROGRESS'});
     // Confirmed DAILY can coexist with a later hold or a terminal job failure.
     await db.prepare("UPDATE sync_jobs SET status='REVIEW' WHERE job_id=?").bind(pilotId).run();
     assert.deepEqual(await operate(finish),{ok:true,outcome:'JOB_REVIEW'});
     await db.prepare("UPDATE sync_jobs SET status='FAILED' WHERE job_id=?").bind(pilotId).run();
     assert.deepEqual(await operate(finish),{ok:true,outcome:'JOB_FAILED'});
     await db.prepare("UPDATE sync_jobs SET status='PENDING' WHERE job_id=?").bind(pilotId).run();
     const projected=h.effective().filter(r=>r[23]==='MALIPANG_EXPENSE:exp_pilot');
     assert.equal(projected.length,1);assert.equal(projected[0][3],'pilot');assert.equal(projected[0][7],1.2);
     assert.equal(begins,0);assert.equal(ends,1);
     notice.beginStableNotice=async(env,token,_wait,canWrite)=>{
      await canWrite();begins++;
      await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='next',notice_identity='identity' WHERE state='HELD' AND operation_token=?").bind(token).run();
     };
     // Move only the pacing clock. Production schedules these continuations 90s apart.
     const realNow=Date.now;let step=0;
     try{
      Date.now=()=>realNow()+step*90000;
      const closeNotice=notice.endStableNotice;
      for(const projection of ['EXPENSE_RAW','DETAIL','FINAL']){
       step++;
       if(projection==='FINAL'){
        notice.endStableNotice=async(...args)=>{
         assert.deepEqual(await operate(finish),{ok:true,outcome:'IN_PROGRESS'});
         return closeNotice(...args);
        };
       }
       await worker.queue({queue:'malipang-jobs',messages:[{body:pilot,attempts:1,ack(){acks++;},retry(){assert.fail('unexpected continuation retry');}}]},h.env,{});
       const state=await db.prepare("SELECT j.status,j.last_error,c.phase,c.review_reason FROM sync_jobs j LEFT JOIN stable_workbook_claims c ON c.spreadsheet_id='book' WHERE j.job_id=?").bind(pilotId).first();
       assert.equal(state.status,projection==='FINAL'?'COMPLETED':'PENDING',projection+' '+JSON.stringify(state));
       assert.equal(state.phase,null,JSON.stringify(state));
      }
      assert.equal((await db.prepare("SELECT count(*) n FROM stable_projection_writes WHERE state='VERIFIED' AND (entity_id='exp_pilot' OR entity_id LIKE 'exp_pilot|%')").first()).n,3);
      assert.equal((await db.prepare("SELECT count(*) n FROM stable_recovery_epochs WHERE state='COMPLETE' AND target_key='exp_pilot'").first()).n,1);
      const completed=await operate(finish);
      assert.match(completed.proof,/^[0-9a-f]{64}$/);
      assert.deepEqual(completed,{ok:true,outcome:'JOB_COMPLETE',proof:completed.proof});
      assert.deepEqual(await operate(finish),completed);
      const {handleAdmin}=require('../dist/admin/handler.js'),secret='a'.repeat(40);
      const finishRequest=new Request('https://synthetic.invalid/admin/stable-sync/normal-expense-pilot',{
       method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':version},
       body:JSON.stringify(finish)});
      const finishResponse=await handleAdmin(finishRequest,{...h.env,ADMIN_TOKEN:secret},{});
      assert.equal(finishResponse.status,200);
      assert.deepEqual(await finishResponse.json(),{...completed,servedVersion:version});
      notice.endStableNotice=closeNotice;
      await verifySerialWorkerChain({h,db,finish,completed,successorId,waitingId,version,tick:()=>++step,...(roundMode?{roundId}:{}),single:roundMode==='single',two:roundMode==='two',drift:roundMode==='drift'});
      if(roundMode)assert.equal(lostReceipt,true,'verified receipt acknowledgement was lost after D1 commit');
      if(['single','two'].includes(roundMode))assert.equal(lostClose,true,'verified close acknowledgement was lost after D1 commit');
      // Include the monotonic revision so even a change-and-revert during
      // provider readback invalidates the earlier completion observation.
      await db.prepare("UPDATE expense_events SET amount_satang=amount_satang+1 WHERE expense_id='exp_pilot'").run();
      const changed=await operate(finish);
      assert.equal(changed.outcome,'JOB_COMPLETE');assert.notEqual(changed.proof,completed.proof);
      await db.prepare("UPDATE expense_events SET amount_satang=amount_satang-1 WHERE expense_id='exp_pilot'").run();
      const reverted=await operate(finish);
      assert.equal(reverted.outcome,'JOB_COMPLETE');assert.notEqual(reverted.proof,completed.proof);
      // A terminal job alone cannot prove that all current D1 details were written.
      await db.prepare(`INSERT INTO expense_document_items(item_id,document_id,expense_id,description,created_at,updated_at)
        SELECT 'item_extra',document_id,expense_id,'missing projection',created_at,updated_at
        FROM expense_document_items WHERE expense_id='exp_pilot' LIMIT 1`).run();
      assert.deepEqual(await operate(finish),{ok:false,outcome:'UNVERIFIED'});
      assert.equal(acks,4);assert.equal(posts,['single','drift'].includes(roundMode)?3:5);
     }finally{Date.now=realNow;}

    }finally{globalThis.fetch=originalFetch;googleAuth.getGoogleAccessToken=originalToken;client.batchUpdateSpreadsheetWithReply=model;coverage.readLegacyDailyCoverage=originalCoverage;}
    assert.equal(ends,['single','drift'].includes(roundMode)?4:7);
   }else{
    notice.stableNoticeStyleFingerprint=async()=> 'b'.repeat(64);
    await assert.rejects(claimApi.withStableWorkbookClaim(h.env,async()=>{throw Error('unexpected business callback');},
     pilot,undefined,undefined,{job:pilot,lease:'pilot-lease'}),/PILOT_PAUSE_UNVERIFIED/);
    assert.equal((await db.prepare("SELECT count(*) n FROM stable_recovery_operations WHERE state='ADMITTED'").first()).n,0);
    assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims").first()).state,'REVIEW');
    assert.deepEqual(await operate(finish),{ok:true,outcome:'JOB_REVIEW'});
    assert.equal(ends,0);
   }
   assert.equal(begins,finalAck==='received'?(['single','drift'].includes(roundMode)?3:6):0);
  }finally{notice.beginStableNotice=originalBegin;notice.endStableNotice=originalEnd;}
  assert.equal((await db.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").first()).status,'REVIEW');
  assert.equal((await db.prepare("SELECT status FROM failed_jobs WHERE id='failed'").first()).status,'OPEN');
  assert.equal(h.writes(),finalAck==='received'?(['single','drift'].includes(roundMode)?4:6):1);

 }finally{wholeFinish?.(false);wholeRestoreRead?.();if(wholeIdentityDir)(await import('node:fs')).rmSync(wholeIdentityDir,{recursive:true,force:true});notice.stableNoticeStyleFingerprint=oldStyle;if(local)await local.close();h.close();}
});


test('exact daily admin settlement pins the Worker before all D1 reads',async()=>{
 const {handleAdmin}=require('../dist/admin/handler.js');
 const version='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',token='a'.repeat(40);
 const env={ADMIN_TOKEN:token,EXACT_DAILY_SETTLEMENT_ENABLED:'true',CF_VERSION_METADATA:{id:version}};
 const request=(headers,body)=>new Request('https://example.test/admin/stable-sync/exact-daily-settlement',{
  method:'POST',headers,body:JSON.stringify(body)
 });
 const body={action:'INSPECT'}, auth={authorization:'Bearer '+token};
 assert.equal((await handleAdmin(request({},body),env,{})).status,401);
 assert.equal((await handleAdmin(request(auth,body),env,{})).status,409);
 const pinned={...auth,'x-malipang-expected-worker-version':version};
 assert.equal((await handleAdmin(request(pinned,{action:'SETTLE'}),env,{})).status,400);
 const gated=await handleAdmin(request(pinned,body),env,{});
 assert.equal(gated.headers.get('cache-control'),'no-store');
 assert.deepEqual(await gated.json(),{ok:false,outcome:'HELD',stage:'CONFIG',servedVersion:version});
});

test('normal-pilot readback independently checks the D1 source and effective Google row without disclosing values',async()=>{
 const {normalExpenseEpochStatements}=require('../dist/sheets/continuous-normal-recovery.js');
 const {admitStableRecovery,verifyStableRecoveryAdmission}=require('../dist/sheets/stable-recovery-admission.js');
 const {handleAdmin}=require('../dist/admin/handler.js');
 const period=new Date(Date.now()+7*3600000).toISOString().slice(0,7);
 const sheet='รายวันต่อเนื่อง_แบบร่าง',claim='pilot-readback-operation';
 const h=await fixture(false,true,claim,false,sheet,period+'-15');
 let local;
 const token='s'.repeat(40),version='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',jobId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
 try{
  Object.assign(h.env,{SHEETS_SYNC_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',
   CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED:'false',CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED:'true',ADMIN_TOKEN:token,CF_VERSION_METADATA:{id:version}});
  h.sqlite.prepare("INSERT INTO continuous_cutover_operator(spreadsheet_id,operation_token,origin,state,created_at,updated_at) VALUES('book',?,'NEW','STARTING','now','now')").run(claim);
  h.sqlite.exec("UPDATE continuous_cutover_operator SET state='HELD';UPDATE continuous_cutover_operator SET state='RELEASING';UPDATE continuous_cutover_operator SET state='COMPLETE'; DELETE FROM stable_workbook_claims");
  h.sqlite.exec("INSERT INTO continuous_canary_operator(spreadsheet_id,expense_id,document_id,item_id,line_user_id,transaction_date,trace_id,state,created_at,updated_at) VALUES('book','exp_canary_test','doc_canary_test','item_canary_test','CANARY_NO_LINE_test','2026-11-15','trace_canary_test','DRAFT','now','now')");
  for(const state of ['CONFIRMING','CONFIRMED','ARMED_CONFIRM','DUPLICATE_ARMED','DUPLICATE_SEEN','DUPLICATE_VERIFIED','UNDOING','UNDONE','ARMED_UNDO','VERIFIED'])
   h.sqlite.prepare("UPDATE continuous_canary_operator SET state=?,duplicate_epoch_id=CASE WHEN ?='DUPLICATE_ARMED' THEN 'duplicate_epoch' ELSE duplicate_epoch_id END").run(state,state);
  h.sqlite.prepare("UPDATE sync_jobs SET job_id=?,status='PENDING',attempt_count=0,lease_until=NULL,lease_token=NULL WHERE job_id='job'").run(jobId);
  const epoch='normal_pilot296_'+crypto.randomUUID();
  const grants=await h.env.DB.batch(normalExpenseEpochStatements(h.env,epoch,new Date().toISOString(),jobId));
  assert.deepEqual(grants.map(r=>r.meta.changes),[1,1]);
  h.sqlite.prepare("UPDATE sync_jobs SET status='PROCESSING',attempt_count=1,lease_until='2099-01-01T00:00:00Z',lease_token='lease' WHERE job_id=?").run(jobId);
  h.sqlite.prepare("INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book',?,'HELD','now','now')").run(claim);
  assert.equal(await admitStableRecovery(h.env,h.job,claim),true);
  await h.run();await verifyStableRecoveryAdmission(h.env,claim);
  const link=h.sqlite.prepare("SELECT o.operation_token=projection.operation_token AND o.operation_token=m.operation_token AS matched FROM stable_recovery_operations o JOIN stable_projection_writes projection ON projection.projection='DAILY' JOIN atomic_daily_marker_reservations m ON m.entity_id=projection.entity_id").get();
  assert.equal(link.matched,1);
  local=await miniflareDailyFixture(h.sqlite);h.env.DB=local.db;

  let fault='',calls=0;
  const first=[client.batchGetSheetFormulaValues,client.batchGetSheetEffectiveSerialValues];
  const response=(base,effective)=>async(env,ranges,policy)=>{
   const fresh=ranges.length===2, grid=effective?h.effective():h.formula();
   let result=fresh?[[grid[4].slice()],grid.map(row=>[row[24]])]:structuredClone(await base(env,ranges,policy));
   if(!effective&&fault==='provider-error')throw Error('private detail');
   if(!effective&&!fresh&&fault==='extra-range')return [...result,[]];
   if(!effective&&!fresh&&fault==='missing-range')return [];
   if(!effective&&!fresh&&fault==='duplicate')result[0][5]=result[0][4].slice();
   if(!effective&&!fresh&&fault==='wrong-marker')result[0][4][24]=result[0][4][24].replace(/INSERT_[0-9a-f]{32}/,'INSERT_'+'0'.repeat(32));
   if(effective&&!fresh){
    const columns={date:2,serial:20,amount:7,description:3,category:21,wallet:22,identity:23};
    if(Object.hasOwn(columns,fault))result[0][4][columns[fault]]='synthetic private mismatch';
   }
   if(effective&&fresh&&fault==='late-edit')result[0][0][7]=999;
   if(!effective&&fresh&&fault==='late-duplicate')result[1][5]=result[1][4].slice();
   if(effective&&fresh&&fault==='late-source')await local.db.prepare("UPDATE expense_events SET amount_satang=222 WHERE expense_id='exp_test'").run();
   calls++;return result;
  };
  client.batchGetSheetFormulaValues=response(first[0],false);client.batchGetSheetEffectiveSerialValues=response(first[1],true);
  const read=async(expected,identity={})=>{
   const request=new Request('https://example.test/admin/stable-sync/normal-pilot-readback',{method:'POST',
    headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'READBACK',...identity})});
   const response=await handleAdmin(request,h.env,{});
   assert.equal(response.status,expected?200:409,fault);
   assert.deepEqual(await response.json(),{ok:expected,outcome:expected?'MATCHED':'UNVERIFIED',servedVersion:version},fault);
  };
  await read(true);assert.equal(calls,4);
  for(const [field,bad,original] of [
    ['description','changed source','=literal'],['category','other','ingredients'],['amount_satang',789,123],
    ['source_wallet','PETTY_CASH','SHOP_BANK'],['transaction_date',period+'-16',period+'-15']
  ]){
    const update=local.db.prepare("UPDATE expense_events SET "+field+"=? WHERE expense_id='exp_test'");
    await update.bind(bad).run();await read(false);await update.bind(original).run();
  }
  await read(true);
  for(fault of ['date','serial','amount','description','category','wallet','identity','wrong-marker','duplicate','missing-range','extra-range','provider-error','late-edit','late-duplicate','late-source'])await read(false);
  fault='';
  await local.db.prepare("UPDATE expense_events SET amount_satang=123 WHERE expense_id='exp_test'").run();
  const fingerprint='c'.repeat(64), identity={jobId,fingerprint};
  await read(false,identity);
  await local.db.prepare(`INSERT INTO admin_audit(id,action,entity_key,reason,before_json,after_json,created_at)
    VALUES('serial-test','ISSUE296_SERIAL_EXPENSE_HANDOVER',?,?,?,?,'now')`)
    .bind(jobId,fingerprint,JSON.stringify({book:'book'}),JSON.stringify({epoch,version})).run();
  await read(true,identity);
  const missingHistorical=await handleAdmin(new Request('https://example.test/admin/stable-sync/normal-pilot-readback',{method:'POST',headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'READ_HISTORICAL',...identity})}),h.env,{});
  assert.equal((await missingHistorical.json()).outcome,'UNVERIFIED');
  // Release schema (0067): the live readback above passed; the historical snapshot below needs serial tables.
  if(releaseSchemaOnly)return;
  // Synthetic snapshot fixture: the production trigger's provenance remains a
  // separate review gate; this test exercises historical read-only semantics.
  const roundId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',newVersion='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await local.db.prepare("INSERT INTO serial_pilot_rounds VALUES(?,NULL,1,'PREPARING','now',NULL,NULL)").bind(roundId).run();
  await local.db.prepare('INSERT INTO serial_pilot_round_items VALUES(?,0,?)').bind(roundId,jobId).run();
  await local.db.prepare('INSERT INTO serial_pilot_round_bindings VALUES(?,?,?)').bind(roundId,'book',fingerprint).run();
  await local.db.prepare("UPDATE serial_pilot_rounds SET state='OPEN' WHERE round_id=?").bind(roundId).run();
  await local.db.prepare("UPDATE admin_audit SET after_json=json_set(after_json,'$.roundId',?) WHERE id='serial-test'").bind(roundId).run();
  await local.db.prepare('DROP TRIGGER serial_pilot_snapshot_insert_guard').run();
  const revision=(await local.db.prepare('SELECT revision FROM stable_source_revision WHERE singleton=1').first()).revision;
  await local.db.prepare('INSERT INTO serial_pilot_reservation_snapshots VALUES(?,?,?,?,?,?,?,?)').bind('serial-test',roundId,jobId,epoch,'book',period+'-15',version,revision).run();
  const baseDb=h.env.DB;
  const historical=async(expected,pin)=>{
   const request=new Request('https://example.test/admin/stable-sync/normal-pilot-readback',{method:'POST',headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':pin},body:JSON.stringify({action:'READ_HISTORICAL',...identity})});
   const response=await handleAdmin(request,h.env,{});assert.equal(response.status,expected?200:409);assert.equal((await response.json()).outcome,expected?'MATCHED_READ_ONLY':'UNVERIFIED');
  };
  h.env.CF_VERSION_METADATA={id:newVersion};
  const strictNewVersion=await handleAdmin(new Request('https://example.test/admin/stable-sync/normal-pilot-readback',{method:'POST',headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':newVersion},body:JSON.stringify({action:'READBACK',...identity})}),h.env,{});
  assert.equal(strictNewVersion.status,409);await historical(true,newVersion); // version changes, month stays
  h.env.CF_VERSION_METADATA={id:version};
  const readSql=[];
  h.env.DB=new Proxy(baseDb,{get(target,key){if(key==='prepare')return sql=>{readSql.push(sql);return target.prepare(sql.replaceAll("strftime('%Y-%m','now','+7 hours')","'1900-01'"));};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  await read(false,identity); // the simulated current month really differs
  await historical(true,version); // month changes, version stays
  h.env.CF_VERSION_METADATA={id:newVersion};await historical(true,newVersion);
  fault='duplicate';await historical(false,newVersion);fault='';
  await local.db.prepare('DROP TRIGGER serial_pilot_snapshot_no_update').run(); // synthetic corruption cases only
  for(const [field,bad,original] of [['epoch_id','normal_pilot296_wrong',epoch],['spreadsheet_id','wrong-book','book'],['worker_version','ffffffff-ffff-4fff-8fff-ffffffffffff',version]]){
   await local.db.prepare('UPDATE serial_pilot_reservation_snapshots SET '+field+'=? WHERE audit_id=?').bind(bad,'serial-test').run();await historical(false,newVersion);
   await local.db.prepare('UPDATE serial_pilot_reservation_snapshots SET '+field+'=? WHERE audit_id=?').bind(original,'serial-test').run();
  }
  await local.db.prepare("UPDATE expense_events SET transaction_date=? WHERE expense_id='exp_test'").bind(period+'-16').run();await historical(false,newVersion);
  await local.db.prepare("UPDATE expense_events SET transaction_date=? WHERE expense_id='exp_test'").bind(period+'-15').run();
  assert.ok(readSql.length>0);assert.ok(readSql.every(sql=>/^\s*(SELECT|WITH)\b/i.test(sql)));
  h.env.DB=baseDb;h.env.CF_VERSION_METADATA={id:version};
  await read(false,{...identity,fingerprint:'d'.repeat(64)});
  await read(false,{...identity,jobId:version});
  await read(false); // Unqualified legacy probes never pick another reservation.
  assert.equal(h.writes(),1);
 }finally{if(local)await local.close();h.close();}
});

test('round opening pins settled A and rejects candidate drift before the atomic snapshot',async()=>{
 const {handleAdmin}=require('../dist/admin/handler.js'),h=await fixture(false,true,'claim-token-round',false,'รายวันต่อเนื่อง_แบบร่าง'),oldStyle=notice.stableNoticeStyleFingerprint;
 const version='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',pilotId='10000000-1111-2222-3333-444444444444',roundId='20000000-1111-2222-3333-444444444444',secret='s'.repeat(40);
 try{
  h.setMode('timeout');await assert.rejects(h.run(),/synthetic lost response/);
  h.sqlite.exec(`UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED',notice_stamp='stamp',notice_identity='identity',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id='book';
   UPDATE sync_jobs SET status='REVIEW',lease_token=NULL,lease_until=NULL,last_error='STABLE_SYNC_REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id='job';
   INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_round','round-msg','synthetic','round',120,'transfer','SHOP_BANK','ingredients',date('now','+7 hours'),'CONFIRMED','now',1);
   INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at) VALUES('${pilotId}','EXPENSE','exp_round',1,'round-trace','PENDING','now');`);
  h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('failed','malipang-jobs','fixture','EXPENSE:exp_test:1',?,'Error: STABLE_JOB_HOLD_UNCERTAIN','OPEN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(JSON.stringify(h.job));
  h.formula().push(Array(29).fill(null));h.effective().push(Array(29).fill(null));notice.stableNoticeStyleFingerprint=async()=> 'a'.repeat(64);
  // Emulate D1's RETURNING rows in this local SQLite fixture.
  h.DB.batch=async statements=>{h.sqlite.exec('BEGIN IMMEDIATE');try{const out=statements.map(s=>/\bRETURNING\b/i.test(s.sql)?{success:true,results:h.sqlite.prepare(s.sql).all(...s.args),meta:{changes:1}}:{...s.runSync(),success:true});h.sqlite.exec('COMMIT');return out;}catch(error){h.sqlite.exec('ROLLBACK');throw error;}};
  Object.assign(h.env,{ADMIN_TOKEN:secret,SHEETS_SYNC_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',EXACT_DAILY_SETTLEMENT_ENABLED:'true',CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED:'true',CONTINUOUS_NORMAL_EXPENSE_RECOVERY_ENABLED:'false',UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED:'false',CF_VERSION_METADATA:{id:version}});
  const inspect=await operateExactDailySettlement(h.env,{action:'INSPECT'},version);
  const probe=await operateExactDailySettlement(h.env,{action:'PROBE',fingerprint:inspect.fingerprint},version);
  const settled=await operateExactDailySettlement(h.env,{action:'SETTLE',fingerprint:inspect.fingerprint,preimageDigest:probe.preimageDigest,ownerSupervising:true,externalWritersFenced:true},version);
  assert.equal(settled.outcome,'SETTLED');
  h.sqlite.exec("DROP TRIGGER serial_pilot_fence_not_ready; INSERT INTO serial_pilot_round_fence_activation VALUES(1,'2000-01-01T00:00:00.000Z')");
  const body={action:'OPEN_INITIAL',roundId,fingerprint:inspect.fingerprint,preimageDigest:probe.preimageDigest,jobs:[pilotId],ownerSupervising:true,externalWritersFenced:true};
  const call=()=>handleAdmin(new Request('https://example.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':version},body:JSON.stringify(body)}),h.env,{});
  const empty=await handleAdmin(new Request('https://example.invalid/admin/stable-sync/serial-round-recovery',{method:'POST',headers:{authorization:'Bearer '+secret,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'OPEN_EMPTY',roundId,ownerSupervising:true,externalWritersFenced:true})}),h.env,{});
  assert.equal(empty.status,409);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM serial_pilot_rounds').get().n,0);
  const prepare=h.DB.prepare;let drift=false;
  h.DB.prepare=function(sql){const result=prepare.call(this,sql);if(sql.startsWith('SELECT CASE WHEN (SELECT json_group_array')&&!drift){drift=true;h.sqlite.prepare("UPDATE sync_jobs SET status='PROCESSING' WHERE job_id=?").run(pilotId);}return result;};
  assert.equal((await call()).status,409);assert.equal(drift,true);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM serial_pilot_rounds').get().n,0);
  h.DB.prepare=prepare;h.sqlite.prepare("UPDATE sync_jobs SET status='PENDING' WHERE job_id=?").run(pilotId);
  assert.equal((await call()).status,200);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM serial_pilot_round_items').get().n,1);
  assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE operation_token='claim-token-round'").get().state,'REVIEW');
 }finally{notice.stableNoticeStyleFingerprint=oldStyle;h.close();}
});
