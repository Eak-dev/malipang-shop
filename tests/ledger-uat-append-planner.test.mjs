import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {buildLedgerUatAppendRequests:plan}=require('../dist/sheets/ledger-uat-append-planner.js');
const {RAW_PROJECTION_HEADERS}=require('../dist/sheets/raw-projection.js');
const env={RUNTIME_MODE:'shadow',GOOGLE_SPREADSHEET_ID:'uat',SHEETS_LEDGER_UAT_SPREADSHEET_ID:'uat',SHEETS_LEDGER_PRODUCTION_SPREADSHEET_ID:'production',SHEETS_LEDGER_ANCHORED_WRITE_PROTOTYPE:'true',SHEET_EXPENSE_RAW:'Raw'};
const identity={kind:'EXPENSE',sheetId:7,entityId:'synthetic-id'};
const blank=()=>({entered:null,formula:null,note:null,hasValidation:false});
const snapshot=()=>{const rows=Array.from({length:4},()=>Array.from({length:20},blank));RAW_PROJECTION_HEADERS.EXPENSE.forEach((h,i)=>rows[0][i].entered=h);rows[1][0].entered='existing';return{sheetId:7,rowCount:4,columnCount:20,rows,hasProtectedRanges:false,hasMerges:false}};
const values=()=>['synthetic-id','2026-10-01','=not-a-formula',42,...Array(13).fill('')];
const make=(s=snapshot(),e=env,v=values(),id=identity)=>plan(e,'Raw',id,44,v,s);
test('inserts directly after last occupied row and anchors same row within one batch',()=>{
  const requests=make();assert.equal(requests.length,3);
  assert.deepEqual(requests[0].insertDimension.range,{sheetId:7,dimension:'ROWS',startIndex:2,endIndex:3});
  assert.equal(requests[1].updateCells.start.rowIndex,2);assert.deepEqual(requests[1].updateCells.rows[0].values[2],{userEnteredValue:{stringValue:'=not-a-formula'}});
  assert.equal(requests[1].updateCells.rows[0].values.length,20);
  assert.deepEqual(requests[2].createDeveloperMetadata.developerMetadata.location.dimensionRange,{sheetId:7,dimension:'ROWS',startIndex:2,endIndex:3});
});
test('last populated trailing row grows grid, and note/formula/validation count as occupied',()=>{
  for(const mutate of [c=>c.entered='manual',c=>c.note='manual',c=>c.formula='=1',c=>c.hasValidation=true]){const s=snapshot();mutate(s.rows[3][19]);assert.equal(make(s)[0].insertDimension.range.startIndex,4);}
});
test('duplicate identity, identity formula, uncertain grid, protection, merges and wrong header hold',()=>{
  for(const mutate of [s=>s.rows[3][0].entered='synthetic-id',s=>s.rows[2][0].formula='="unknown"',s=>s.rows.pop(),s=>s.rows[2].pop(),s=>s.hasMerges=true,s=>s.hasProtectedRanges=true,s=>s.rows[0][0].entered='Wrong',s=>{[s.rows[0][2],s.rows[0][3]]=[s.rows[0][3],s.rows[0][2]]},s=>s.rowCount=10000]){const s=snapshot();mutate(s);assert.throws(()=>make(s));}
});
test('untrusted config, invalid values or mismatched identity never produce requests',()=>{
  assert.throws(()=>make(snapshot(),{...env,GOOGLE_SPREADSHEET_ID:'production'}),/DISABLED/);
  assert.throws(()=>make(snapshot(),{...env,RUNTIME_MODE:'production'}),/DISABLED/);
  const bad=values();bad[3]={};assert.throws(()=>make(snapshot(),env,bad),/VALUE_INVALID/);
  assert.throws(()=>make(snapshot(),env,values(),{...identity,entityId:'different'}),/INVALID/);
});
test('append refuses a full 10000-row grid that would exceed readback limit',()=>{
  const s=snapshot();s.rows=Array.from({length:10000},()=>Array.from({length:20},blank));s.rows[0][0].entered='Expense_ID';s.rowCount=10000;
  assert.throws(()=>make(s),/GRID_INVALID/);
});
test('append refuses an oversized complete grid even below row limit',()=>{
  const s=snapshot();s.rows=Array.from({length:2500},()=>Array.from({length:20},blank));s.rows[0][0].entered='Expense_ID';s.rowCount=2500;
  assert.throws(()=>make(s),/GRID_INVALID/);
});
