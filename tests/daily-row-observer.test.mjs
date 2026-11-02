import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {verifyDailyEvidence}=require('../dist/sheets/daily-row-observer.js');
const {sha256Hex}=require('../dist/shared/ids.js');
async function fixture(){
 const headers=[['heading'],['','','','','','','','เงินโอน'],['','','','','','','NON-FIXED']],digest=await sha256Hex(new TextEncoder().encode(JSON.stringify(headers)).buffer);
 const rows=Array.from({length:20},()=>[]);rows[4]=[2026];rows[5]=['',10,'','รายรับทั้งหมดในบัญชี'];rows[15]=['รวม',10];
 const formulas={8:'=SUM(F10:H10)',9:'=J9-I10',17:'=SUM(K10:Q10)',18:'=J10-R10',20:'=DATE($A$5,B10,C10)'};
 const cells=Array.from({length:21},()=>({}));for(const [i,f] of Object.entries(formulas))cells[Number(i)]={userEnteredValue:{formulaValue:f},effectiveValue:{numberValue:0}};
 const marker={metadataId:11,visibility:'DOCUMENT',metadataKey:'malipang_expense_daily',metadataValue:'exp_test',sheetId:1,rowIndex:9};
 const sheet={properties:{sheetId:1,title:'daily',gridProperties:{rowCount:20,columnCount:25}},protectedRanges:[{range:{sheetId:1},requestingUserCanEdit:true,editors:{users:['worker@example.org']}}]};
 return {e:{sheet,target:{properties:{sheetId:1,title:'daily'},data:[{startRow:9,rowData:[{values:cells}]}]},rows,headers,markers:[marker],markerById:marker},w:{sheetTitle:'daily',sheetId:1,rowNumber:10,metadataId:11,expenseId:'exp_test',postingDate:'2026-10-10',paymentKey:'transfer',serviceAccount:'worker@example.org',expectedHeaderDigest:digest,expectedFormulas:formulas}};
}
test('validated 25-column bounded row allows all five trusted calculated columns',async()=>{const {e,w}=await fixture();const o=await verifyDailyEvidence(e,w);assert.ok(o);assert.equal(o.observedColumnCount,25);assert.equal(o.formulas[9],'=J9-I10');assert.equal(o.formulas[18],'=J10-R10');assert.equal(o.values[24],'')});
test('formula substitutions, error values, spill values, and occupied tail all fail closed',async()=>{for(const kind of ['formula','error','spill','tail','inputFormula']){const {e,w}=await fixture(),c=e.target.data[0].rowData[0].values;if(kind==='formula')c[9].userEnteredValue.formulaValue='=999';if(kind==='error')c[8].effectiveValue={errorValue:{type:'REF'}};if(kind==='spill')c[6]={effectiveValue:{numberValue:5}};if(kind==='tail')c[24]={userEnteredValue:{stringValue:'occupied'},effectiveValue:{stringValue:'occupied'}};if(kind==='inputFormula')c[7]={userEnteredValue:{formulaValue:'=0'},effectiveValue:{numberValue:0}};assert.equal(await verifyDailyEvidence(e,w),null,kind)}});
test('duplicate marker, wrong id, moved row and metadata row collision are held',async()=>{for(const kind of ['duplicate','id','move','rowcollision','foreign','project-marker']){const {e,w}=await fixture();if(kind==='duplicate')e.markers.push({...e.markers[0],metadataId:12,rowIndex:11});if(kind==='id')e.markerById.metadataId=12;if(kind==='move')e.target.data[0].startRow=10;if(kind==='rowcollision')e.markers.push({...e.markers[0],metadataId:12,metadataValue:'exp_other'});if(kind==='foreign')e.markers.push({...e.markers[0],metadataId:12,metadataKey:'foreign',metadataValue:''});if(kind==='project-marker')e.markers[0].visibility='PROJECT';assert.equal(await verifyDailyEvidence(e,w),null,kind)}});
test('unsafe protections, wrong year/month, incomplete range and broken block are held',async()=>{for(const kind of ['unprotected','warning','another-editor','hole','short-grid','range','year','month','duplicate-month','header']){const {e,w}=await fixture(),p=e.sheet.protectedRanges[0];if(kind==='unprotected')e.sheet.protectedRanges=[];if(kind==='warning')p.warningOnly=true;if(kind==='another-editor')p.editors.users.push('other@example.org');if(kind==='hole')p.unprotectedRanges=[{}];if(kind==='short-grid')e.sheet.properties.gridProperties.columnCount=24;if(kind==='range')e.target.data[0].startColumn=1;if(kind==='year')e.rows[4][0]=2025;if(kind==='month')w.postingDate='2026-09-10';if(kind==='duplicate-month'){e.rows[16]=['',10,'','รายรับทั้งหมดในบัญชี'];e.rows[19]=['รวม',10]}if(kind==='header')e.headers[0][0]='changed';assert.equal(await verifyDailyEvidence(e,w),null,kind)}});

