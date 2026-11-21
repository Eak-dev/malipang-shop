import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{manualReportNativeRowRequests}=require('../dist/sheets/monthly-report-template.js'),{verifyMixedDailyAccounting}=require('../dist/sheets/mixed-daily-accounting.js');
const {verifyMonthlyReportRow}=require('../dist/sheets/monthly-report-row-proof.js');
const row={expenseId:'exp_fixture',sourceVersion:1,transactionDate:'2026-11-21',postingYear:2026,postingMonth:11,postingDay:21,description:'=literal',amountSatang:123,amountColumn:'H',category:'ingredients',wallet:'บัญชีร้าน'},marker='MRP1_'+'a'.repeat(32);
const blank=()=>Array(29).fill(null),legacy={status:'VERIFIED',year:2026,month:11,legacyDebitSatang:0,openingSatang:100000,checkedRows:0};
function snapshot(){
 const f=Array.from({length:6},blank),e=Array.from({length:6},blank),request=manualReportNativeRowRequests(7,5,4,row,marker),cells=request[2].updateCells.rows[0].values;
 Object.assign(f[3],{26:2026,27:11,28:1000});Object.assign(e[3],{26:2026,27:11,28:1000});
 for(let c=0;c<cells.length;c++){const x=cells[c].userEnteredValue;if(!x)continue;if(x.formulaValue)f[5][c]=x.formulaValue;else f[5][c]=e[5][c]=x.numberValue??x.stringValue;}
 Object.assign(e[5],{8:1.23,9:998.77,18:998.77,20:Math.floor((Date.UTC(2026,10,21)-Date.UTC(1899,11,30))/86400000)});
 return {formula:f,effective:e,request};
}
test('native report candidate writes only a new row, keeps T/X/Y values blank and stores marker in note',()=>{
 const s=snapshot(),requests=s.request,cells=requests[2].updateCells.rows[0].values;
 assert.deepEqual(Object.keys(requests[0]),['appendDimension']);assert.equal(requests[0].appendDimension.length,2);assert.equal(requests[1].copyPaste.pasteType,'PASTE_FORMAT');assert.equal(requests[2].updateCells.start.rowIndex,5);assert.equal(cells[3].userEnteredValue.stringValue,'=literal');
 assert.equal(cells[19].userEnteredValue,undefined);assert.equal(cells[23].userEnteredValue,undefined);assert.equal(cells[24].userEnteredValue,undefined);assert.equal(requests[3].updateCells.rows[0].values[0].note,marker);assert.equal(requests[3].updateCells.fields,'note');
 assert.equal(cells[7].userEnteredValue.numberValue,1.23);assert.equal(verifyMixedDailyAccounting(s,6,29,2026,11,legacy),true);
});
test('the existing accounting verifier rejects altered helper or effective values',()=>{
 for(const change of ['formula-changed','effective-changed']){const s=snapshot();
  if(change==='formula-changed')s.formula[5][8]='=1';
  if(change==='effective-changed')s.effective[5][8]=999;
  assert.equal(verifyMixedDailyAccounting(s,6,29,2026,11,legacy),false,change);
 }
});
test('invalid request cannot produce a write plan',()=>{
 assert.throws(()=>manualReportNativeRowRequests(7,5,4,row,'invalid'),/INVALID/);assert.throws(()=>manualReportNativeRowRequests(7,5,4,{...row,amountColumn:'AA'},marker),/PAYMENT_INVALID/);assert.throws(()=>manualReportNativeRowRequests(7,4999,4,row,marker),/INVALID/);
});
function proofGrid(){const s=snapshot();s.formula.push(blank());s.effective.push(blank());const notes=Array.from({length:7},blank),formats=Array.from({length:7},blank),validations=Array.from({length:7},blank);notes[5][19]=marker;return {...s,rows:7,columns:29,notes,formats,validations,structure:{sheetId:7,title:'รายวันต่อเนื่อง_แบบร่าง'}};}
test('row proof checks intended values, exact formulas, notes, formats and unique marker',()=>{
 const good=proofGrid();assert.equal(verifyMonthlyReportRow(good,5,4,row,marker),true);
 for(const mode of ['wrong-amount','wrong-description','formula','note-duplicate','format','validation','hidden-value','date']){const g=proofGrid();
  if(mode==='wrong-amount')g.formula[5][7]=g.effective[5][7]=4;if(mode==='wrong-description')g.formula[5][3]=g.effective[5][3]='other';if(mode==='formula')g.formula[5][8]='=1';if(mode==='note-duplicate')g.notes[6][19]=marker;if(mode==='format')g.formats[5][7]={numberFormat:{type:'DATE'}};if(mode==='validation')g.validations[5][7]={strict:true};if(mode==='hidden-value')g.formula[5][26]=3;if(mode==='date')g.effective[5][20]=0;
  assert.equal(verifyMonthlyReportRow(g,5,4,row,marker),false,mode);
 }
});
