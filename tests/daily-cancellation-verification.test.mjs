import test from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {createHash} from 'node:crypto';
const require=createRequire(import.meta.url),{verifyDailyCancellationReadback}=require('../dist/sheets/daily-cancellation-verification.js'),{expectedHelperFormulae}=require('../dist/sheets/daily-stable-row-writes.js');
const blank=()=>Array(25).fill(null),copy=x=>x.map(r=>[...r]);
function fixture(){
 const count=9,f=Array.from({length:count},blank),e=Array.from({length:count},blank),header=6,total=9;
 for(const a of [f,e]){a[4][0]=2026;a[5][1]=10;a[5][3]='รายรับทั้งหมดในบัญชี';a[5][4]=50000;a[5][9]=50000;a[6][1]=10;a[6][2]=9;a[6][3]='example';a[6][7]=100;a[6][21]='ingredients';a[6][22]='SHOP_BANK';a[6][23]='MALIPANG_EXPENSE:exp_one';a[8][0]='รวม';a[8][1]=10;}
 const helper=expectedHelperFormulae(header,7);for(const [i,name] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']])f[6][i]=helper[name];
 Object.assign(e[6],{8:100,9:49900,17:0,18:49900,20:(Date.UTC(2026,9,9)-Date.UTC(1899,11,30))/86400000});
 for(const [name,i] of [['E',4],['F',5],['G',6],['H',7],['K',10],['L',11],['M',12],['N',13],['O',14],['P',15],['Q',16]]){f[8][i]=`=SUMIF($B$7:$B$8,$B9,${name}7:${name}8)`;e[8][i]=name==='H'?100:0;}
 Object.assign(f[8],{8:'=SUM(F9:H9)',9:'=$E$6-I9',17:'=SUM(K9:Q9)',18:'=J9-R9'});Object.assign(e[8],{8:100,9:49900,17:0,18:49900});
 const af=copy(f),ae=copy(e);for(const i of [1,2,3,5,6,7,10,11,12,13,14,15,16,21,22]){af[6][i]=null;ae[6][i]=null;}Object.assign(ae[6],{8:0,9:50000,17:0,18:50000,20:null});Object.assign(ae[8],{7:0,8:0,9:50000,17:0,18:50000});
 return{before:{formula:f,effective:e},after:{formula:af,effective:ae},expenseId:'exp_one',year:2026,month:10,rowCount:count,columnCount:25,trustedPreimageWidth:25,trustedPreimageDigest:createHash('sha256').update(JSON.stringify(f[6])).digest('hex')};
}
test('verified cancellation preserves formula and full accounting snapshots',async()=>{assert.deepEqual(await verifyDailyCancellationReadback(fixture()),{status:'VERIFIED',observedRow:7});});
test('untrusted preimage, changed formula and wrong subtotal fail closed',async()=>{
 const a=fixture();a.trustedPreimageDigest='a'.repeat(64);assert.equal((await verifyDailyCancellationReadback(a)).reason,'PREIMAGE_UNVERIFIED');
 const b=fixture();b.after.formula[6][9]='=0';assert.equal((await verifyDailyCancellationReadback(b)).reason,'FORMULA_OR_OTHER_INPUT_CHANGED');
 const c=fixture();c.after.effective[8][9]=49900;assert.equal((await verifyDailyCancellationReadback(c)).reason,'AFTER_ACCOUNTING_UNVERIFIED');
});
test('partial cancellation or unrelated cell edits are not accepted',async()=>{
 const a=fixture();a.after.formula[6][7]=100;assert.equal((await verifyDailyCancellationReadback(a)).reason,'INPUT_NOT_CLEARED');
 const b=fixture();b.after.effective[1][3]='unrelated';assert.equal((await verifyDailyCancellationReadback(b)).reason,'UNRELATED_VALUE_CHANGED');
 const c=fixture();c.after.formula[7][23]='MALIPANG_EXPENSE:exp_one';assert.equal((await verifyDailyCancellationReadback(c)).reason,'FORMULA_OR_OTHER_INPUT_CHANGED');
});
test('later running balance and subtotal must recalculate after a cancellation',async()=>{
 const x=fixture(),{formula:f,effective:e}=x.before,{formula:af,effective:ae}=x.after;
 for(const a of [f,e,af,ae])Object.assign(a[7],{1:10,2:10,3:'later',7:70,23:'MALIPANG_EXPENSE:exp_later'});
 const helper=expectedHelperFormulae(6,8);for(const [i,name] of [[8,'I'],[9,'J'],[17,'R'],[18,'S'],[20,'U']]){f[7][i]=helper[name];af[7][i]=helper[name];}
 const date=(Date.UTC(2026,9,10)-Date.UTC(1899,11,30))/86400000;Object.assign(e[7],{8:70,9:49830,17:0,18:49830,20:date});Object.assign(ae[7],{8:70,9:49930,17:0,18:49930,20:date});
 Object.assign(e[8],{7:170,8:170,9:49830,17:0,18:49830});Object.assign(ae[8],{7:70,8:70,9:49930,17:0,18:49930});
 assert.equal((await verifyDailyCancellationReadback(x)).status,'VERIFIED');
 ae[7][9]=49830;assert.equal((await verifyDailyCancellationReadback(x)).reason,'AFTER_ACCOUNTING_UNVERIFIED');
});