test('live adapter requests bounded target A:Y and two independent observations',async()=>{
 const {e,w}=await fixture(),auth=require('../dist/sheets/google-auth.js'),originalAuth=auth.getGoogleAccessToken,originalFetch=globalThis.fetch;
 const {observeDailyRow}=require('../dist/sheets/daily-row-observer.js');auth.getGoogleAccessToken=async()=> 'synthetic-token';let calls=0;
 const m={metadataId:11,visibility:'DOCUMENT',metadataKey:'malipang_expense_daily',metadataValue:'exp_test',location:{dimensionRange:{sheetId:1,dimension:'ROWS',startIndex:9,endIndex:10}}};
 globalThis.fetch=async(input,init)=>{calls++;const url=new URL(String(input));let json;
  if(url.pathname.endsWith('/developerMetadata:search')){const b=JSON.parse(init.body);assert.equal(b.dataFilters[0].developerMetadataLookup.locationType,'ROW');assert.equal(b.dataFilters[0].developerMetadataLookup.visibility,undefined);json={matchedDeveloperMetadata:[{developerMetadata:m}]};}
  else if(url.pathname.endsWith('/developerMetadata/11'))json=m;
  else if(url.pathname.endsWith('/values:batchGet')){assert.deepEqual(url.searchParams.getAll('ranges'),["'daily'!A1:D20","'daily'!A1:W3"]);json={valueRanges:[{values:e.rows},{values:e.headers}]};}
  else if(url.searchParams.has('ranges')){assert.deepEqual(url.searchParams.getAll('ranges'),["'daily'!A10:Y10"]);assert.match(url.searchParams.get('fields'),/userEnteredValue,effectiveValue/);json={sheets:[e.target]};}
  else json={sheets:[e.sheet]};
  return new Response(JSON.stringify(json),{status:200,headers:{'content-type':'application/json'}});
 };
 try{const result=await observeDailyRow({GOOGLE_SPREADSHEET_ID:'test',SHEET_EXPENSE_DAILY:'daily',GOOGLE_SERVICE_ACCOUNT_EMAIL:'worker@example.org',EXTERNAL_API_TIMEOUT_MS:'1000'},w);assert.ok(result);assert.equal(calls,10);}finally{auth.getGoogleAccessToken=originalAuth;globalThis.fetch=originalFetch;}
});

test('only target input cells need protection; missing or weak overlap fails',async()=>{
 const cols=[1,2,3,5,6,7,10,11,12,13,14,15,16,21,22],make=c=>({range:{sheetId:1,startRowIndex:9,endRowIndex:10,startColumnIndex:c,endColumnIndex:c+1},requestingUserCanEdit:true,editors:{users:['worker@example.org']}});
 const {e,w}=await fixture();e.sheet.protectedRanges=cols.map(make);assert.ok(await verifyDailyEvidence(e,w));
 e.sheet.protectedRanges=e.sheet.protectedRanges.filter((_,i)=>i!==0);assert.equal(await verifyDailyEvidence(e,w),null);
 e.sheet.protectedRanges=cols.map(make);e.sheet.protectedRanges.push({...make(1),warningOnly:true});assert.equal(await verifyDailyEvidence(e,w),null);
});

