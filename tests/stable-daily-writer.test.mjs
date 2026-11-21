process.env.MALIPANG_TEST_CANDIDATE_FLAGS='1'; // candidate behaviour flags on for this file
import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';import {expenseSqlite} from './helpers/expense-sqlite.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),notice=require('../dist/sheets/stable-edit-notice.js'),{dispatchStablePhase1}=require('../dist/sheets/stable-phase1-dispatch.js'),{readStableExpenseSource}=require('../dist/sheets/stable-expense-source.js'),{writeNewDailyUnderClaim}=require('../dist/sheets/stable-daily-writer.js'),{runStableExpenseJob}=require('../dist/sheets/stable-expense-job.js'),{resumeStableCapacity}=require('../dist/admin/stable-capacity-resume.js'),{withStableWorkbookClaim}=require('../dist/sheets/stable-workbook-claim.js'),{expectedHelperFormulae}=require('../dist/sheets/daily-stable-row-writes.js');
const blank=()=>Array(25).fill(null);
function fixture(full=false,withItems=false){
 const h=expenseSqlite(),original={getSheetGridInfo:client.getSheetGridInfo,batchGetSheetFormulaValues:client.batchGetSheetFormulaValues,batchGetSheetEffectiveSerialValues:client.batchGetSheetEffectiveSerialValues,batchUpdateSpreadsheet:client.batchUpdateSpreadsheet,batchWriteValues:client.batchWriteValues},prepare=h.DB.prepare,batch=h.DB.batch;
 h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run,all=s.all;s.run=async function(){return{...await run.call(this),success:true};};s.all=async function(){return{...await all.call(this),success:true};};return s;};h.DB.batch=async function(stmts){return(await batch.call(this,stmts)).map(x=>({...x,success:true}));};
 Object.assign(h.env,{GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_RAW:'raw',SHEET_EXPENSE_DAILY:'daily',SHEET_PURCHASE_DETAILS:'detail',SHEET_PERSONAL_USE_RAW:'personal'});
 h.sqlite.exec("UPDATE stable_sync_cutover SET state='ACTIVE',activated_at='now'; INSERT INTO expense_events(expense_id,message_id,line_user_id,description,amount_satang,payment_key,source_wallet,category,transaction_date,status,created_at,version) VALUES('exp_new','message','owner','example',10000,'transfer','SHOP_BANK','ingredients','2026-10-09','CONFIRMED','now',1); INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,updated_at,lease_until,lease_token) VALUES('job','EXPENSE','exp_new',1,'fixture','PROCESSING','now','2099-01-01T00:00:00.000Z','lease')");
 if(withItems)h.sqlite.exec("INSERT INTO expense_documents(document_id,message_id,line_user_id,document_type,status,created_at,vendor_name,document_date) VALUES('doc_1','doc-message','owner','RECEIPT','CONFIRMED','now','shop','2026-10-09'); INSERT INTO expense_document_links(link_id,expense_id,document_id,relation_type,match_method,created_at) VALUES('link','exp_new','doc_1','PRIMARY_PURCHASE_DOCUMENT','MANUAL','now'); INSERT INTO expense_document_items(item_id,document_id,expense_id,description,line_total_satang,created_at,updated_at) VALUES('item_1','doc_1','exp_new','ingredient',10000,'now','now')");
 const count=full?8:9,f=Array.from({length:count},blank),e=Array.from({length:count},blank),header=6,total=count;f[1][7]=e[1][7]='เงินโอน';f[4][0]=e[4][0]=2026;
 for(const a of [f,e]){a[5][1]=10;a[5][3]='รายรับทั้งหมดในบัญชี';a[5][4]=50000;a[5][9]=50000;a[6][1]=10;a[6][2]=9;a[6][3]='old';a[6][7]=100;a[total-1][0]='รวม';a[total-1][1]=10;}
 const helpers=expectedHelperFormulae(header,7);for(const [i,name] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']])f[6][i]=helpers[name];Object.assign(e[6],{8:100,9:49900,17:0,18:49900,20:(Date.UTC(2026,9,9)-Date.UTC(1899,11,30))/86400000});
 for(const [name,i] of [['E',4],['F',5],['G',6],['H',7],['K',10],['L',11],['M',12],['N',13],['O',14],['P',15],['Q',16]]){f[total-1][i]=`=SUMIF($B$7:$B$${total-1},$B${total},${name}7:${name}${total-1})`;e[total-1][i]=name==='H'?100:0;}
 Object.assign(f[total-1],{8:`=SUM(F${total}:H${total})`,9:`=$E$6-I${total}`,17:`=SUM(K${total}:Q${total})`,18:`=J${total}-R${total}`});Object.assign(e[total-1],{8:100,9:49900,17:0,18:49900});
 const raw=[['Expense_ID','Transaction_Date','Description','Amount_Baht','Payment_Key','Source_Wallet','Category','Status','Message_ID','Trace_ID','Submitted_By_Staff_ID','Branch_ID','Document_ID','Document_Type','Vendor','Document_Number','Order_ID']];
 const detail=[['Purchase_Item_ID','Expense_ID','Document_ID','วันที่ซื้อ','บริษัท/ร้านค้า','เลขที่เอกสาร','รายการสินค้า','จำนวน','หน่วย','ราคาต่อหน่วย','ส่วนลดรายการ','จำนวนเงินรายการ','ส่วนลด/ปรับยอดระดับเอกสาร','ยอดจ่ายจริงของ Expense','หมวด','สาขา','สถานะ','Evidence ref (private)','Created_At','Updated_At / Cancelled_At']];
 const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_new',entityVersion:1,traceId:'fixture'};let writes=0,lose=false;
 client.getSheetGridInfo=async(_env,sheet)=>sheet==='raw'?{sheetId:7,rowCount:100,columnCount:17}:sheet==='detail'?{sheetId:8,rowCount:100,columnCount:20}:{sheetId:9,rowCount:count,columnCount:25};client.batchGetSheetFormulaValues=async(_env,ranges)=>ranges.map(range=>(range.includes("'raw'!")?raw:range.includes("'detail'!")?detail:f).map(row=>[...row]));client.batchGetSheetEffectiveSerialValues=async()=>[e.map(row=>[...row])];
 client.batchWriteValues=async(_env,data,before)=>{await before();writes++;(data[0].range.includes("'detail'!")?detail:raw).push([...data[0].values[0]]);};
 client.batchUpdateSpreadsheet=async(_env,requests,before)=>{await before();writes++;for(const request of requests){const u=request.updateCells,index=u.range.startRowIndex,col=u.range.startColumnIndex;u.rows[0].values.forEach((cell,i)=>{const v=cell.userEnteredValue;f[index][col+i]=v.formulaValue??v.numberValue??v.stringValue;e[index][col+i]=v.numberValue??v.stringValue??null;});}Object.assign(e[7],{8:100,9:49800,17:0,18:49800,20:(Date.UTC(2026,9,9)-Date.UTC(1899,11,30))/86400000});Object.assign(e[8],{7:200,8:200,9:49800,17:0,18:49800});if(lose)throw Error('lost');};
 return{...h,job,f,e,raw,detail,writes:()=>writes,lose(){lose=true;},close(){Object.assign(client,original);h.close();}};
}
async function runStages(h){for(let n=0;n<10;n++){const result=await runStableExpenseJob(h.env,h.job,'lease');if(result!=='CONTINUE')return result;assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PENDING');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");}throw Error('too many stages');}
test('current SUM-based monthly subtotal formulas remain supported',async()=>{const h=fixture();try{for(const [name,i] of [['E',4],['F',5],['G',6],['H',7],['K',10],['L',11],['M',12],['N',13],['O',14],['P',15],['Q',16]])h.f[8][i]=`=SUM(${name}7:${name}8)`;h.f[8][8]='=SUM(I7:I8)';h.f[8][17]='=SUM(R7:R8)';assert.equal(await runStages(h),'COMPLETED');assert.equal(h.writes(),2);
 }finally{h.close();}});
test('new daily expense uses an ID, preserves formulas and checks totals before release',async()=>{const h=fixture();try{
 const run=()=>withStableWorkbookClaim(h.env,async claim=>{const source=await readStableExpenseSource(h.env,h.job,'lease',claim);assert.ok(source);await writeNewDailyUnderClaim(h.env,h.job,'lease',claim,source);});
 await run();assert.equal(h.writes(),1);assert.equal(h.f[7][23],'MALIPANG_EXPENSE:exp_new');assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'VERIFIED');await run();assert.equal(h.writes(),1);
 }finally{h.close();}});
test('a full month is held without inserting a row or sending a write',async()=>{const h=fixture(true);try{await assert.rejects(withStableWorkbookClaim(h.env,async claim=>{const source=await readStableExpenseSource(h.env,h.job,'lease',claim);await writeNewDailyUnderClaim(h.env,h.job,'lease',claim,source);}));assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}});
test('expense job completes only after daily and RAW readbacks, then releases its claim',async()=>{const h=fixture();try{assert.equal(await runStages(h),'COMPLETED');assert.equal(h.writes(),2);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'COMPLETED');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{h.close();}});
test('expense with a purchase item completes only after all three sheets read back',async()=>{const h=fixture(false,true);try{assert.equal(await runStages(h),'COMPLETED');assert.equal(h.writes(),3);assert.equal(h.detail[1][0],'item_1');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM stable_projection_writes WHERE state='VERIFIED'").get().n,3);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{h.close();}});
test('opt-in preimages are captured only after each verified provider readback',async()=>{const h=fixture(false,true);try{
 h.env.STABLE_CANCELLATION_PREIMAGE_ENABLED='true';assert.equal(await runStages(h),'COMPLETED');
 const rows=h.sqlite.prepare("SELECT projection,preimage_width,preimage_digest FROM stable_expense_projection_preimages ORDER BY projection").all();
 assert.deepEqual(rows.map(x=>x.projection),['DAILY','DETAIL','EXPENSE_RAW']);
 const sources={DAILY:h.f[7],EXPENSE_RAW:h.raw[1],DETAIL:h.detail[1]};
 for(const row of rows){const source=sources[row.projection];const canonical=Array.from({length:row.preimage_width},(_,i)=>source[i]===undefined||source[i]===''?null:source[i]);assert.equal(createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),row.preimage_digest);}
 assert.equal(h.sqlite.prepare("SELECT count(*) n FROM pragma_table_info('stable_expense_projection_preimages') WHERE name='preimage_json'").get().n,0,'private provider rows are not stored in the journal');
 }finally{h.close();}});
test('undo racing the verified transition cannot commit a trusted preimage',async()=>{const h=fixture();try{
 h.env.STABLE_CANCELLATION_PREIMAGE_ENABLED='true';const batch=h.DB.batch;let raced=false;
 h.DB.batch=async function(statements){if(!raced&&statements.some(s=>s.sql?.includes('INSERT INTO stable_expense_projection_preimages'))){raced=true;h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_new'");}return batch.call(this,statements);};
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_DAILY_VERIFICATION_UNCERTAIN/);assert.equal(raced,true);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_expense_projection_preimages').get().n,0);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}});
test('preimage insert failure rolls back the VERIFIED transition after a Sheets write',async()=>{const h=fixture();try{
 h.env.STABLE_CANCELLATION_PREIMAGE_ENABLED='true';h.sqlite.exec("CREATE TRIGGER fail_preimage BEFORE INSERT ON stable_expense_projection_preimages BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'));assert.equal(h.writes(),1);
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_expense_projection_preimages').get().n,0);
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}});
test('full month holds only its job without dispatch and releases the workbook',async()=>{const h=fixture(true);try{assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CAPACITY_REVIEW');assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 let queued=0;h.env.STABLE_PHASE1_ENABLED='true';h.env.JOB_QUEUE.send=async()=>{queued++;};await resumeStableCapacity(h.env,'exp_new',1);assert.equal(queued,1);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PENDING');await assert.rejects(resumeStableCapacity(h.env,'exp_new',1));
 }finally{h.close();}});
test('a read-only daily preflight failure isolates the job and retains its specific reason',async()=>{const h=fixture();try{
 h.e[5][9]=null;
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'JOB_REVIEW');assert.equal(h.writes(),0);
 assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='job'").get()},{status:'REVIEW',last_error:'STABLE_DAILY_MONTH_OPENING_UNVERIFIED'});
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);
 }finally{h.close();}});
test('scoped holds count returned job rows rather than D1 trigger changes',async()=>{for(const mode of ['STALE','PREFLIGHT']){
 const h=fixture(),prepare=h.DB.prepare;let counted=false;try{
  h.DB.prepare=function(sql){const s=prepare.call(this,sql);if(sql.includes('RETURNING 1 AS held')){const all=s.all;s.all=async function(){const r=await all.call(this);counted=true;return {...r,meta:{...r.meta,changes:r.results.length?2:0}}}}return s};
  if(mode==='STALE')h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_new'");else h.e[5][9]=null;
  assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'JOB_REVIEW');assert.equal(counted,true);assert.equal(h.writes(),0);
  assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{h.close();}
}});
test('a month-specific helper formula failure is held for that job with a specific reason',async()=>{const h=fixture();try{
 h.f[6][9]='=unexpected';assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'JOB_REVIEW');
 assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='job'").get()},{status:'REVIEW',last_error:'STABLE_DAILY_ROW_HELPER_FORMULA_UNVERIFIED'});
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);assert.equal(h.writes(),0);
 }finally{h.close();}});
test('duplicate workbook-wide identifiers retain global review even before intent',async()=>{const h=fixture();try{
 h.f[6][23]=h.e[6][23]='duplicate';h.f[7][23]=h.e[7][23]='duplicate';
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_DAILY_DUPLICATE_OR_INVALID_ID/);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.writes(),0);
 }finally{h.close();}});
test('a daily preflight failure after reservation retains workbook review and the in-flight intent',async()=>{const h=fixture();try{
 client.batchUpdateSpreadsheet=async(_env,_requests,before)=>{h.e[5][9]=null;await before();};
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_DAILY_MONTH_OPENING_UNVERIFIED/);
 assert.equal(h.writes(),0);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PROCESSING');
 }finally{h.close();}});
