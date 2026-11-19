import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {combinedLedgerSpillFormulas} from '../scripts/combined-ledger-report-formulas.mjs';

const require=createRequire(import.meta.url);
const client=require('../dist/sheets/client.js');
const notice=require('../dist/sheets/stable-edit-notice.js');
const recovery=require('../dist/sheets/continuous-views-incident-recovery.js');
const template=require('../dist/sheets/atomic-expense-ledger-template.js');
const bootstrap=require('../dist/sheets/report-view-bootstrap.js');
const sha=x=>createHash('sha256').update(x).digest('hex');

function fixture(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec("CREATE TABLE stable_workbook_claims(spreadsheet_id TEXT PRIMARY KEY,operation_token TEXT UNIQUE,state TEXT,phase TEXT,review_reason TEXT,notice_stamp TEXT,notice_identity TEXT,created_at TEXT,updated_at TEXT);");
 sqlite.exec("CREATE TABLE stable_projection_writes(spreadsheet_id TEXT,state TEXT,operation_token TEXT);CREATE TABLE stable_expense_cancellation_writes(spreadsheet_id TEXT,state TEXT,operation_token TEXT);");
 sqlite.exec("CREATE TABLE stable_recovery_epochs(spreadsheet_id TEXT,state TEXT);CREATE TABLE stable_recovery_operations(state TEXT,operation_token TEXT);CREATE TABLE sync_jobs(status TEXT);CREATE TABLE staff_config_sync_outbox(status TEXT);");
 sqlite.exec("CREATE TABLE continuous_daily_cutovers(spreadsheet_id TEXT,state TEXT);");
 sqlite.exec(fs.readFileSync(new URL('../migrations/0029_continuous_report_cutover.sql',import.meta.url),'utf8'));
 sqlite.exec(fs.readFileSync(new URL('../migrations/0031_continuous_cutover_operator.sql',import.meta.url),'utf8'));
 const names=['V52_EXPENSE_RAW_ต่อเนื่อง','รายละเอียดการซื้อ_ต่อเนื่อง','V52_EXPENSE_RAW_ALL','V52_PURCHASE_DETAIL_ALL'],ids=[2026111901,2026111902,2026111903,2026111904];
 const markers=[Array.from({length:999},(_,i)=>'MPL1_EMPTY_'+(i+2)+'_'+(i+11).toString(16).padStart(32,'0')),Array.from({length:999},(_,i)=>'MPL1_EMPTY_'+(i+2)+'_'+(i+5011).toString(16).padStart(32,'0'))];
 const formula=combinedLedgerSpillFormulas({rawNew:names[0],detailNew:names[1],rawCombined:names[2],detailCombined:names[3],rawOldRows:1000,rawNewRows:1000,detailOldRows:1000,detailNewRows:1000});
 const requests=[template.ledgerCarrierBootstrapRequests('EXPENSE_RAW',ids[0],names[0],1000,markers[0]),template.ledgerCarrierBootstrapRequests('DETAIL',ids[1],names[1],1000,markers[1])];
 const manifest=[...names.map((title,i)=>({sheetId:ids[i],title,kind:i<2?'LEDGER':'VIEW',requestDigest:sha(JSON.stringify(i===0?requests[0]:i===1?requests[1]:i===2?formula.raw:formula.detail))}))];
 const manifestJson=JSON.stringify(manifest),digest=sha(manifestJson);
 const migration=fs.readFileSync(new URL('../migrations/0062_views_incident_recovery.sql',import.meta.url),'utf8');
 assert.match(migration,/bbdab8c97a741bb58ec0c740a86ef0ca898fb03da0e910c4b393270555b733c2/);
 sqlite.exec(migration.replace('bbdab8c97a741bb58ec0c740a86ef0ca898fb03da0e910c4b393270555b733c2',digest));
 sqlite.exec("INSERT INTO stable_workbook_claims VALUES('book','original','REVIEW','OPERATION','STABLE_DAILY_REVIEW','stamp','identity','created','updated')");
 sqlite.exec("INSERT INTO continuous_cutover_operator(spreadsheet_id,operation_token,origin,original_fingerprint,state,created_at,updated_at) VALUES('book','original','PREWRITE_REVIEW','"+sha('original')+"','STARTING','created','updated')");
 sqlite.exec("UPDATE stable_workbook_claims SET state='HELD'");
 sqlite.exec("UPDATE continuous_cutover_operator SET state='HELD'");
 sqlite.prepare("INSERT INTO continuous_report_cutover_attempts(spreadsheet_id,stage,operation_token,manifest_digest,manifest_json,cell_count,state,created_at,updated_at) VALUES('book','VIEWS','original',?,?,4,'IN_FLIGHT','created','updated')").run(digest,manifestJson);
 sqlite.exec("UPDATE continuous_cutover_operator SET state='VIEWS'");
 sqlite.exec("UPDATE continuous_cutover_operator SET state='REVIEW'");
 sqlite.exec("UPDATE stable_workbook_claims SET state='REVIEW',review_reason='CONTINUOUS_CUTOVER_REVIEW'");
 const DB={prepare(sql){const statement=sqlite.prepare(sql);let args=[];return{bind(...v){args=v;return this},async first(){return statement.get(...args)??null},async run(){const r=statement.run(...args);return{success:true,meta:{changes:Number(r.changes)}}},_sql:sql,_stmt:statement,_args:()=>args}},async batch(statements){sqlite.exec('BEGIN');const results=[];try{for(const s of statements){if(s._sql.trim().startsWith('SELECT')){results.push({success:true,results:[s._stmt.get(...s._args())]});}else{const r=s._stmt.run(...s._args());results.push({success:true,meta:{changes:Number(r.changes)}})}}sqlite.exec('COMMIT');return results;}catch(e){sqlite.exec('ROLLBACK');throw e}}};
 const env={DB,GOOGLE_SPREADSHEET_ID:'book',GOOGLE_SERVICE_ACCOUNT_EMAIL:'test',GOOGLE_PRIVATE_KEY_BASE64:'test',STABLE_PHASE1_ENABLED:'true',STABLE_RECOVERY_GATE_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CONTINUOUS_REPORT_CUTOVER_ENABLED:'true',CONTINUOUS_CUTOVER_OPERATOR_ENABLED:'true',CONTINUOUS_VIEWS_INCIDENT_RECOVERY_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'false',CONTINUOUS_DAILY_SHEET:'รายวันต่อเนื่อง_แบบร่าง',CONTINUOUS_DAILY_SHEET_ID:'3',CONTINUOUS_RAW_SHEET:names[0],CONTINUOUS_RAW_SHEET_ID:String(ids[0]),CONTINUOUS_DETAIL_SHEET:names[1],CONTINUOUS_DETAIL_SHEET_ID:String(ids[1]),CONTINUOUS_RAW_VIEW_ID:String(ids[2]),CONTINUOUS_DETAIL_VIEW_ID:String(ids[3])};
 const properties=[{sheetId:1,title:'V52_EXPENSE_RAW',rowCount:1000,columnCount:26},{sheetId:2,title:'รายละเอียดการซื้อ',rowCount:1000,columnCount:20},{sheetId:3,title:env.CONTINUOUS_DAILY_SHEET,rowCount:1000,columnCount:29},...names.map((title,i)=>({sheetId:ids[i],title,rowCount:i<2?1000:9999,columnCount:i<2?26:i===2?18:20})),...Array.from({length:93},(_,i)=>({sheetId:300+i,title:'other_'+i,rowCount:10,columnCount:2}))];
 assert.equal(properties.length,100);
 let drift=null;
 const ledger=(projection,index)=>{
  const headers=projection==='EXPENSE_RAW'?[...template.rawCarrierHeaders,'Sales_Addback_Basis']:template.detailCarrierHeaders;
  const f=[headers],e=[headers];
  for(let row=2;row<=1000;row++){const fa=[],ea=[],forms=template.ledgerCarrierFormulas(projection,row);
   for(const [c,form] of Object.entries(forms)){fa[Number(c)]=form;ea[Number(c)]='';}
   fa[25]=markers[index][row-2];ea[25]=fa[25];f.push(fa);e.push(ea);
  }
  return{f,e};
 };
 const originals={props:client.getSpreadsheetSheetProperties,formula:client.batchGetSheetFormulaValues,effective:client.batchGetSheetEffectiveSerialValues,values:client.batchGetSheetValues,paused:notice.stableNoticePaused};
 client.getSpreadsheetSheetProperties=async()=>properties.map(x=>({...x}));
 client.batchGetSheetFormulaValues=async()=>{
  const a=ledger('EXPENSE_RAW',0),b=ledger('DETAIL',1);
  if(drift==='marker')a.f[2][25]='MPL1_EMPTY_3_00000000000000000000000000000000';
  const raw=drift==='view'?'=BROKEN()':formula.raw.replaceAll("'V52_EXPENSE_RAW'","V52_EXPENSE_RAW");
  return[a.f,b.f,[[raw]],[[formula.detail]]];
 };
 client.batchGetSheetEffectiveSerialValues=async()=>[ledger('EXPENSE_RAW',0).e,ledger('DETAIL',1).e];
 client.batchGetSheetValues=async()=>[[['Expense_ID']],[['Purchase_Item_ID']]];
 notice.stableNoticePaused=async()=>drift!=='notice';
 return{sqlite,env,digest,setDrift:x=>drift=x,close(){Object.assign(client,{getSpreadsheetSheetProperties:originals.props,batchGetSheetFormulaValues:originals.formula,batchGetSheetEffectiveSerialValues:originals.effective,batchGetSheetValues:originals.values});notice.stableNoticePaused=originals.paused;sqlite.close()}};
}
const readState=h=>({claim:h.sqlite.prepare('SELECT state FROM stable_workbook_claims').get().state,operator:h.sqlite.prepare('SELECT state FROM continuous_cutover_operator').get().state,view:h.sqlite.prepare('SELECT state FROM continuous_report_cutover_attempts').get().state,recovery:h.sqlite.prepare('SELECT count(*) AS n FROM continuous_views_incident_recovery').get().n});
test('Google quote-only normalization accepted, exact manifest-bound recovery atomic',async()=>{
 const h=fixture();try{assert.equal(bootstrap.viewFormulaEquivalent('=V52_EXPENSE_RAW!A1', "='V52_EXPENSE_RAW'!A1"),true);
 assert.equal(bootstrap.viewFormulaEquivalent('=V52_EXPENSE_RAW!A2', "='V52_EXPENSE_RAW'!A1"),false);
 assert.deepEqual(await recovery.reconcileContinuousViewsIncident(h.env),{stage:'VIEWS',reconciled:true});
 assert.deepEqual(readState(h),{claim:'HELD',operator:'HELD',view:'VERIFIED',recovery:1});
 await assert.rejects(()=>recovery.reconcileContinuousViewsIncident(h.env),/NOT_VERIFIED/);
 assert.deepEqual(readState(h),{claim:'HELD',operator:'HELD',view:'VERIFIED',recovery:1});
 }finally{h.close()}
});
test('provider mismatch, marker drift or stale notice never alters claim or VIEWS intent',async()=>{
 for(const failure of ['view','marker','notice']){
  const h=fixture();try{h.setDrift(failure);await assert.rejects(()=>recovery.reconcileContinuousViewsIncident(h.env),/NOT_VERIFIED/);
  assert.deepEqual(readState(h),{claim:'REVIEW',operator:'REVIEW',view:'IN_FLIGHT',recovery:0});}finally{h.close()}
 }
});
test('processing work or wrong feature flag prevents reconciliation',async()=>{
 for(const mode of ['processing','flag']){
  const h=fixture();try{
   if(mode==='processing')h.sqlite.exec("INSERT INTO sync_jobs VALUES('PROCESSING')");else h.env.CONTINUOUS_VIEWS_INCIDENT_RECOVERY_ENABLED='false';
   await assert.rejects(()=>recovery.reconcileContinuousViewsIncident(h.env),/NOT_VERIFIED/);
   assert.equal(h.sqlite.prepare('SELECT count(*) n FROM continuous_views_incident_recovery').get().n,0);
  }finally{h.close()}
 }
});
test('migration blocks absent evidence, audit deletion, and unrelated REVIEW -> HELD transition',()=>{
 const h=fixture();try{
  assert.throws(()=>h.sqlite.exec("UPDATE continuous_cutover_operator SET state='HELD' WHERE spreadsheet_id='book'"),/transition rejected/);
  assert.throws(()=>h.sqlite.exec("DELETE FROM continuous_report_cutover_attempts"),/history retained/);
  assert.throws(()=>h.sqlite.exec("INSERT INTO continuous_views_incident_recovery VALUES('book','original','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','now','VERIFIED')"),/preimage rejected/);
  assert.deepEqual(readState(h),{claim:'REVIEW',operator:'REVIEW',view:'IN_FLIGHT',recovery:0});
 }finally{h.close()}
});
test('deterministic reconstruction rejects marker changes and reproduces original request exactly',()=>{
 const markers=Array.from({length:999},(_,i)=>'MPL1_EMPTY_'+(i+2)+'_'+(i+1).toString(16).padStart(32,'0'));
 const original=template.ledgerCarrierBootstrapRequests('EXPENSE_RAW',17,'new',1000,markers);
 const reconstructed=template.ledgerCarrierBootstrapRequests('EXPENSE_RAW',17,'new',1000,[...markers]);
 assert.equal(JSON.stringify(original),JSON.stringify(reconstructed));
 assert.throws(()=>template.ledgerCarrierBootstrapRequests('EXPENSE_RAW',17,'new',1000,markers.slice(1)),/LEDGER_MARKER_INVALID/);
});
