import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const operator=require('../dist/sheets/monthly-report-operator.js');
const authority=require('../dist/sheets/monthly-incident-authority.js');
const auth=require('../dist/sheets/google-auth.js');
const client=require('../dist/sheets/client.js');
const notice=require('../dist/sheets/stable-edit-notice.js');
const overlay=require('../dist/sheets/monthly-incident-overlay.js');
const {readSheetsBody}=require('../dist/sheets/bounded-response.js');
const worker='synthetic-worker-version',hash=createHash('sha256').update(worker).digest('hex');

function testGrid(validFormat=true){
 const matrix=()=>Array.from({length:6},()=>Array(29).fill(null));
 const formula=matrix(),formats=matrix();formula[5][24]='synthetic';
 if(validFormat){for(let c=4;c<=18;c++)formats[5][c]={numberFormat:{type:'NUMBER',pattern:'#,##0.00'}};formats[5][20]={numberFormat:{type:'DATE',pattern:'dd/MM/yyyy'}};}
 return {rows:6,columns:29,formula,effective:matrix(),notes:matrix(),formats,validations:matrix(),extras:matrix(),structure:{sheetId:2,title:'รายวันต่อเนื่อง_แบบร่าง',properties:{},mergedRanges:[],protectedRanges:[],conditionalFormats:[],filterViews:[],basicFilter:null,rowMetadata:Array(6).fill(null),columnMetadata:Array(29).fill(null)}};
}

test('bounded Sheets reader accepts the limit and rejects a larger synthetic response',async()=>{
 const chunk=new Uint8Array(1024*1024);
 const response=count=>{let remaining=count;return new Response(new ReadableStream({pull(controller){if(remaining-- > 0)controller.enqueue(chunk);else controller.close()}}))};
 assert.equal((await readSheetsBody(response(16),10000,'synthetic')).byteLength,16*1024*1024);
 await assert.rejects(readSheetsBody(response(17),10000,'synthetic'),/SHEETS_RESPONSE_TOO_LARGE/);
});