test('undo after claim but before source read isolates only the stale job without provider writes',async()=>{const h=fixture(),old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused};try{
 h.env.STABLE_PHASE1_ENABLED='true';let ended=0;
 notice.beginStableNotice=async(env,token)=>{await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_new'");};
 notice.endStableNotice=async()=>{ended++};notice.stableNoticePaused=async()=>true;
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'JOB_REVIEW');assert.equal(ended,1);assert.equal(h.writes(),0);
 assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='job'").get()},{status:'REVIEW',last_error:'STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED'});
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{Object.assign(notice,old);h.close();}});
test('undo after reading source but before daily reservation is held without locking the workbook',async()=>{const h=fixture(),original=client.batchGetSheetFormulaValues;let undone=false;try{
 client.batchGetSheetFormulaValues=async(...args)=>{const data=await original(...args);if(!undone){undone=true;h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_new'");}return data;};
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'JOB_REVIEW');
 assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='job'").get()},{status:'REVIEW',last_error:'STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED'});
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);assert.equal(h.writes(),0);
 }finally{h.close();}});
test('undo between the final source check and intent reservation is held without an intent',async()=>{const h=fixture(),prepare=h.DB.prepare;let undone=false;try{
 h.DB.prepare=function(sql){const stmt=prepare.call(this,sql);if(sql.includes('INSERT INTO stable_projection_writes')){const run=stmt.run;stmt.run=async function(){if(!undone){undone=true;h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_new'");}return run.call(this);};}return stmt;};
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'JOB_REVIEW');
 assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='job'").get()},{status:'REVIEW',last_error:'STABLE_EXPENSE_CANCELLED_OR_SUPERSEDED'});
 assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_projection_writes').get().n,0);assert.equal(h.writes(),0);
 }finally{h.DB.prepare=prepare;h.close();}});
test('undo after daily intent remains workbook review and does not erase ambiguity',async()=>{const h=fixture();try{
 client.batchUpdateSpreadsheet=async(_env,_requests,before)=>{h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_new'");await before();};
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_DAILY_SOURCE_CHANGED/);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');assert.equal(h.writes(),0);
 }finally{h.close();}});
test('an unexplained missing source still retains global review',async()=>{const h=fixture();try{
 h.sqlite.exec("UPDATE expense_events SET status='WAITING_CONFIRM' WHERE expense_id='exp_new'");
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_EXPENSE_SOURCE_UNVERIFIED/);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.writes(),0);
 }finally{h.close();}});
test('an armed recovery gate retains workbook review for preflight and stale-source failures',async()=>{for(const mode of ['PREFLIGHT','STALE']){
 const h=fixture(),pacing=require('../dist/sheets/stable-sheet-pacing.js'),old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused,pacingPreflightBlocked:pacing.pacingPreflightBlocked,admitPacedWorkbookOperation:pacing.admitPacedWorkbookOperation};try{
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});
 h.sqlite.exec("INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch_gate_test','book','ARMED','EXPENSE','exp_new',1,'now','now')");
 pacing.pacingPreflightBlocked=async()=>false;pacing.admitPacedWorkbookOperation=async()=>true;
 notice.beginStableNotice=async(env,token,_wait,authorize)=>{await authorize();await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();};notice.stableNoticePaused=async()=>true;notice.endStableNotice=async()=>assert.fail('must not close notice on unverified recovery stage');
 if(mode==='PREFLIGHT')h.e[5][9]=null;else h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_new'");
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),mode==='PREFLIGHT'?/STABLE_DAILY_MONTH_OPENING_UNVERIFIED/:/STABLE_EXPENSE_SOURCE_UNVERIFIED/);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.sqlite.prepare("SELECT state FROM stable_recovery_operations").get().state,'ADMITTED');assert.equal(h.writes(),0);
 }finally{notice.beginStableNotice=old.beginStableNotice;notice.endStableNotice=old.endStableNotice;notice.stableNoticePaused=old.stableNoticePaused;pacing.pacingPreflightBlocked=old.pacingPreflightBlocked;pacing.admitPacedWorkbookOperation=old.admitPacedWorkbookOperation;h.close();}
 }});
