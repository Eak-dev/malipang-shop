import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{appendDailyRowFormulas}=require('../dist/sheets/append-daily-template.js'),{continuousDailyHelperFormulas}=require('../dist/sheets/continuous-daily-plan.js'),{atomicDailyRowFormulas,encodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js'),{verifyMixedDailyAccounting}=require('../dist/sheets/mixed-daily-accounting.js');
function fixture(){
 const f=Array.from({length:6},()=>Array(29).fill(null)),e=Array.from({length:6},()=>Array(29).fill(null));
 Object.assign(f[3],continuousDailyHelperFormulas(4),{26:2026,27:11,28:1000});Object.assign(e[3],{26:2026,27:11,28:1000});
 Object.assign(f[4],appendDailyRowFormulas());const y=encodeAtomicDailyPayload({expenseId:'exp_test',postingYear:2026,postingMonth:11,postingDay:15,description:'=literal',amountColumn:'H',amountSatang:123,category:'ingredients',wallet:'บัญชีร้าน'});f[4][24]=e[4][24]=y;
 Object.assign(e[4],{0:2026,1:11,2:15,3:'=literal',7:1.23,8:1.23,9:798.77,18:798.77,20:(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000,21:'ingredients',22:'บัญชีร้าน',23:'MALIPANG_EXPENSE:exp_test'});
 Object.assign(f[5],continuousDailyHelperFormulas(6));
 return {formula:f,effective:e,legacy:{status:'VERIFIED',legacyDebitSatang:20000,openingSatang:100000,checkedRows:3,year:2026,month:11}};
}
const check=x=>verifyMixedDailyAccounting(x,6,29,2026,11,x.legacy);
test('verifies inserted carrier, existing blank draft helpers and combined legacy balance',()=>assert.equal(check(fixture()),true));
test('holds orphan IDs, tampered formulas, bad budget and wrong legacy balance',()=>{
 for(const edit of [x=>x.effective[4][23]='',x=>x.formula[4][7]='=0',x=>x.effective[4][9]=998.77,x=>x.formula[3][28]='',x=>x.formula[5][24]='unknown']){const x=fixture();edit(x);assert.equal(check(x),false);}
});
test('recognizes cancellation tombstone without counting a stale payload',()=>{
 const x=fixture(),token='MPD1_CANCELLED_'+'a'.repeat(64);x.formula[4][24]=x.effective[4][24]=token;
 for(const c of [0,1,2,3,7,8,9,18,20,21,22,23])x.effective[4][c]='';
 assert.equal(check(x),true);x.effective[4][7]=1.23;assert.equal(check(x),false);
});
test('manual draft income is held when its original formula omits nonzero legacy spending',()=>{
 const x=fixture();for(const r of [x.formula[3],x.effective[3]])Object.assign(r,{0:2026,1:11,2:1,3:'income',4:500});
 Object.assign(x.effective[3],{9:1000,18:1000,20:(Date.UTC(2026,10,1)-Date.UTC(1899,11,30))/86400000});
 assert.equal(check(x),false);
 x.formula[3][9]=appendDailyRowFormulas()[9];x.effective[3][9]=800;x.effective[3][18]=800;assert.equal(check(x),true);
});
test('verifies a retained carrier using the original row-specific formulas',()=>{
 const x=fixture();Object.assign(x.formula[4],atomicDailyRowFormulas(5));assert.equal(check(x),true);
});
test('uses verified old monthly opening when panel is empty, while allowing an explicit panel override',()=>{
 const x=fixture();for(const row of [x.formula[3],x.effective[3]])row[26]=row[27]=row[28]=null;assert.equal(check(x),true);
 x.legacy.openingSatang=null;assert.equal(check(x),false);
 for(const row of [x.formula[3],x.effective[3]])Object.assign(row,{26:2026,27:11,28:1200});x.effective[4][9]=x.effective[4][18]=998.77;assert.equal(check(x),true);
});