test('live reader refuses a caller-selected editor account before transport',async()=>{
 const {w}=await fixture(),auth=require('../dist/sheets/google-auth.js'),before=auth.getGoogleAccessToken,{readDailyEvidence}=require('../dist/sheets/daily-row-observer.js');let called=0;auth.getGoogleAccessToken=async()=>{called++;return 'synthetic'};
 try{assert.equal(await readDailyEvidence({GOOGLE_SPREADSHEET_ID:'test',SHEET_EXPENSE_DAILY:'daily',GOOGLE_SERVICE_ACCOUNT_EMAIL:'actual@example.org'},w),null);assert.equal(called,0)}finally{auth.getGoogleAccessToken=before}
});

test('oversized Sheets responses are discarded and cannot become positive evidence',async()=>{
 const {w}=await fixture(),auth=require('../dist/sheets/google-auth.js'),before=auth.getGoogleAccessToken,oldFetch=globalThis.fetch,{readDailyEvidence}=require('../dist/sheets/daily-row-observer.js');
 auth.getGoogleAccessToken=async()=> 'synthetic';globalThis.fetch=async()=>new Response('x'.repeat(4*1024*1024+1));
 try{assert.equal(await readDailyEvidence({GOOGLE_SPREADSHEET_ID:'test',SHEET_EXPENSE_DAILY:'daily',GOOGLE_SERVICE_ACCOUNT_EMAIL:'worker@example.org'},w),null)}finally{auth.getGoogleAccessToken=before;globalThis.fetch=oldFetch}
});
test('upstream Sheets error bodies are not consumed by the read-only inspector',async()=>{
 const {w}=await fixture(),auth=require('../dist/sheets/google-auth.js'),before=auth.getGoogleAccessToken,oldFetch=globalThis.fetch,{readDailyEvidence}=require('../dist/sheets/daily-row-observer.js');let consumed=0,cancelled=0;
 auth.getGoogleAccessToken=async()=> 'synthetic';globalThis.fetch=async()=>({ok:false,status:500,headers:new Headers(),body:{cancel(){cancelled++;return new Promise(()=>{});}},text:async()=>{consumed++;throw new Error('must not read upstream body')}});
 try{assert.equal(await readDailyEvidence({GOOGLE_SPREADSHEET_ID:'test',SHEET_EXPENSE_DAILY:'daily',GOOGLE_SERVICE_ACCOUNT_EMAIL:'worker@example.org'},w),null);assert.equal(consumed,0);assert.equal(cancelled,1)}finally{auth.getGoogleAccessToken=before;globalThis.fetch=oldFetch}
});

async function existingFixture(){
 const {e,w}=await fixture(),cols=Array.from({length:25},(_,i)=>i).filter(i=>![8,9,17,18,20].includes(i));
 const expectedLiterals=Object.fromEntries(cols.map(i=>[i,'']));
 Object.assign(expectedLiterals,{1:10,2:10,3:'ค่าใช้จ่ายส่วนตัว',10:735,21:'บัญชีร้าน'});
 const cells=e.target.data[0].rowData[0].values;
 for(const i of cols){const v=expectedLiterals[i];if(v!=='')cells[i]={userEnteredValue:typeof v==='number'?{numberValue:v}:{stringValue:v},effectiveValue:typeof v==='number'?{numberValue:v}:{stringValue:v}};}
 return {e,w:{...w,expectedLiterals}};
}