test('a persisted recovery epoch fences scoped holds even when the gate flag is off',async()=>{for(const mode of ['PREFLIGHT','STALE'])for(const epochState of ['ARMED','REVIEW']){
 const h=fixture();try{
 h.env.STABLE_RECOVERY_GATE_ENABLED='false';
 h.sqlite.exec(`INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch_gate_test','book','ARMED','EXPENSE','exp_new',1,'now','now')`);
 if(epochState==='REVIEW')h.sqlite.exec("UPDATE stable_recovery_epochs SET state='REVIEW',updated_at='later' WHERE epoch_id='epoch_gate_test'");
 if(mode==='PREFLIGHT')h.e[5][9]=null;else h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_new'");
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),mode==='PREFLIGHT'?/STABLE_DAILY_MONTH_OPENING_UNVERIFIED/:/STABLE_EXPENSE_SOURCE_UNVERIFIED/);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_recovery_epochs').get().state,epochState);
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PROCESSING');assert.equal(h.writes(),0);
 }finally{h.close();}
 }});
test('without migration 0023, scoped review falls back to the original workbook review',async()=>{for(const mode of ['PREFLIGHT','STALE']){
 const h=fixture();try{
 h.env.STABLE_RECOVERY_GATE_ENABLED='false';h.sqlite.exec('DROP TABLE stable_recovery_operations; DROP TABLE stable_recovery_epochs');
 if(mode==='PREFLIGHT')h.e[5][9]=null;else h.sqlite.exec("UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_new'");
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),mode==='PREFLIGHT'?/STABLE_DAILY_MONTH_OPENING_UNVERIFIED/:/STABLE_EXPENSE_SOURCE_UNVERIFIED/);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PROCESSING');assert.equal(h.writes(),0);
 }finally{h.close();}
 }});
