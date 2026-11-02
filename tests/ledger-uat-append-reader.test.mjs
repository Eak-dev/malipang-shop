import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const auth=require('../dist/sheets/google-auth.js');
const {readLedgerUatAppendSnapshot:read}=require('../dist/sheets/ledger-uat-append-reader.js');
const {buildLedgerUatAppendRequests:plan}=require('../dist/sheets/ledger-uat-append-planner.js');
const original={fetch:globalThis.fetch,token:auth.getGoogleAccessToken};
test.afterEach(()=>{globalThis.fetch=original.fetch;auth.getGoogleAccessToken=original.token});
const env={RUNTIME_MODE:'shadow',GOOGLE_SPREADSHEET_ID:'uat',SHEETS_LEDGER_UAT_SPREADSHEET_ID:'uat',SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID:'production',SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE:'true',SHEET_EXPENSE_RAW:'Raw'};
const props={sheetId:7,title:'Raw',gridProperties:{rowCount:4,columnCount:20}};
const base=()=>({sheets:[{properties:structuredClone(props)}]});
const grid=()=>({sheets:[{properties:structuredClone(props),data:[{rowData:[{values:[{userEnteredValue:{stringValue:'Expense_ID'}}]},{values:[{userEnteredValue:{stringValue:'existing'}}]},{values:[{}, {note:'manual note'}]}]}]}]});
const responses=(sequence)=>{let calls=0;auth.getGoogleAccessToken=async()=> 'token';globalThis.fetch=async()=>new Response(JSON.stringify(sequence[calls++]));return()=>calls;};
test('authenticated complete grid reader feeds UAT-only planner and preserves annotations',async()=>{
  const calls=responses([base(),grid()]);const snapshot=await read(env,'Raw',7);
  assert.equal(calls(),2);assert.equal(snapshot.rows.length,4);assert.equal(snapshot.rows[0].length,20);assert.equal(snapshot.rows[2][1].note,'manual note');
  const values=['new','date','description',1,...Array(13).fill('')],requests=plan(env,'Raw',{kind:'EXPENSE',sheetId:7,entityId:'new'},99,values,snapshot);
  assert.equal(requests[0].insertDimension.range.startIndex,3);
});
test('grid changes between reads hold; protections survive into the planner',async()=>{
  const changed=grid();changed.sheets[0].properties.gridProperties.rowCount=5;responses([base(),changed]);await assert.rejects(read(env,'Raw',7),/GRID_CHANGED/);
  const protectedGrid=grid();protectedGrid.sheets[0].protectedRanges=[{warningOnly:true}];responses([base(),protectedGrid]);const snapshot=await read(env,'Raw',7);assert.equal(snapshot.hasProtectedRanges,true);
  assert.throws(()=>plan(env,'Raw',{kind:'EXPENSE',sheetId:7,entityId:'new'},99,['new',...Array(16).fill('')],snapshot),/GRID_INVALID/);
});
test('oversized grid, ambiguous shape or wrong sheet holds',async()=>{
  const large=base();large.sheets[0].properties.gridProperties.rowCount=2500;const calls=responses([large]);await assert.rejects(read(env,'Raw',7),/GRID_LIMIT/);assert.equal(calls(),1);
  const invalid=grid();invalid.sheets[0].data[0].startColumn=1;responses([base(),invalid]);await assert.rejects(read(env,'Raw',7),/READ_INVALID/);
  responses([base()]);await assert.rejects(read(env,'Raw',8),/SHEET_INVALID/);
});
test('production configuration is rejected before HTTP fetch',async()=>{
  let calls=0;globalThis.fetch=async()=>{calls++;throw Error('unexpected');};auth.getGoogleAccessToken=async()=> 'token';
  await assert.rejects(read({...env,GOOGLE_SPREADSHEET_ID:'production'},'Raw',7),/READER_DISABLED/);assert.equal(calls,0);
});