test('PREVIEW identifies the failing read-only stage without exposing exception text',async()=>{
 const original={authority:authority.readMonthlyIncidentAuthority,oauth:auth.createGoogleOAuthLease,info:client.getSheetGridInfo,grid:client.readMonthlyReportGrid,notice:notice.stableNoticePaused,overlay:overlay.verifyMonthlyIncidentOverlay,post:client.batchUpdateSpreadsheetWithReply};
 let mode='CONFIG',posts=0,queries=0;
 const db={prepare(sql){
  assert.match(sql,/^\s*SELECT\b/i);queries++;
  if(mode==='JOURNAL_ERROR')throw Error('private diagnostic detail');
  return {bind(){return this},async all(){if(sql.includes('FROM monthly_report_runs'))return {success:true,results:[]};if(sql.includes('FROM expense_events'))return {success:false,results:[]};throw Error('unexpected SQL')},async first(){return {unresolved:mode==='UNRESOLVED'?1:0,verified:0,marker:null,integrity:1}}};
 }};
 const env={DB:db,GOOGLE_SPREADSHEET_ID:'book',MONTHLY_REPORT_OPERATOR_ENABLED:'true',STABLE_PHASE1_ENABLED:'true',CONTINUOUS_DAILY_ENABLED:'true',STABLE_SHEETS_PACING_ENABLED:'true',CF_VERSION_METADATA:{id:worker}};
 try{
  authority.readMonthlyIncidentAuthority=async()=>mode==='INCIDENT'?null:{fingerprint:'synthetic',row:{sheet_name:'synthetic',sheet_id:2,target_row:6}};
  auth.createGoogleOAuthLease=async()=>{if(mode==='OAUTH_HTTP')throw new auth.GoogleOAuthHttpError(403);return {tokenFor(){return 'synthetic'}}};
  client.getSheetGridInfo=async()=>{if(mode==='METADATA_ERROR')throw Error('private diagnostic detail');return {sheetId:2,rowCount:6,columnCount:29}};
  client.readMonthlyReportGrid=async()=>{if(mode==='GRID_ERROR')throw new client.SheetsHttpError(400,'private provider body');if(mode==='GRID_NESTED')throw new client.MonthlyGridReadError('GRID_FULL_INITIAL',new client.SheetsHttpError(400,'Invalid field selection commentAnchors; private provider body'));if(mode==='GRID_FIELD_PATH')throw new client.MonthlyGridReadError('GRID_FULL_INITIAL',new client.SheetsHttpError(400,'Invalid field selection sheets/chipRuns'));if(mode==='GRID_FIELD_DOT')throw new client.MonthlyGridReadError('GRID_FULL_INITIAL',new client.SheetsHttpError(400,'Invalid field selection sheets.chipRuns'));if(mode==='GRID_FIELD_PUNCT')throw new client.MonthlyGridReadError('GRID_FULL_INITIAL',new client.SheetsHttpError(400,'Invalid field selection chipRuns.'));if(mode==='GRID_UNKNOWN_FIELD')throw new client.MonthlyGridReadError('GRID_FULL_INITIAL',new client.SheetsHttpError(400,'Invalid field selection privateData'));if(mode==='GRID_BIG')throw Error('SHEETS_RESPONSE_TOO_LARGE');return testGrid(mode!=='FORMAT')};
  notice.stableNoticePaused=async(_env,_stamp,_identity,_budget,_lease,strict)=>{if(mode==='NOTICE_ERROR'){if(strict)throw new client.SheetsHttpError(403,'private notice body');return false;}return mode!=='NOTICE'};overlay.verifyMonthlyIncidentOverlay=async()=>{if(mode==='CONFIG_DRIFT')env.STABLE_PHASE1_ENABLED='false';return mode!=='OVERLAY'};
  client.batchUpdateSpreadsheetWithReply=async()=>{posts++;throw Error('unexpected write')};
  const cases=[['CONFIG',{...env,MONTHLY_REPORT_OPERATOR_ENABLED:'false'},'CONFIG','CHECK_FAILED'],['INCIDENT',env,'INCIDENT','CHECK_FAILED'],['JOURNAL_ERROR',env,'JOURNAL','EXCEPTION'],['UNRESOLVED',env,'UNRESOLVED','CHECK_FAILED'],['OAUTH_HTTP',env,'OAUTH','HTTP'],['METADATA_ERROR',env,'SHEET_METADATA','EXCEPTION'],['GRID_ERROR',env,'GRID','HTTP'],['GRID_BIG',env,'GRID','BODY_TOO_LARGE'],['FORMAT',env,'FORMAT','CHECK_FAILED'],['NOTICE',env,'NOTICE','CHECK_FAILED'],['NOTICE_ERROR',env,'NOTICE','HTTP'],['OVERLAY',env,'INCIDENT_OVERLAY','CHECK_FAILED'],['CONFIG_DRIFT',env,'CONFIG','CHECK_FAILED'],['SOURCE',env,'SOURCE','CHECK_FAILED']];
  for(const [name,input,stage,cause] of cases){mode=name;const result=await operator.operateMonthlyReport(input,'PREVIEW',hash);assert.equal(result.status,'HELD',name);assert.equal(result.diagnostic.stage,stage,name);assert.equal(result.diagnostic.cause,cause,name);assert.doesNotMatch(JSON.stringify(result),/private|synthetic-worker-version/);if(cause==='HTTP')assert.equal(result.diagnostic.httpStatus,name==='GRID_ERROR'?400:403);env.STABLE_PHASE1_ENABLED='true';}
  mode='GRID_NESTED';assert.deepEqual((await operator.operateMonthlyReport(env,'PREVIEW',hash)).diagnostic,{stage:'GRID',cause:'HTTP',httpStatus:400,detail:'INVALID_FIELD',field:'commentAnchors',operation:'GRID_FULL_INITIAL'});
  mode='GRID_UNKNOWN_FIELD';const unknown=await operator.operateMonthlyReport(env,'PREVIEW',hash);assert.deepEqual(unknown.diagnostic,{stage:'GRID',cause:'HTTP',httpStatus:400,detail:'INVALID_FIELD',operation:'GRID_FULL_INITIAL'});assert.doesNotMatch(JSON.stringify(unknown),/privateData/);
  mode='GRID_FIELD_PATH';assert.deepEqual((await operator.operateMonthlyReport(env,'PREVIEW',hash)).diagnostic,{stage:'GRID',cause:'HTTP',httpStatus:400,detail:'INVALID_FIELD',operation:'GRID_FULL_INITIAL'});
  mode='GRID_FIELD_DOT';assert.deepEqual((await operator.operateMonthlyReport(env,'PREVIEW',hash)).diagnostic,{stage:'GRID',cause:'HTTP',httpStatus:400,detail:'INVALID_FIELD',operation:'GRID_FULL_INITIAL'});
  mode='GRID_FIELD_PUNCT';assert.deepEqual((await operator.operateMonthlyReport(env,'PREVIEW',hash)).diagnostic,{stage:'GRID',cause:'HTTP',httpStatus:400,detail:'INVALID_FIELD',field:'chipRuns',operation:'GRID_FULL_INITIAL'});
  assert.ok(queries>0);assert.equal(posts,0);
  for(const name of ['GRID_ERROR','NOTICE_ERROR']){mode=name;assert.deepEqual(await operator.operateMonthlyReport(env,'APPEND_ONE',hash,'a'.repeat(64)),{status:'HELD'});assert.deepEqual(await operator.operateMonthlyReport(env,'INSPECT',hash),{status:'HELD'});}assert.equal(posts,0);
 }finally{authority.readMonthlyIncidentAuthority=original.authority;auth.createGoogleOAuthLease=original.oauth;client.getSheetGridInfo=original.info;client.readMonthlyReportGrid=original.grid;notice.stableNoticePaused=original.notice;overlay.verifyMonthlyIncidentOverlay=original.overlay;client.batchUpdateSpreadsheetWithReply=original.post;}
});