test('lost daily acknowledgement keeps the workbook held and never starts RAW',async()=>{const h=fixture();try{h.lose();await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'));assert.equal(h.writes(),1);assert.equal(h.raw.length,1);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='DAILY'").get().state,'IN_FLIGHT');
 }finally{h.close();}});
test('a human change between stages stops completion without rewriting the daily row',async()=>{const h=fixture();try{
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.f[7][3]='changed by editor';h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_FINAL_DAILY_DATA/);assert.equal(h.writes(),2);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}});
test('changed source after daily confirmation stops before RAW and cannot duplicate',async()=>{const h=fixture();try{
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE expense_events SET description='changed' WHERE expense_id='exp_new'; UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_EXPENSE_JOURNAL_CONFLICT/);assert.equal(h.writes(),1);assert.equal(h.raw.length,1);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}});
test('a duplicated RAW identifier between stages prevents completion',async()=>{const h=fixture();try{
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.raw.push([...h.raw[1]]);h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_FINAL_RAW/);assert.equal(h.writes(),2);assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');
 }finally{h.close();}});
test('a moved RAW row is found by identifier in final verification',async()=>{const h=fixture();try{
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.raw.splice(1,0,[]);h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');assert.equal(h.writes(),2);assert.equal(h.raw[2][0],'exp_new');
 }finally{h.close();}});
test('lost RAW acknowledgement retains the intent and blocks a replay',async()=>{const h=fixture();try{
 assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
 const original=client.batchWriteValues;client.batchWriteValues=async(...args)=>{await original(...args);throw Error('lost response');};
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'));assert.equal(h.raw.length,2);assert.equal(h.sqlite.prepare("SELECT state FROM stable_projection_writes WHERE projection='EXPENSE_RAW'").get().state,'IN_FLIGHT');await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/REVIEW/);assert.equal(h.raw.length,2);
 }finally{h.close();}});
test('queue dispatch processes a new expense and holds a full month without a provider write',async()=>{for(const full of [false,true]){const h=fixture(full),old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused};try{
 h.env.STABLE_PHASE1_ENABLED='true';h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");notice.beginStableNotice=async(env,token)=>{await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();};notice.endStableNotice=async()=>{};notice.stableNoticePaused=async()=>true;
 let outcome;for(let n=0;n<5;n++){outcome=await dispatchStablePhase1(h.env,h.job);if(outcome!=='BUSY')break;}assert.equal(outcome,full?'REVIEW':'PROCESSED');assert.equal(h.writes(),full?0:2);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,full?'REVIEW':'COMPLETED');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_workbook_claims').get().n,0);
 }finally{Object.assign(notice,old);h.close();}}});
test('dispatch holds cancelled sources safely and retains workbook review for an unresolved intent',async()=>{for(const inFlight of [false,true]){
 const h=fixture(),old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused};try{
 h.env.STABLE_PHASE1_ENABLED='true';h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'; UPDATE expense_events SET status='CANCELLED',version=2 WHERE expense_id='exp_new'");
 if(inFlight)h.sqlite.prepare("INSERT INTO stable_projection_writes VALUES('book','EXPENSE','exp_new','DAILY',9,'daily',1,?,'earlier','IN_FLIGHT','now')").run('a'.repeat(64));
 notice.beginStableNotice=async(env,token)=>{await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();};notice.endStableNotice=async()=>{};notice.stableNoticePaused=async()=>true;
 assert.equal(await dispatchStablePhase1(h.env,h.job),'REVIEW');assert.equal(h.writes(),0);
 const claim=h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get();
 assert.equal(claim?.state,inFlight?'REVIEW':undefined);
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');
 }finally{Object.assign(notice,old);h.close();}
}});
test('dispatch retains an ambiguous job without treating alert trigger changes as hold failure',async()=>{
 const h=fixture(),expense=require('../dist/sheets/stable-expense-job.js'),original=expense.runStableExpenseJob,logged=console.error;
 try{
  h.env.STABLE_PHASE1_ENABLED='true';h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");
  expense.runStableExpenseJob=async()=>{throw Error('synthetic unknown outcome');};console.error=()=>{};
  assert.equal(await dispatchStablePhase1(h.env,h.job),'REVIEW');
  const row=h.sqlite.prepare("SELECT status,last_error,lease_token FROM sync_jobs WHERE job_id='job'").get();
  assert.equal(row.status,'REVIEW');assert.equal(row.last_error,'STABLE_SYNC_REVIEW');assert.equal(row.lease_token,null);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_alert_incidents WHERE kind='JOB' AND source_id='job' AND state='OPEN'").get().n,1);
  assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE status='OPEN'").get().n,0);
 }finally{expense.runStableExpenseJob=original;console.error=logged;h.close();}
});
test('staged expense with item and preimage capture stays below the 50 subrequest limit per invocation',async()=>{const h=fixture(false,true),old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused},fns=['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheet','batchWriteValues'];let count=0,max=0;const add=n=>{count+=n;max=Math.max(max,count);if(count>50)throw Error('subrequest limit');};try{
 h.env.STABLE_PHASE1_ENABLED='true';h.env.STABLE_CANCELLATION_PREIMAGE_ENABLED='true';h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");
 notice.beginStableNotice=async(env,token)=>{add(7);await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();};notice.endStableNotice=async()=>{add(5);};notice.stableNoticePaused=async()=>{add(2);return true;};
 for(const name of fns){const fn=client[name];client[name]=async(...args)=>{add(1);return fn(...args);};}
 let outcome;for(let i=0;i<6;i++){count=1;outcome=await dispatchStablePhase1(h.env,h.job);if(outcome!=='BUSY')break;}assert.equal(outcome,'PROCESSED');assert.equal(h.writes(),3);assert.ok(max<=50,`maximum ${max}`);assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'COMPLETED');assert.equal(h.sqlite.prepare('SELECT count(*) n FROM stable_expense_projection_preimages').get().n,3);
 }finally{Object.assign(notice,old);h.close();}});
