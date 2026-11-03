import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectDailyAppendSnapshot} from '../dist/sheets/daily-append-preflight.js';
import {expectedHelperFormulae} from '../dist/sheets/daily-stable-row-writes.js';

const blank=()=>Array(25).fill(null);
function fixture(space=true){
 const count=space?9:8,f=Array.from({length:count},blank),e=Array.from({length:count},blank),header=6,total=count;
 f[4][0]=2026;e[4][0]=2026;
 for(const a of [f,e]){a[5][1]=10;a[5][3]='รายรับทั้งหมดในบัญชี';a[5][4]=50000;a[5][9]=50000;a[6][1]=10;a[6][2]=9;a[6][3]='example';a[6][7]=100;a[total-1][0]='รวม';a[total-1][1]=10;}
 const helpers=expectedHelperFormulae(header,7);for(const [i,name] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']])f[6][i]=helpers[name];
 Object.assign(e[6],{8:100,9:49900,17:0,18:49900,20:(Date.UTC(2026,9,9)-Date.UTC(1899,11,30))/86400000});
 for(const [name,i] of [['E',4],['F',5],['G',6],['H',7],['K',10],['L',11],['M',12],['N',13],['O',14],['P',15],['Q',16]]){f[total-1][i]=`=SUMIF($B$7:$B$${total-1},$B${total},${name}7:${name}${total-1})`;e[total-1][i]=name==='H'?100:0;}
 Object.assign(f[total-1],{8:`=SUM(F${total}:H${total})`,9:`=$E$6-I${total}`,17:`=SUM(K${total}:Q${total})`,18:`=J${total}-R${total}`});Object.assign(e[total-1],{8:100,9:49900,17:0,18:49900});
 return{formula:f,effective:e,rowCount:count,expenseId:'exp_new',year:2026,month:10};
}
test('plans after last occupied row and asks for expansion only when the month is full',()=>{
 assert.deepEqual(inspectDailyAppendSnapshot(fixture()),{status:'APPEND',observedRow:8,formulaColumnsMissing:['I','J','R','S','U']});
 assert.deepEqual(inspectDailyAppendSnapshot(fixture(false)),{status:'CAPACITY_REQUIRED',observedTotalRow:8});
});
test('holds invalid subtotals, wrong dates, formulas in money cells and stale effective values',()=>{
 for(const mode of ['total-formula','total-value','date','formula','snapshot']){
  const x=fixture();if(mode==='total-formula')x.formula[8][7]='=SUM(H7:H8)';if(mode==='total-value')x.effective[8][7]=99;if(mode==='date')x.effective[6][1]=11;if(mode==='formula')x.formula[6][7]='=100';if(mode==='snapshot')x.rowCount=8;
  assert.equal(inspectDailyAppendSnapshot(x).status,'REVIEW',mode);
 }
});
test('holds duplicate identities anywhere in the complete sheet and invalid previous balances',()=>{
 const x=fixture();x.formula[1][23]=x.effective[1][23]='some-id';x.formula[2][23]=x.effective[2][23]='some-id';assert.equal(inspectDailyAppendSnapshot(x).reason,'DUPLICATE_OR_INVALID_ID');
 const y=fixture();y.formula[7][9]='=J7-I8';y.effective[6][9]='#VALUE!';assert.equal(inspectDailyAppendSnapshot(y).status,'REVIEW');
});
test('holds financial rows assigned to the month outside its physical block',()=>{
 const x=fixture();x.formula.push(blank());x.effective.push(blank());x.rowCount++;x.effective[9][1]=10;x.effective[9][7]=200;assert.equal(inspectDailyAppendSnapshot(x).reason,'FINANCIAL_ROW_OUTSIDE_MONTH');
});
test('checks every running balance even when the final row and month subtotal appear consistent',()=>{
 const x=fixture(),f=x.formula,e=x.effective;
 f.splice(8,0,blank());e.splice(8,0,blank());x.rowCount++;
 for(const a of [f,e]){a[7][1]=10;a[7][2]=10;a[7][3]='second';a[7][7]=50;}
 const helpers=expectedHelperFormulae(6,8);for(const [i,name] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']])f[7][i]=helpers[name];
 e[6][9]=49880;Object.assign(e[7],{8:50,9:49830,17:0,18:49830,20:(Date.UTC(2026,9,10)-Date.UTC(1899,11,30))/86400000});
 for(const [name,i] of [['E',4],['F',5],['G',6],['H',7],['K',10],['L',11],['M',12],['N',13],['O',14],['P',15],['Q',16]]){f[9][i]=`=SUMIF($B$7:$B$9,$B10,${name}7:${name}9)`;e[9][i]=name==='H'?150:0;}
 Object.assign(f[9],{8:'=SUM(F10:H10)',9:'=$E$6-I10',17:'=SUM(K10:Q10)',18:'=J10-R10'});Object.assign(e[9],{8:150,9:49850,17:0,18:49850});
 assert.equal(inspectDailyAppendSnapshot(x).reason,'ROW_ACCOUNTING_UNVERIFIED');
});
test('holds a financial row with multiple outflow channels',()=>{const x=fixture();x.formula[6][5]=x.effective[6][5]=10;assert.equal(inspectDailyAppendSnapshot(x).reason,'MULTIPLE_OUTFLOW_CHANNELS');});
