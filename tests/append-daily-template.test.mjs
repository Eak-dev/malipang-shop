import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {encodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js');
const {appendDailyRowFormulas,appendDailyRowRequest,insertContinuousDailyRowRequests}=require('../dist/sheets/append-daily-template.js');
const payload=()=>encodeAtomicDailyPayload({expenseId:'exp_test',postingYear:2026,postingMonth:11,postingDay:15,description:'=literal',amountColumn:'H',amountSatang:123,category:'ingredients',wallet:'บัญชีร้าน'});

test('logical insertion grows the grid and shifts A:Y only, leaving the budget panel at AA:AC',()=>{
 const requests=insertContinuousDailyRowRequests(7,5,1000,payload());
 assert.equal(requests.length,2);
 assert.deepEqual(requests[0],{insertRange:{range:{sheetId:7,startRowIndex:4,endRowIndex:5,startColumnIndex:0,endColumnIndex:25},shiftDimension:'ROWS'}});
 assert.equal(requests[1].updateCells.start.rowIndex,4);assert.equal(requests[1].updateCells.fields,'userEnteredValue,userEnteredFormat.numberFormat');
 const cells=requests[1].updateCells.rows[0].values;assert.equal(cells.length,25);assert.deepEqual(cells[4],{userEnteredFormat:{numberFormat:{type:'NUMBER',pattern:'#,##0.00'}}});assert.deepEqual(cells[20].userEnteredFormat,{numberFormat:{type:'DATE',pattern:'dd/MM/yyyy'}});assert.deepEqual(cells[24],{userEnteredValue:{stringValue:payload()}});
});
test('a verified blank last row gets exactly one padding row before insertion',()=>{
 const requests=insertContinuousDailyRowRequests(7,5,1000,payload(),undefined,true);
 assert.equal(requests.length,3);assert.deepEqual(requests[0],{appendDimension:{sheetId:7,dimension:'ROWS',length:1}});assert.ok(requests[1].insertRange);assert.ok(requests[2].updateCells);
});

test('carrier formulas refer to their current row and preserve absolute budget references',()=>{
 const f=appendDailyRowFormulas();assert.ok(f[0].includes('INDEX(Y:Y,ROW())'));assert.ok(f[9].includes('$AA$4:$AA$243'));
 assert.ok(f[9].includes('$I$4:INDEX(I:I,ROW())'));assert.ok(f[20].includes('INDEX(C:C,ROW())'));
 assert.ok(Object.values(f).every(v=>!v.includes('4999')));
 const cells=appendDailyRowRequest(7,payload()).appendCells.rows[0].values;
 assert.deepEqual(cells[24],{userEnteredValue:{stringValue:payload()}});
 assert.ok(Object.values(cells).every(cell=>!cell.userEnteredValue||!('stringValue' in cell.userEnteredValue)||cell.userEnteredValue.stringValue===payload()));
});

test('invalid row, full grid and malformed carrier are rejected before any request',()=>{
 for(const [row,count] of [[3,1000],[4,1000],[1001,1000],[5,5000]])assert.throws(()=>insertContinuousDailyRowRequests(7,row,count,payload()));
 assert.throws(()=>insertContinuousDailyRowRequests(7,5,1000,'not a valid carrier'));
});