test('verified stage followed by a rate-limited end notice keeps the job durable, records the cause and never repeats the write',async()=>{const h=fixture(),old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused},logged=[],error=console.error;try{
 h.env.STABLE_PHASE1_ENABLED='true';h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");console.error=(...args)=>logged.push(args);
 notice.beginStableNotice=async(env,token)=>{await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();};notice.stableNoticePaused=async()=>true;notice.endStableNotice=async()=>{throw new client.SheetsHttpError(429,'STABLE_NOTICE_READ');};
 assert.equal(await dispatchStablePhase1(h.env,h.job),'REVIEW');assert.equal(h.writes(),1);
 assert.deepEqual({...h.sqlite.prepare('SELECT state,phase,review_reason FROM stable_workbook_claims').get()},{state:'REVIEW',phase:'END_NOTICE',review_reason:'STABLE_NOTICE_READ:HTTP_429'});
 assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error FROM sync_jobs WHERE job_id='job'").get()},{status:'PENDING',last_error:'STABLE_STAGE_CONTINUE'});
 assert.deepEqual(h.sqlite.prepare('SELECT projection,state FROM stable_projection_writes').all().map(x=>`${x.projection}:${x.state}`),['DAILY:VERIFIED']);
 assert.ok(logged.some(([event,detail])=>event==='stable-workbook-review'&&detail.reason==='STABLE_NOTICE_READ:HTTP_429'&&detail.phase==='END_NOTICE'));
 const attempts=h.sqlite.prepare("SELECT attempt_count FROM sync_jobs WHERE job_id='job'").get().attempt_count;
 for(let i=0;i<5;i++)assert.equal(await dispatchStablePhase1(h.env,h.job),'BLOCKED');
 assert.equal(h.sqlite.prepare("SELECT attempt_count FROM sync_jobs WHERE job_id='job'").get().attempt_count,attempts);assert.equal(h.writes(),1);
 }finally{console.error=error;Object.assign(notice,old);h.close();}});
test('a review claim that appears after the pre-check releases the job lease without spending the job',async()=>{const h=fixture(),claims=require('../dist/sheets/stable-workbook-claim.js'),check=claims.stableWorkbookInReview;try{
 h.env.STABLE_PHASE1_ENABLED='true';h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'; INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES('book','other','REVIEW','now','now')");
 claims.stableWorkbookInReview=async()=>false;
 assert.equal(await dispatchStablePhase1(h.env,h.job),'BLOCKED');assert.equal(h.writes(),0);
 assert.deepEqual({...h.sqlite.prepare("SELECT status,last_error,lease_token FROM sync_jobs WHERE job_id='job'").get()},{status:'PENDING',last_error:'STABLE_WORKBOOK_REVIEW',lease_token:null});
 }finally{claims.stableWorkbookInReview=check;h.close();}});
test('full 10-message paced queue path records D1 and external-call budget per expense stage',async t=>{const h=fixture(false,true),worker=require('../dist/index.js').default,pacing=require('../dist/sheets/stable-sheet-pacing.js'),oldPace=pacing.admitPacedWorkbookOperation,old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused},fns=['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheet','batchWriteValues'],prep=h.DB.prepare,batch=h.DB.batch;let external=0,internal=0,maxExternal=0,maxInternal=0,maxCombined=0;try{
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");
 h.DB.prepare=function(sql){const stmt=prep.call(this,sql);for(const method of ['first','all','run']){const fn=stmt[method];stmt[method]=async function(...args){internal++;return fn.apply(this,args)}}return stmt};h.DB.batch=async function(stmts){internal++;return batch.call(this,stmts)};
 h.env.JOB_QUEUE.send=async()=>{};pacing.admitPacedWorkbookOperation=async env=>{await env.DB.prepare('SELECT 1').first();await env.DB.prepare('SELECT 1').first();return true};
 notice.beginStableNotice=async(env,token,_unused,authorize)=>{external+=7;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await authorize?.();await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.endStableNotice=async(env,token)=>{external+=5;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await env.DB.prepare("SELECT count(*) n FROM sync_jobs WHERE status='REVIEW'").first();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.stableNoticePaused=async()=>{external+=2;return true};
 for(const name of fns){const fn=client[name];client[name]=async(...args)=>{external++;return fn(...args)}}
 for(let i=0;i<6;i++){external=0;internal=0;let ack=0;const jobs=[h.job,...Array.from({length:9},(_,n)=>({...h.job,entityKey:'exp_parked_'+n}))],messages=jobs.map(body=>({body,attempts:1,ack(){ack++},retry(){assert.fail('unexpected retry')}}));await worker.queue({queue:'malipang-jobs',messages},h.env,{});assert.equal(ack,10);maxExternal=Math.max(maxExternal,external);maxInternal=Math.max(maxInternal,internal);maxCombined=Math.max(maxCombined,external+internal);if(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status==='COMPLETED')break}
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'COMPLETED');assert.ok(maxExternal<=50,`external ${maxExternal}`);assert.ok(maxInternal<=50,`D1 queries ${maxInternal}`);t.diagnostic(`maximum mocked stage: external ${maxExternal}, D1 queries ${maxInternal}, sum ${maxCombined}; excludes unmodelled calls and provider retries`)
 }finally{h.DB.prepare=prep;h.DB.batch=batch;pacing.admitPacedWorkbookOperation=oldPace;Object.assign(notice,old);h.close()}});

test('paced 10-message batch retains headroom through a post-write failure and owner alert',async t=>{const h=fixture(false,true),worker=require('../dist/index.js').default,pacing=require('../dist/sheets/stable-sheet-pacing.js'),oldPace=pacing.admitPacedWorkbookOperation,old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused},fns=['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheet','batchWriteValues'],prep=h.DB.prepare,batch=h.DB.batch;let external=0,internal=0,maxExternal=0,maxInternal=0,maxCombined=0;try{
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");
 h.DB.prepare=function(sql){const stmt=prep.call(this,sql);for(const method of ['first','all','run']){const fn=stmt[method];stmt[method]=async function(...args){internal++;return fn.apply(this,args)}}return stmt};h.DB.batch=async function(stmts){internal++;return batch.call(this,stmts)};
 h.env.JOB_QUEUE.send=async()=>{};pacing.admitPacedWorkbookOperation=async env=>{await env.DB.prepare('SELECT 1').first();await env.DB.prepare('SELECT 1').first();return true};
 notice.beginStableNotice=async(env,token,_unused,authorize)=>{external+=7;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await authorize?.();await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.endStableNotice=async(env,token)=>{external+=5;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await env.DB.prepare("SELECT count(*) n FROM sync_jobs WHERE status='REVIEW'").first();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.stableNoticePaused=async()=>{external+=2;return true};
 for(const name of fns){const fn=client[name];client[name]=async(...args)=>{external++;return fn(...args)}}
 h.lose();for(let i=0;i<1;i++){external=0;internal=0;let ack=0;const jobs=[h.job,...Array.from({length:9},(_,n)=>({...h.job,entityKey:'exp_parked_'+n}))],messages=jobs.map(body=>({body,attempts:1,ack(){ack++},retry(){assert.fail('unexpected retry')}}));await worker.queue({queue:'malipang-jobs',messages},h.env,{});assert.equal(ack,10);maxExternal=Math.max(maxExternal,external);maxInternal=Math.max(maxInternal,internal);maxCombined=Math.max(maxCombined,external+internal);if(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status==='COMPLETED')break}
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'REVIEW');assert.ok(maxExternal<=50,`external ${maxExternal}`);assert.ok(maxInternal<=45,`D1 queries ${maxInternal}`);t.diagnostic(`post-write failure with alert wake: external ${maxExternal}, D1 queries ${maxInternal}; mocked provider and queue, excludes provider retries`)
 }finally{h.DB.prepare=prep;h.DB.batch=batch;pacing.admitPacedWorkbookOperation=oldPace;Object.assign(notice,old);h.close()}});