test('existing mapped row needs every literal and preserves five approved formulas',async()=>{
 const {verifyExistingDailyEvidence,verifyDailyEvidence}=require('../dist/sheets/daily-row-observer.js'),{e,w}=await existingFixture();
 const actual=await verifyExistingDailyEvidence(e,w);assert.ok(actual);assert.equal(actual.values[10],735);assert.equal(actual.formulas[9],w.expectedFormulas[9]);assert.equal(await verifyDailyEvidence(e,w),null);
 for(const kind of ['missing-manifest','partial','wrong-literal','unknown-column','formula','error','blank-spill','mismatched-effective','input-formula','nan']){
  const {e,w}=await existingFixture(),cells=e.target.data[0].rowData[0].values;
  if(kind==='missing-manifest')delete w.expectedLiterals;
  if(kind==='partial')delete w.expectedLiterals[24];
  if(kind==='wrong-literal')w.expectedLiterals[10]=734;
  if(kind==='unknown-column')w.expectedLiterals[25]='';
  if(kind==='formula')cells[9].userEnteredValue.formulaValue='=0';
  if(kind==='error')cells[10].effectiveValue={errorValue:{type:'REF'}};
  if(kind==='blank-spill')cells[24]={effectiveValue:{stringValue:'spill'}};
  if(kind==='mismatched-effective')cells[10].effectiveValue={numberValue:734};
  if(kind==='input-formula')cells[10].userEnteredValue={formulaValue:'=735'};
  if(kind==='nan')w.expectedLiterals[10]=NaN;
  assert.equal(await verifyExistingDailyEvidence(e,w),null,kind);
 }
});

test('identical-looking row cannot substitute for unique, unmoved metadata identity',async()=>{
 const {verifyExistingDailyEvidence}=require('../dist/sheets/daily-row-observer.js');
 for(const kind of ['unmarked-lookalike','wrong-id','moved-marker','duplicate-identity','collision','weak-access']){
  const {e,w}=await existingFixture();
  if(kind==='unmarked-lookalike'){w.rowNumber=11;e.target.data[0].startRow=10;}
  if(kind==='wrong-id')w.metadataId=12;
  if(kind==='moved-marker'){e.markers[0].rowIndex=10;e.markerById={...e.markers[0]};}
  if(kind==='duplicate-identity')e.markers.push({...e.markers[0],metadataId:12,rowIndex:10});
  if(kind==='collision')e.markers.push({...e.markers[0],metadataId:12,metadataValue:'exp_other'});
  if(kind==='weak-access')e.sheet.protectedRanges[0].editors.users.push('another@example.org');
  assert.equal(await verifyExistingDailyEvidence(e,w),null,kind);
 }
});

test('existing observation independently fetches twice and rejects changed evidence',async()=>{
 const {e,w}=await existingFixture(),auth=require('../dist/sheets/google-auth.js'),originalAuth=auth.getGoogleAccessToken,originalFetch=globalThis.fetch;
 const {observeExistingDailyRow}=require('../dist/sheets/daily-row-observer.js');auth.getGoogleAccessToken=async()=> 'synthetic-token';let calls=0,reads=0,change=false;
 const m={metadataId:11,visibility:'DOCUMENT',metadataKey:'malipang_expense_daily',metadataValue:'exp_test',location:{dimensionRange:{sheetId:1,dimension:'ROWS',startIndex:9,endIndex:10}}};
 globalThis.fetch=async(input,init)=>{calls++;const url=new URL(String(input));let json;
  if(url.pathname.endsWith('/developerMetadata:search'))json={matchedDeveloperMetadata:[{developerMetadata:m}]};
  else if(url.pathname.endsWith('/developerMetadata/11'))json=m;
  else if(url.pathname.endsWith('/values:batchGet'))json={valueRanges:[{values:e.rows},{values:e.headers}]};
  else if(url.searchParams.has('ranges')){assert.deepEqual(url.searchParams.getAll('ranges'),["'daily'!A10:Y10"]);reads++;json={sheets:[structuredClone(e.target)]};if(change&&reads===2)json.sheets[0].data[0].rowData[0].values[10].effectiveValue.numberValue=734;}
  else json={sheets:[e.sheet]};
  return new Response(JSON.stringify(json),{status:200,headers:{'content-type':'application/json'}});
 };
 const env={GOOGLE_SPREADSHEET_ID:'test',SHEET_EXPENSE_DAILY:'daily',GOOGLE_SERVICE_ACCOUNT_EMAIL:'worker@example.org',EXTERNAL_API_TIMEOUT_MS:'1000'};
 try{assert.ok(await observeExistingDailyRow(env,w));assert.equal(calls,10);reads=0;change=true;assert.equal(await observeExistingDailyRow(env,w),null);}finally{auth.getGoogleAccessToken=originalAuth;globalThis.fetch=originalFetch;}
});
