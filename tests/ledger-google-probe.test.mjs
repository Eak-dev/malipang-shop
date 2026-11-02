import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {parseLedgerGoogleSnapshot,createLedgerGoogleUatProbe,createExpenseRawProductionProbe}=require('../dist/sheets/ledger-google-probe.js');
const auth=require('../dist/sheets/google-auth.js');
const client=require('../dist/sheets/client.js');
const original={fetch:globalThis.fetch,token:auth.getGoogleAccessToken};
test.afterEach(()=>{globalThis.fetch=original.fetch;auth.getGoogleAccessToken=original.token});
const identity={kind:'EXPENSE',sheetId:7,entityId:'expense-1'};
const witness={metadataId:44,metadataKey:'E',sheetId:7,dimension:'ROWS',startIndex:2,endIndex:3,visibility:'DOCUMENT'};
const cell=value=>({userEnteredValue:{stringValue:value}});
const fixture=()=>({sheets:[{properties:{sheetId:7,title:'Ledger',gridProperties:{rowCount:4,columnCount:17}},data:[{rowData:[{values:[cell('Expense_ID')]},{},{values:[cell('expense-1'),cell('2026-10-01')]}]}]}]});
const parse=x=>parseLedgerGoogleSnapshot(x,'Ledger',identity,witness);
test('whole-grid parser preserves row identity and sparse empty cell states',()=>{
  const result=parse(fixture());assert.equal(result.identityRows.length,4);assert.equal(result.identityRows[2][0],'expense-1');assert.equal(result.guard.observed[1].entered,'2026-10-01');assert.equal(result.guard.observed[2].entered,null);assert.deepEqual(result.guard.fields,[1,2,3,4,5,6,7]);
});
test('duplicate, moved, formula identity, bad bounds, and ambiguous shape hold',()=>{
  for(const mutate of [
    x=>x.sheets[0].data[0].rowData[1]={values:[cell('expense-1')]},
    x=>x.sheets[0].data[0].rowData[2].values[0]=cell('wrong'),
    x=>x.sheets[0].data[0].rowData[2].values[0]={userEnteredValue:{formulaValue:'="expense-1"'}},
    x=>x.sheets[0].properties.gridProperties.rowCount=10001,
    x=>x.sheets[0].data.push({}),
    x=>x.sheets[0].data[0].startRow=1,
  ]){const x=fixture();mutate(x);assert.throws(()=>parse(x));}
});
test('protection or merges block even if outside the target',()=>{
  for(const property of ['protectedRanges','merges']){const x=fixture();x.sheets[0][property]=[{}];assert.throws(()=>parse(x),/UNSAFE/);}
});
test('read captures notes, validation and formula for later guard rejection',()=>{
  const x=fixture();x.sheets[0].data[0].rowData[2].values.push({userEnteredValue:{formulaValue:'=1'},note:'manual',dataValidation:{}});
  assert.deepEqual(parse(x).guard.observed[2],{entered:null,formula:'=1',note:'manual',hasValidation:true});
});
test('probe rejects purchase details pending coordination',()=>{
  assert.throws(()=>createLedgerGoogleUatProbe({},'Ledger',{...identity,kind:'PURCHASE_DETAILS'},44),/INVALID/);
});
const env={RUNTIME_MODE:'shadow',GOOGLE_SPREADSHEET_ID:'synthetic',SHEETS_LEDGER_UAT_SPREADSHEET_ID:'synthetic',SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID:'production',SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE:'true'};
const metadata=()=>({metadataId:44,metadataKey:'E',visibility:'DOCUMENT',location:{dimensionRange:{sheetId:7,dimension:'ROWS',startIndex:2,endIndex:3}}});
test('authenticated probe reads metadata-grid-metadata and isolates UAT',async()=>{
  let calls=[];auth.getGoogleAccessToken=async()=> 'synthetic-token';
  globalThis.fetch=async(url,init)=>{calls.push([String(url),new Headers(init.headers).get('authorization')]);return new Response(JSON.stringify(calls.length===2?fixture():metadata()));};
  const probe=createLedgerGoogleUatProbe(env,'Ledger',identity,44);const result=await probe.read();
  assert.equal(result.witness.metadataId,44);assert.equal(calls.length,3);assert.ok(calls.every(c=>c[1]==='Bearer synthetic-token'));assert.match(calls[1][0],/ranges=/);
  calls=[];await assert.rejects(createLedgerGoogleUatProbe({...env,GOOGLE_SPREADSHEET_ID:'production'},'Ledger',identity,44).read(),/READER_DISABLED/);assert.equal(calls.length,0);
});
test('metadata movement between provider reads and unsafe upstream error hold',async()=>{
  let calls=0;auth.getGoogleAccessToken=async()=> 'synthetic-token';
  globalThis.fetch=async()=>{calls++;const m=metadata();if(calls===3)m.location.dimensionRange.startIndex=3;return new Response(JSON.stringify(calls===2?fixture():m));};
  await assert.rejects(createLedgerGoogleUatProbe(env,'Ledger',identity,44).read(),/METADATA_MOVED/);
  globalThis.fetch=async()=>new Response('secret upstream contents',{status:403});
  await assert.rejects(createLedgerGoogleUatProbe(env,'Ledger',identity,44).read(),e=>e.message==='LEDGER_METADATA_READER_UNAVAILABLE'&&!e.message.includes('secret'));
  globalThis.fetch=async()=>new Response('{secret upstream invalid JSON',{status:200});
  await assert.rejects(createLedgerGoogleUatProbe(env,'Ledger',identity,44).read(),e=>e.message==='LEDGER_METADATA_READER_UNAVAILABLE'&&!e.message.includes('secret'));
  globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.error(new Error('secret stream failure'))}}),{status:200});
  await assert.rejects(createLedgerGoogleUatProbe(env,'Ledger',identity,44).read(),e=>e.message==='LEDGER_METADATA_READER_UNAVAILABLE'&&!e.message.includes('secret'));
});
test('candidate production reader is read-only and disabled until all flags are explicit',async()=>{
  let calls=0;const urls=[];auth.getGoogleAccessToken=async()=> 'synthetic-token';globalThis.fetch=async(url,init)=>{assert.equal(init.method,'GET');urls.push(new URL(String(url)));calls++;return new Response(JSON.stringify(calls===2?fixture():metadata()))};
  const candidate={RUNTIME_MODE:'production',GOOGLE_SPREADSHEET_ID:'synthetic',SHEET_EXPENSE_RAW:'Ledger',SHEET_EXPENSE_DAILY:'Daily',EXPENSE_STABLE_PROJECTION_ENABLED:'true',DAILY_LEGACY_WRITER_GATE_ENABLED:'true',RAW_FULL_IDENTITY_WRITER_ENABLED:'true'};
  await assert.rejects(createExpenseRawProductionProbe({...candidate,RAW_FULL_IDENTITY_WRITER_ENABLED:undefined},'Ledger',identity,44).read(),/READER_DISABLED/);assert.equal(calls,0);
  assert.throws(()=>createExpenseRawProductionProbe(candidate,'Other',identity,44),/PROBE_INVALID/);
  assert.throws(()=>createExpenseRawProductionProbe(candidate,'Ledger',{...identity,kind:'PERSONAL_USE'},44),/PROBE_INVALID/);
  const result=await createExpenseRawProductionProbe(candidate,'Ledger',identity,44).read();assert.equal(result.witness.metadataId,44);assert.equal(calls,3);
  assert.equal(urls[1].searchParams.get('ranges'),"'Ledger'!A1:Q10000");assert.equal(urls[0].searchParams.get('fields'),'metadataId,metadataKey,visibility,location');
  await assert.rejects(client.getRawIdentityProductionMetadata(candidate,'/other?fields=*'),/READER_INVALID/);assert.equal(calls,3);
});