test('paced batch retains headroom when D1 hold fails and the queue records a failed job',async t=>{const h=fixture(false,true),worker=require('../dist/index.js').default,pacing=require('../dist/sheets/stable-sheet-pacing.js'),oldPace=pacing.admitPacedWorkbookOperation,old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused},fns=['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheet','batchWriteValues'],prep=h.DB.prepare,batch=h.DB.batch;let external=0,internal=0,maxExternal=0,maxInternal=0,maxCombined=0;try{
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");
 let failHold=true;h.DB.prepare=function(sql){const stmt=prep.call(this,sql);for(const method of ['first','all','run']){const fn=stmt[method];stmt[method]=async function(...args){internal++;if(method==='all'&&failHold&&sql.includes("UPDATE sync_jobs SET status='REVIEW'")){failHold=false;throw Error('synthetic D1 hold failure');}return fn.apply(this,args)}}return stmt};h.DB.batch=async function(stmts){internal++;return batch.call(this,stmts)};
 h.env.JOB_QUEUE.send=async()=>{};pacing.admitPacedWorkbookOperation=async env=>{await env.DB.prepare('SELECT 1').first();await env.DB.prepare('SELECT 1').first();return true};
 notice.beginStableNotice=async(env,token,_unused,authorize)=>{external+=7;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await authorize?.();await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.endStableNotice=async(env,token)=>{external+=5;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await env.DB.prepare("SELECT count(*) n FROM sync_jobs WHERE status='REVIEW'").first();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.stableNoticePaused=async()=>{external+=2;return true};
 for(const name of fns){const fn=client[name];client[name]=async(...args)=>{external++;return fn(...args)}}
 h.lose();for(let i=0;i<1;i++){external=0;internal=0;let ack=0,retry=0;const jobs=[h.job,...Array.from({length:9},(_,n)=>({...h.job,entityKey:'exp_parked_'+n}))],messages=jobs.map(body=>({body,attempts:1,ack(){ack++},retry(){retry++}}));await worker.queue({queue:'malipang-jobs',messages},h.env,{});assert.equal(ack,9);assert.equal(retry,1);maxExternal=Math.max(maxExternal,external);maxInternal=Math.max(maxInternal,internal);maxCombined=Math.max(maxCombined,external+internal);if(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status==='COMPLETED')break}
 assert.equal(failHold,false);assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'REVIEW');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE status='OPEN'").get().n,1);assert.ok(maxExternal<=50,`external ${maxExternal}`);assert.ok(maxInternal<=45,`D1 queries ${maxInternal}`);t.diagnostic(`post-write D1 failure with retry, failed-job and alert wake: external ${maxExternal}, D1 queries ${maxInternal}; mocked provider and queue, excludes provider retries`)
 }finally{h.DB.prepare=prep;h.DB.batch=batch;pacing.admitPacedWorkbookOperation=oldPace;Object.assign(notice,old);h.close()}});

