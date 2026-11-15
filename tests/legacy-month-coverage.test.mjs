import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {verifyLegacyMonthCoverage}=createRequire(import.meta.url)('../dist/sheets/legacy-month-coverage.js');

const date=(y,m,d)=>(Date.UTC(y,m-1,d)-Date.UTC(1899,11,30))/86400000;
function fixture(){
 const row=()=>Array(25).fill(null),f=Array.from({length:20},row),e=Array.from({length:20},row);
 for(const r of [f,e]){
  r[4][0]=2026;
  Object.assign(r[5],{1:11,3:'รายรับทั้งหมดในบัญชี',4:50000});
  Object.assign(r[6],{1:11,2:1,3:'direct amount',8:100,20:date(2026,11,1)});
  Object.assign(r[7],{1:11,2:2,3:'transfer',7:20,8:20,20:date(2026,11,2)});
  Object.assign(r[8],{0:'รวม',1:11,8:120});
  Object.assign(r[9],{1:7,3:'รายรับทั้งหมดในบัญชี',4:50000});
  Object.assign(r[10],{1:7,2:17,3:'missing full date',8:60});
  Object.assign(r[11],{0:'รวม',1:7,8:60});
 }
 f[6][20]='=DATE(2026,11,1)';f[7][20]='=DATE(2026,11,2)';f[7][8]='=SUM(F8:H8)';f[8][8]='=SUM(I7:I8)';f[11][8]='=SUM(I11:I11)';
 return{formula:f,effective:e,rowCount:20,columnCount:25,year:2026,month:11,complete:true};
}
test('November includes a direct I amount and a normal formula amount',()=>{
 assert.deepEqual(verifyLegacyMonthCoverage(fixture()),{status:'VERIFIED',legacyDebitSatang:12000,openingSatang:5000000,checkedRows:2});
});
test('missing July full date holds July only and does not block November',()=>{
 const x=fixture();assert.equal(verifyLegacyMonthCoverage({...x,month:7}).reason,'DATE_UNVERIFIED');assert.equal(verifyLegacyMonthCoverage(x).status,'VERIFIED');
});
test('undo on a legacy row changes subtotal only after both source and subtotal agree',()=>{
 const x=fixture();x.formula[6][8]=0;x.effective[6][8]=0;
 assert.equal(verifyLegacyMonthCoverage(x).reason,'SUBTOTAL_MISMATCH');
 x.effective[8][8]=20;assert.equal(verifyLegacyMonthCoverage(x).legacyDebitSatang,2000);
});
test('unknown year, unknown month, incomplete snapshot and incorrect subtotal fail closed',()=>{
 for(const change of [x=>{x.year=2025},x=>{x.formula[4][0]='unknown'},x=>{x.effective[6][1]='unknown'},x=>{x.complete=false},x=>{x.formula[8][8]='=SUM(I6:I8)'},x=>{x.effective[6][20]=date(2026,10,1)}]){
  const x=fixture();change(x);assert.equal(verifyLegacyMonthCoverage(x).status,'REVIEW');
 }
});
test('future year has zero legacy debit without borrowing an opening, even with old-year missing U',()=>{
 const x=fixture();x.year=2027;x.month=7;
 assert.deepEqual(verifyLegacyMonthCoverage(x),{status:'VERIFIED',legacyDebitSatang:0,openingSatang:null,checkedRows:0});
 x.effective[6][20]=date(2027,11,1);assert.equal(verifyLegacyMonthCoverage(x).reason,'YEAR_UNVERIFIED');
});
test('future year fails when old-year expense is outside a known monthly block or snapshot incomplete',()=>{
 for(const change of [x=>{x.complete=false},x=>{x.effective[10][1]='unknown'},x=>{x.effective[15][0]=2027},x=>{x.effective[9][3]='unknown'}]){
  const x=fixture();x.year=2027;x.month=7;change(x);assert.equal(verifyLegacyMonthCoverage(x).status,'REVIEW');
 }
});
test('nonzero direct I outside its verified month block is rejected',()=>{
 const x=fixture();Object.assign(x.formula[15],{1:11,2:1,8:2,20:'=DATE(2026,11,1)'});Object.assign(x.effective[15],{1:11,2:1,8:2,20:date(2026,11,1)});
 assert.equal(verifyLegacyMonthCoverage(x).reason,'MONTH_BLOCK_UNVERIFIED');
});
test('unclassifiable nonzero amounts are never silently discarded',()=>{
 for(const row of [{8:40},{1:11,8:40}]){
  const x=fixture();Object.assign(x.formula[15],row);Object.assign(x.effective[15],row);
  assert.equal(verifyLegacyMonthCoverage(x).status,'REVIEW');
 }
});
test('channel subtotals cover a full month only if each daily I equals its channels',()=>{
 const x=fixture();for(const row of [x.formula[6],x.effective[6]])row[7]=100;
 for(const [c,name] of [[5,'F'],[6,'G'],[7,'H']]){x.formula[8][c]=`=SUMIF($B$7:$B$8,$B9,${name}7:${name}8)`;x.effective[8][c]=c===7?120:0;}
 x.formula[8][8]='=SUM(F9:H9)';
 assert.equal(verifyLegacyMonthCoverage(x).legacyDebitSatang,12000);
 x.effective[6][7]=99;assert.equal(verifyLegacyMonthCoverage(x).reason,'SUBTOTAL_UNVERIFIED');
});
