process.env.MALIPANG_TEST_CANDIDATE_FLAGS='1'; // candidate behaviour flags on for this file
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),route=require('../dist/sheets/continuous-daily-route.js'),claimApi=require('../dist/sheets/stable-workbook-claim.js'),coverage=require('../dist/sheets/legacy-daily-coverage.js'),insertWriter=require('../dist/sheets/insert-daily-writer.js');
const {continuousDailyCutoverStatements}=require('../dist/sheets/continuous-daily-cutover.js'),{readStableExpenseSource}=require('../dist/sheets/stable-expense-source.js'),{continuousDailyHelperFormulas}=require('../dist/sheets/continuous-daily-plan.js'),{decodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js'),{insertDailyExpenseUnderClaim}=require('../dist/sheets/insert-daily-writer.js');
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
  if(range.includes("'97_EXPENSE_CLEAN'!")){const header=['Date','Expense_ID / Legacy row','Description','Amount','Wallet','Category','Source','Sales_Addback_Basis'];if(rawE[1][0]==='exp_pilot'){const date=rawE[1][1],serial=(Date.parse(date+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000;return [header,[serial,'exp_pilot','pilot',1.20,'SHOP_BANK','ingredients','V52_CONFIRMED','']];}return rawE[1][0]==='exp_test'?[header,[(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000,'exp_test','=literal',1.23,'SHOP_BANK','ingredients','V52_CONFIRMED','']]:[header];}
  if(range.includes("'V52_EXPENSE_RAW_ALL'!"))return [['Expense_ID'],...rawE.slice(1).map(r=>[r[0]])];
  if(range.includes("'V52_PURCHASE_DETAIL_ALL'!"))return [['Purchase_Item_ID','Expense_ID'],...detailE.slice(1).map(r=>[r[0],r[1]])];
  return range.includes("'raw_new'!")?rawE.map(r=>r.slice()):range.includes("'detail_new'!")?detailE.map(r=>r.slice()):e.map(r=>r.slice());
 });
 client.batchUpdateSpreadsheetWithReply=async(_env,requests,before)=>{
  await before();
  if(requests[0].findReplace?.range.sheetId===2){const x=requests[0].findReplace,i=x.range.startRowIndex;if(f[i][24]!==x.find)return{replies:[{findReplace:{}}]};assert.equal(x.matchEntireCell,true);assert.equal(x.includeFormulas,false);writes++;f[i][24]=e[i][24]=x.replacement;for(const c of [0,1,2,3,5,6,7,8,9,10,11,12,13,14,15,16,17,18,20,21,22,23])e[i][c]='';return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};}
  if(requests[0].findReplace){const change=requests[0].findReplace,i=change.range.startRowIndex,ledgerF=change.range.sheetId===4?detailF:rawF,ledgerE=change.range.sheetId===4?detailE:rawE;if(ledgerF[i][25]!==change.find)return{replies:[{findReplace:{}}]};ledgerF[i][25]=ledgerE[i][25]=change.replacement;ledgerCarrierDisplay(decodeLedgerCarrier(change.replacement)).forEach((v,c)=>{ledgerE[i][c]=v});writes++;return{replies:[{findReplace:{valuesChanged:1,occurrencesChanged:1}}]};}
  const offset=requests[0].appendDimension?1:0,index=requests[offset].insertRange.range.startRowIndex,values=requests[offset+1].updateCells.rows[0].values;
  assert.equal(index,mode==='second-pilot'?5:4);assert.equal(requests[offset].insertRange.range.endColumnIndex,25);writes++;
  const oldF=f.map(r=>r.slice()),oldE=e.map(r=>r.slice());f.push(Array(29).fill(null));e.push(Array(29).fill(null));
  // Provider can grow once for appendDimension and once for insertRange.
  if(offset&&mode!=='one-growth'){f.push(Array(29).fill(null));e.push(Array(29).fill(null));}
  if(offset&&mode==='three-growth'){f.push(Array(29).fill(null));e.push(Array(29).fill(null));}
  for(let i=index;i<oldF.length;i++)for(let c=0;c<25;c++){f[i+1][c]=oldF[i][c];e[i+1][c]=oldE[i][c];}
  for(let i=index+1;i<f.length;i++)if(oldF[i-1]?.[8])Object.assign(f[i],continuousDailyHelperFormulas(i+1));
  for(let c=0;c<25;c++){f[index][c]=values[c].userEnteredValue?.formulaValue??values[c].userEnteredValue?.stringValue??null;e[index][c]=null;}
  const payload=decodeAtomicDailyPayload(f[index][24]);assert.ok(payload);
  Object.assign(e[index],{0:year,1:month,2:day,3:'=literal',7:1.23,8:1.23,9:998.77,18:998.77,20:(Date.UTC(year,month-1,day)-Date.UTC(1899,11,30))/86400000,21:'ingredients',22:'บัญชีร้าน',23:'MALIPANG_EXPENSE:exp_test',24:f[index][24]});
  if(mode==='second-pilot'){
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
test('failed-hold provider probe is read-only and rejects changed failed row',async()=>{const h=await fixture(false,true,'claim-token-recovery'),oldStyle=notice.stableNoticeStyleFingerprint;try{
 h.setMode('timeout');await assert.rejects(h.run(),/synthetic lost response/);
 h.sqlite.prepare("UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED',notice_stamp='stamp',notice_identity='identity',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_token=?").run(h.claim);
 h.sqlite.exec("UPDATE sync_jobs SET status='REVIEW',lease_token=NULL,lease_until=NULL,last_error='STABLE_SYNC_REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id='job'");
 h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('failed','malipang-jobs','fixture','EXPENSE:exp_test:1',?,'Error: STABLE_JOB_HOLD_UNCERTAIN','OPEN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(JSON.stringify(h.job));
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

async function miniflareDailyFixture(sqlite){
 const {mkdtempSync,readdirSync,copyFileSync,rmSync}=await import('node:fs');
 const {join}=await import('node:path'),{tmpdir}=await import('node:os'),{Miniflare}=await import('miniflare');
 const dir=mkdtempSync(join(tmpdir(),'exact-daily-d1-'));
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

for(const finalAck of ['received','lost'])
test('Miniflare exact DAILY settlement preserves both holds when the commit ACK is '+finalAck,async()=>{
 const h=await fixture(false,true,'claim-token-recovery',false,'รายวันต่อเนื่อง_แบบร่าง'),oldStyle=notice.stableNoticeStyleFingerprint;
 let local;
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
  h.sqlite.exec("UPDATE stable_workbook_claims SET state='REVIEW',phase='OPERATION',review_reason='INSERT_DAILY_SNAPSHOT_UNVERIFIED',notice_stamp='stamp',notice_identity='identity',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE spreadsheet_id='book'");
  h.sqlite.exec("UPDATE sync_jobs SET status='REVIEW',lease_token=NULL,lease_until=NULL,last_error='STABLE_SYNC_REVIEW',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id='job'");
  h.sqlite.prepare("INSERT INTO failed_jobs(id,queue_name,trace_id,job_key,payload_json,error,status,attempt_count,created_at,updated_at) VALUES('failed','malipang-jobs','fixture','EXPENSE:exp_test:1',?,'Error: STABLE_JOB_HOLD_UNCERTAIN','OPEN',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))").run(JSON.stringify(h.job));
  h.formula().push(Array(29).fill(null));h.effective().push(Array(29).fill(null));notice.stableNoticeStyleFingerprint=async()=> 'a'.repeat(64);
  local=await miniflareDailyFixture(h.sqlite);
  const {db}=local,version='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let fault='',batches=0;
  const updates=new WeakSet();
  h.env.DB={prepare(sql){
   const statement=db.prepare(sql);
   if(!sql.startsWith('UPDATE stable_projection_writes'))return statement;
   return {bind(...args){const bound=statement.bind(...args);updates.add(bound);return bound;}};
  },async batch(statements){
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
  const action={...settle,action:'HANDOVER_ONE',jobId:pilotId};
  const check={action:'INSPECT_HANDOVER',jobId:pilotId,fingerprint:inspect.fingerprint};
  assert.equal(parseParkedPilot({...action,ownerSupervising:false}),null);
  assert.equal(parseParkedPilot({...check,extra:1}),null);
  assert.deepEqual(parseParkedPilot(action),action);
  Object.assign(h.env,{CONTINUOUS_NORMAL_QUEUE_PILOT_ENABLED:'true',SHEETS_SYNC_ENABLED:'true',UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED:'false'});
  const operate=value=>operateParkedPilot(h.env,value,version);
  assert.deepEqual(await operate(check),{ok:true,outcome:'ABSENT'});
  assert.equal((await operateParkedPilot(h.env,action,'wrong-version')).outcome,'HELD');
  assert.equal((await operate({...action,preimageDigest:'c'.repeat(64)})).outcome,'HELD');
  await db.prepare("UPDATE sync_jobs SET next_attempt_at='2099-01-01' WHERE job_id=?").bind(pilotId).run();
  assert.equal((await operate(action)).outcome,'UNCERTAIN'); // arming affected zero; batch rolls back the old claim delete
  assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims WHERE operation_token='claim-token-recovery'").first()).state,'REVIEW');
  assert.equal((await operate(check)).outcome,'ABSENT');
  await db.prepare("UPDATE sync_jobs SET next_attempt_at=NULL WHERE job_id=?").bind(pilotId).run();
  assert.deepEqual(await operate(action),{ok:true,outcome:'RESERVED'});
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
      for(const projection of ['EXPENSE_RAW','DETAIL','FINAL']){
       step++;
       await worker.queue({queue:'malipang-jobs',messages:[{body:pilot,attempts:1,ack(){acks++;},retry(){assert.fail('unexpected continuation retry');}}]},h.env,{});
       const state=await db.prepare("SELECT j.status,j.last_error,c.phase,c.review_reason FROM sync_jobs j LEFT JOIN stable_workbook_claims c ON c.spreadsheet_id='book' WHERE j.job_id=?").bind(pilotId).first();
       assert.equal(state.status,projection==='FINAL'?'COMPLETED':'PENDING',projection+' '+JSON.stringify(state));
       assert.equal(state.phase,null,JSON.stringify(state));
      }
      assert.equal((await db.prepare("SELECT count(*) n FROM stable_projection_writes WHERE state='VERIFIED' AND (entity_id='exp_pilot' OR entity_id LIKE 'exp_pilot|%')").first()).n,3);
      assert.equal((await db.prepare("SELECT count(*) n FROM stable_recovery_epochs WHERE state='COMPLETE' AND target_key='exp_pilot'").first()).n,1);
      assert.equal(acks,4);assert.equal(posts,3);
     }finally{Date.now=realNow;}

    }finally{globalThis.fetch=originalFetch;googleAuth.getGoogleAccessToken=originalToken;client.batchUpdateSpreadsheetWithReply=model;coverage.readLegacyDailyCoverage=originalCoverage;}
    assert.equal(ends,4);
   }else{
    notice.stableNoticeStyleFingerprint=async()=> 'b'.repeat(64);
    await assert.rejects(claimApi.withStableWorkbookClaim(h.env,async()=>{throw Error('unexpected business callback');},
     pilot,undefined,undefined,{job:pilot,lease:'pilot-lease'}),/PILOT_PAUSE_UNVERIFIED/);
    assert.equal((await db.prepare("SELECT count(*) n FROM stable_recovery_operations WHERE state='ADMITTED'").first()).n,0);
    assert.equal((await db.prepare("SELECT state FROM stable_workbook_claims").first()).state,'REVIEW');
    assert.equal(ends,0);
   }
   assert.equal(begins,finalAck==='received'?3:0);
  }finally{notice.beginStableNotice=originalBegin;notice.endStableNotice=originalEnd;}
  assert.equal((await db.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").first()).status,'REVIEW');
  assert.equal((await db.prepare("SELECT status FROM failed_jobs WHERE id='failed'").first()).status,'OPEN');
  assert.equal(h.writes(),finalAck==='received'?4:1);

 }finally{notice.stableNoticeStyleFingerprint=oldStyle;if(local)await local.close();h.close();}
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
  const read=async(expected)=>{
   const request=new Request('https://example.test/admin/stable-sync/normal-pilot-readback',{method:'POST',
    headers:{authorization:'Bearer '+token,'x-malipang-expected-worker-version':version},body:JSON.stringify({action:'READBACK'})});
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
  assert.equal(h.writes(),1);
 }finally{if(local)await local.close();h.close();}
});