test('mixed expense plus nine HR jobs retains D1 headroom during normal stage',async t=>{const h=fixture(false,true),worker=require('../dist/index.js').default,pacing=require('../dist/sheets/stable-sheet-pacing.js'),oldPace=pacing.admitPacedWorkbookOperation,old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused},fns=['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheet','batchWriteValues'],prep=h.DB.prepare,batch=h.DB.batch;let external=0,internal=0,maxExternal=0,maxInternal=0,maxCombined=0;try{
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");
 h.DB.prepare=function(sql){const stmt=prep.call(this,sql);for(const method of ['first','all','run']){const fn=stmt[method];stmt[method]=async function(...args){internal++;return fn.apply(this,args)}}return stmt};h.DB.batch=async function(stmts){internal++;return batch.call(this,stmts)};
 h.env.JOB_QUEUE.send=async()=>{};pacing.admitPacedWorkbookOperation=async env=>{await env.DB.prepare('SELECT 1').first();await env.DB.prepare('SELECT 1').first();return true};
 notice.beginStableNotice=async(env,token,_unused,authorize)=>{external+=7;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await authorize?.();await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.endStableNotice=async(env,token)=>{external+=5;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await env.DB.prepare("SELECT count(*) n FROM sync_jobs WHERE status='REVIEW'").first();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.stableNoticePaused=async()=>{external+=2;return true};
 for(const name of fns){const fn=client[name];client[name]=async(...args)=>{external++;return fn(...args)}}
 for(let i=0;i<1;i++){external=0;internal=0;let ack=0;const jobs=[h.job,...Array.from({length:9},(_,n)=>({...h.job,entityType:'DAILY_PAYROLL',entityKey:'hr_parked_'+n}))],messages=jobs.map(body=>({body,attempts:1,ack(){ack++},retry(){assert.fail('unexpected retry')}}));await worker.queue({queue:'malipang-jobs',messages},h.env,{});assert.equal(ack,10);maxExternal=Math.max(maxExternal,external);maxInternal=Math.max(maxInternal,internal);maxCombined=Math.max(maxCombined,external+internal);if(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status==='COMPLETED')break}
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PENDING');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_jobs WHERE entity_type='DAILY_PAYROLL'").get().n,9);assert.ok(maxExternal<=50,`external ${maxExternal}`);assert.ok(maxInternal<=1000,`Paid D1 queries ${maxInternal}`);t.diagnostic(`maximum mocked stage: external ${maxExternal}, Paid D1 queries ${maxInternal}, sum ${maxCombined}; publication schema checks add 2 calls versus the prior 45-call fixture; excludes unmodelled calls and provider retries`)
 }finally{h.DB.prepare=prep;h.DB.batch=batch;pacing.admitPacedWorkbookOperation=oldPace;Object.assign(notice,old);h.close()}});


test('mixed expense plus nine HR jobs retains D1 headroom on provider error',async t=>{const h=fixture(false,true),worker=require('../dist/index.js').default,pacing=require('../dist/sheets/stable-sheet-pacing.js'),oldPace=pacing.admitPacedWorkbookOperation,old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused},fns=['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheet','batchWriteValues'],prep=h.DB.prepare,batch=h.DB.batch;let external=0,internal=0,maxExternal=0,maxInternal=0,maxCombined=0;try{
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");
 h.DB.prepare=function(sql){const stmt=prep.call(this,sql);for(const method of ['first','all','run']){const fn=stmt[method];stmt[method]=async function(...args){internal++;return fn.apply(this,args)}}return stmt};h.DB.batch=async function(stmts){internal++;return batch.call(this,stmts)};
 h.env.JOB_QUEUE.send=async()=>{};pacing.admitPacedWorkbookOperation=async env=>{await env.DB.prepare('SELECT 1').first();await env.DB.prepare('SELECT 1').first();return true};
 notice.beginStableNotice=async(env,token,_unused,authorize)=>{external+=7;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await authorize?.();await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.endStableNotice=async(env,token)=>{external+=5;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await env.DB.prepare("SELECT count(*) n FROM sync_jobs WHERE status='REVIEW'").first();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.stableNoticePaused=async()=>{external+=2;return true};
 for(const name of fns){const fn=client[name];client[name]=async(...args)=>{external++;return fn(...args)}}
 h.lose();for(let i=0;i<1;i++){external=0;internal=0;let ack=0;const jobs=[h.job,...Array.from({length:9},(_,n)=>({...h.job,entityType:'DAILY_PAYROLL',entityKey:'hr_parked_'+n}))],messages=jobs.map(body=>({body,attempts:1,ack(){ack++},retry(){assert.fail('unexpected retry')}}));await worker.queue({queue:'malipang-jobs',messages},h.env,{});assert.equal(ack,10);maxExternal=Math.max(maxExternal,external);maxInternal=Math.max(maxInternal,internal);maxCombined=Math.max(maxCombined,external+internal);if(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status==='COMPLETED')break}
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'REVIEW');assert.ok(maxExternal<=50,`external ${maxExternal}`);assert.ok(maxInternal<=45,`D1 queries ${maxInternal}`);t.diagnostic(`post-write failure with alert wake: external ${maxExternal}, D1 queries ${maxInternal}; mocked provider and queue, excludes provider retries`)
 }finally{h.DB.prepare=prep;h.DB.batch=batch;pacing.admitPacedWorkbookOperation=oldPace;Object.assign(notice,old);h.close()}});


test('mixed expense plus nine HR jobs retains D1 headroom on D1 error and alert',async t=>{const h=fixture(false,true),worker=require('../dist/index.js').default,pacing=require('../dist/sheets/stable-sheet-pacing.js'),oldPace=pacing.admitPacedWorkbookOperation,old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused},fns=['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheet','batchWriteValues'],prep=h.DB.prepare,batch=h.DB.batch;let external=0,internal=0,maxExternal=0,maxInternal=0,maxCombined=0;try{
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true'});h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");
 let failHold=true;h.DB.prepare=function(sql){const stmt=prep.call(this,sql);for(const method of ['first','all','run']){const fn=stmt[method];stmt[method]=async function(...args){internal++;if(method==='all'&&failHold&&sql.includes("UPDATE sync_jobs SET status='REVIEW'")){failHold=false;throw Error('synthetic D1 hold failure');}return fn.apply(this,args)}}return stmt};h.DB.batch=async function(stmts){internal++;return batch.call(this,stmts)};
 h.env.JOB_QUEUE.send=async()=>{};pacing.admitPacedWorkbookOperation=async env=>{await env.DB.prepare('SELECT 1').first();await env.DB.prepare('SELECT 1').first();return true};
 notice.beginStableNotice=async(env,token,_unused,authorize)=>{external+=7;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await authorize?.();await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.endStableNotice=async(env,token)=>{external+=5;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await env.DB.prepare("SELECT count(*) n FROM sync_jobs WHERE status='REVIEW'").first();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.stableNoticePaused=async()=>{external+=2;return true};
 for(const name of fns){const fn=client[name];client[name]=async(...args)=>{external++;return fn(...args)}}
 h.lose();for(let i=0;i<1;i++){external=0;internal=0;let ack=0,retry=0;const jobs=[h.job,...Array.from({length:9},(_,n)=>({...h.job,entityType:'DAILY_PAYROLL',entityKey:'hr_parked_'+n}))],messages=jobs.map(body=>({body,attempts:1,ack(){ack++},retry(){retry++}}));await worker.queue({queue:'malipang-jobs',messages},h.env,{});assert.equal(ack,9);assert.equal(retry,1);maxExternal=Math.max(maxExternal,external);maxInternal=Math.max(maxInternal,internal);maxCombined=Math.max(maxCombined,external+internal);if(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status==='COMPLETED')break}
 assert.equal(failHold,false);assert.equal(h.sqlite.prepare("SELECT state FROM stable_workbook_claims WHERE spreadsheet_id='book'").get().state,'REVIEW');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM failed_jobs WHERE status='OPEN'").get().n,1);assert.ok(maxExternal<=50,`external ${maxExternal}`);assert.ok(maxInternal<=45,`D1 queries ${maxInternal}`);t.diagnostic(`post-write D1 failure with retry, failed-job and alert wake: external ${maxExternal}, D1 queries ${maxInternal}; mocked provider and queue, excludes provider retries`)
 }finally{h.DB.prepare=prep;h.DB.batch=batch;pacing.admitPacedWorkbookOperation=oldPace;Object.assign(notice,old);h.close()}});

test('exact expense canary plus nine HR jobs stays within measured D1 budget',async t=>{const h=fixture(false,true),worker=require('../dist/index.js').default,pacing=require('../dist/sheets/stable-sheet-pacing.js'),oldPace=pacing.admitPacedWorkbookOperation,old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused},fns=['getSheetGridInfo','batchGetSheetFormulaValues','batchGetSheetEffectiveSerialValues','batchUpdateSpreadsheet','batchWriteValues'],prep=h.DB.prepare,batch=h.DB.batch;let external=0,internal=0,maxExternal=0,maxInternal=0,maxCombined=0;try{
 Object.assign(h.env,{STABLE_PHASE1_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true'});h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'; INSERT INTO stable_recovery_epochs(epoch_id,spreadsheet_id,state,target_type,target_key,target_version,created_at,updated_at) VALUES('epoch-canary','book','ARMED','EXPENSE','exp_new',1,'now','now')");
 h.DB.prepare=function(sql){const stmt=prep.call(this,sql);for(const method of ['first','all','run']){const fn=stmt[method];stmt[method]=async function(...args){internal++;return fn.apply(this,args)}}return stmt};h.DB.batch=async function(stmts){internal++;return batch.call(this,stmts)};
 h.env.JOB_QUEUE.send=async()=>{};pacing.admitPacedWorkbookOperation=async env=>{await env.DB.prepare('SELECT 1').first();await env.DB.prepare('SELECT 1').first();return true};
 notice.beginStableNotice=async(env,token,_unused,authorize)=>{external+=7;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await authorize?.();await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.endStableNotice=async(env,token)=>{external+=5;await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first();await env.DB.prepare("SELECT count(*) n FROM sync_jobs WHERE status='REVIEW'").first();await env.DB.prepare("SELECT 1 AS ok FROM stable_workbook_claims WHERE spreadsheet_id=? AND operation_token=? AND state='HELD'").bind('book',token).first()};notice.stableNoticePaused=async()=>{external+=2;return true};
 for(const name of fns){const fn=client[name];client[name]=async(...args)=>{external++;return fn(...args)}}
 for(let i=0;i<1;i++){external=0;internal=0;let ack=0;const jobs=[h.job,...Array.from({length:9},(_,n)=>({...h.job,entityType:'DAILY_PAYROLL',entityKey:'hr_parked_'+n}))],messages=jobs.map(body=>({body,attempts:1,ack(){ack++},retry(){assert.fail('unexpected retry')}}));await worker.queue({queue:'malipang-jobs',messages},h.env,{});assert.equal(ack,10);maxExternal=Math.max(maxExternal,external);maxInternal=Math.max(maxInternal,internal);maxCombined=Math.max(maxCombined,external+internal);if(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status==='COMPLETED')break}
 assert.equal(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'PENDING');assert.equal(h.sqlite.prepare("SELECT count(*) n FROM sync_jobs WHERE entity_type='DAILY_PAYROLL'").get().n,9);assert.ok(maxExternal<=50,`external ${maxExternal}`);assert.ok(maxInternal<=1000,`Paid D1 queries ${maxInternal}`);t.diagnostic(`maximum mocked stage: external ${maxExternal}, Paid D1 queries ${maxInternal}, sum ${maxCombined}; publication schema checks add 2 calls versus the prior 45-call fixture; excludes unmodelled calls and provider retries`)
 }finally{h.DB.prepare=prep;h.DB.batch=batch;pacing.admitPacedWorkbookOperation=oldPace;Object.assign(notice,old);h.close()}});
test('scoped review off: a month-specific failure retains the workbook review with the main code',async()=>{const h=fixture();try{
 delete h.env.STABLE_SCOPED_REVIEW_ENABLED;
 h.f[6][9]='=unexpected';await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/^Error: STABLE_DAILY_REVIEW$/);
 assert.deepEqual({...h.sqlite.prepare('SELECT state,review_reason FROM stable_workbook_claims').get()},{state:'REVIEW',review_reason:'STABLE_DAILY_REVIEW'});
 assert.notEqual(h.sqlite.prepare("SELECT status FROM sync_jobs WHERE job_id='job'").get().status,'REVIEW');assert.equal(h.writes(),0);
 }finally{h.close();}});
test('scoped review off: a source cancelled after claim retains the workbook review instead of a job hold',async()=>{const h=fixture();try{
 delete h.env.STABLE_SCOPED_REVIEW_ENABLED;
 h.sqlite.prepare("UPDATE expense_events SET status='CANCELLED',version=version+1").run();
 await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_EXPENSE_SOURCE_UNVERIFIED/);
 assert.equal(h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,'REVIEW');assert.equal(h.writes(),0);
 }finally{h.close();}});
test('R3: D1 use per expense dispatch with candidate flags off stays far below the per-invocation limit',async()=>{
 for(const items of [false,true]){const h=fixture(false,items),old={beginStableNotice:notice.beginStableNotice,endStableNotice:notice.endStableNotice,stableNoticePaused:notice.stableNoticePaused};try{
  h.env.STABLE_PHASE1_ENABLED='true';h.sqlite.exec("UPDATE sync_jobs SET status='PENDING',lease_token=NULL,lease_until=NULL WHERE job_id='job'");notice.beginStableNotice=async(env,token)=>{await env.DB.prepare("UPDATE stable_workbook_claims SET notice_stamp='fixture',notice_identity='fixture' WHERE spreadsheet_id=? AND operation_token=?").bind('book',token).run();};notice.endStableNotice=async()=>{};notice.stableNoticePaused=async()=>true;
  for(const k of ['EXPENSE_SAVED_SYNC_NOTE_ENABLED','EXPENSE_FORCE_RECONCILE_HOLD_ENABLED','STABLE_REDRIVE_HOLD_ENABLED','WORKBOOK_BATCH_FAIRNESS_ENABLED','SYNC_ALERT_DURABLE_ENABLED','SYNC_ALERT_DURABLE_SINCE','STABLE_SCOPED_REVIEW_ENABLED'])delete h.env[k];
  const prepare=h.DB.prepare,batch=h.DB.batch;let calls=0,statements=0;const perDispatch=[];
  h.DB.prepare=function(sql){const s=prepare.call(this,sql);for(const m of ['run','first','all']){const f=s[m];s[m]=async function(...a){calls++;statements++;return f.apply(this,a);};}return s;};
  h.DB.batch=async function(stmts){calls++;statements+=stmts.length;return batch.call(this,stmts);};
  let outcome;for(let n=0;n<8;n++){calls=0;statements=0;outcome=await dispatchStablePhase1(h.env,h.job);perDispatch.push({calls,statements});if(outcome!=='BUSY'&&outcome!=='CONTINUE')break;}
  assert.equal(outcome,'PROCESSED');
  // Workers Paid allows 1,000 D1 queries per invocation and a queue batch holds
  // up to 10 messages, so one message must stay well under 100 even counting
  // every batched statement separately (the strictest reading of the limit).
  // Scope: one expense message dispatched alone; other messages in the same
  // queue batch (parked hints, LINE events) are not counted here.
  // Measured on 2026-11-18 with the same fixture: pre-candidate main 2015c6a
  // used at most 26 calls / 44 statements per dispatch; this branch 31 / 49.
  // The guard of 60 catches a regression long before the platform limit.
  const worst=Math.max(...perDispatch.map(x=>x.statements));
  assert.ok(worst<=60,`worst dispatch used ${worst} D1 statements: ${JSON.stringify(perDispatch)}`);
  console.log(`R3 measurement items=${items}: ${JSON.stringify(perDispatch)}`);
 }finally{Object.assign(notice,old);h.close();}}
});

test('completion accepts the D1 alert-closing trigger while rejecting unexpected counts',async()=>{
 for(const n of [2,0,3]){const h=fixture();try{
  assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
  assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'CONTINUE');h.sqlite.exec("UPDATE sync_jobs SET status='PROCESSING',lease_token='lease',lease_until='2099-01-01T00:00:00.000Z' WHERE job_id='job'");
  const prepare=h.DB.prepare;h.DB.prepare=function(sql){const s=prepare.call(this,sql),run=s.run;if(sql.includes("UPDATE sync_jobs SET status='COMPLETED'"))s.run=async function(){const result=await run.call(this);return {...result,meta:{...result.meta,changes:n}}};return s;};
  if(n===2)assert.equal(await runStableExpenseJob(h.env,h.job,'lease'),'COMPLETED');else await assert.rejects(runStableExpenseJob(h.env,h.job,'lease'),/STABLE_EXPENSE_COMPLETION_UNCERTAIN/);
 }finally{h.close();}}
});
