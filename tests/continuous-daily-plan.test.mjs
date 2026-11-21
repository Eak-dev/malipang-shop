import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {planContinuousDailyExpense,continuousDailyDateFormula,continuousDailyHelperFormulas}=require('../dist/sheets/continuous-daily-plan.js');

function fixture(overrides={}){
 const headers=[[],[],[]];headers[1][7]='เงินโอน';headers[2][6]='NON-FIXED';headers[1][11]=10;headers[2][11]='First Choice';
 const base={rowCount:20,columnCount:29,firstDataRow:4,snapshotComplete:true,expenseId:'exp_one',transactionDate:'2026-04-11',description:'synthetic store',amountSatang:250000,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'ingredients',allowCreate:true,...overrides};
 const source=overrides.rows||headers,rows=source.map(r=>r.slice());
 for(let number=4;number<=base.rowCount;number++){while(rows.length<number)rows.push([]);Object.assign(rows[number-1],continuousDailyHelperFormulas(number));}
 return {...base,rows};
}
function materialize(input,plan){
 const rows=input.rows.map(r=>r.slice());const row=rows[plan.observedRow-1];
 for(const change of plan.changes)row[change.column]=change.userEnteredValue.numberValue??change.userEnteredValue.stringValue;
 return rows;
}
const changeValues=plan=>Object.fromEntries(plan.changes.map(c=>[c.column,c.userEnteredValue.numberValue??c.userEnteredValue.stringValue]));

test('plans a row after the last data row while preserving every template helper',()=>{
 const input=fixture();Object.assign(input.rows[3],{0:2025,1:12,2:31,3:'existing',7:50,23:'MALIPANG_EXPENSE:exp_old'});
 const plan=planContinuousDailyExpense(input);assert.equal(plan.status,'APPEND');assert.equal(plan.observedRow,5);
 assert.equal(plan.requiresBalanceVerification,true);assert.equal(plan.changes.some(c=>[8,9,17,18,20].includes(c.column)),false);
 assert.deepEqual(changeValues(plan),{0:2026,1:4,2:11,3:'synthetic store',7:2500,21:'ingredients',22:'บัญชีร้าน',23:'MALIPANG_EXPENSE:exp_one'});
});

test('credit cutoff validates cross-year and leap-end-of-month posting dates',()=>{
 const card={paymentKey:'firstchoice',sourceWallet:'CARD_FIRST_CHOICE',amountSatang:123425};
 for(const [date,expected] of [['2026-12-25',[2027,1,25]],['2024-01-31',[2024,2,29]],['2023-01-31',[2023,2,28]]]){
  const plan=planContinuousDailyExpense(fixture({...card,transactionDate:date}));assert.equal(plan.status,'APPEND',date);
  const changes=changeValues(plan);assert.deepEqual([changes[0],changes[1],changes[2]],expected);assert.equal(changes[11],1234.25);
  assert.equal(plan.changes.filter(c=>[5,6,7,10,11,12,13,14,15,16].includes(c.column)).length,1);
 }
 assert.equal(planContinuousDailyExpense(fixture({...card,transactionDate:'9999-12-25'})).reason,'INVALID_POSTING_DATE');
});

test('new template headers map cash, transfer and every card to their original columns',()=>{
 const headers=[[],[],[]];headers[2][6]='เงินสด NON-FIXED';headers[2][7]='เงินโอน';
 const names=['Kbank','First Choice','Aeon','Cibit Bank','Thanachart','Homepro','The One'],cutoffs=[17,24,24,13,22,15,15];
 names.forEach((name,i)=>{headers[2][10+i]=name;headers[1][10+i]=cutoffs[i];});
 const cases=[['cash','CASH_DRAWER',6],['transfer','SHOP_BANK',7],['kbank','CARD_KBANK',10],['firstchoice','CARD_FIRST_CHOICE',11],['aeon','CARD_AEON',12],['citibank','CARD_CITIBANK',13],['ttb','CARD_TTB',14],['homepro','CARD_HOMEPRO',15],['t1','CARD_THE1',16]];
 for(const [paymentKey,sourceWallet,column] of cases){
  const plan=planContinuousDailyExpense(fixture({rows:headers,transactionDate:'2026-06-10',paymentKey,sourceWallet}));
  assert.equal(plan.status,'APPEND',paymentKey);assert.deepEqual(plan.changes.find(c=>c.column===column)?.userEnteredValue,{numberValue:2500},paymentKey);
 }
 const conflicting=headers.map(r=>r.slice());conflicting[1][5]='เงินโอน';assert.equal(planContinuousDailyExpense(fixture({rows:conflicting})).reason,'PAYMENT_UNVERIFIED');
});

test('existing ID needs an exact complete preimage, matching source and helpers',()=>{
 const input=fixture(),plan=planContinuousDailyExpense(input);assert.equal(plan.status,'APPEND');
 const rows=materialize(input,plan),expected=Array.from({length:29},(_,i)=>rows[3][i]??null);
 assert.equal(planContinuousDailyExpense({...input,rows}).reason,'MISSING_TRUSTED_PREIMAGE');
 assert.deepEqual(planContinuousDailyExpense({...input,rows,expectedPrevious:expected}),{status:'FOUND',observedRow:4,requiresBalanceVerification:true});
 assert.equal(planContinuousDailyExpense({...input,rows,expectedPrevious:expected,amountSatang:1}).reason,'IDENTITY_PREIMAGE_MISMATCH');
 const changed=rows.map(r=>r.slice());changed[3][24]='manual note';assert.equal(planContinuousDailyExpense({...input,rows:changed,expectedPrevious:expected}).reason,'IDENTITY_PREIMAGE_MISMATCH');
 const broken=rows.map(r=>r.slice());broken[3][9]='=0';const brokenPrevious=Array.from({length:29},(_,i)=>broken[3][i]??null);
 assert.equal(planContinuousDailyExpense({...input,rows:broken,expectedPrevious:brokenPrevious}).reason,'IDENTITY_PREIMAGE_MISMATCH');
});

test('every missing or different helper formula fails closed',()=>{
 assert.deepEqual(continuousDailyHelperFormulas(4),{
  8:'=IF(COUNTA(F4:H4)=0,"",SUM(F4:H4))',
  9:'=IF(U4="","",IF(OR(COUNTIFS($AA$4:$AA$243,A4,$AB$4:$AB$243,B4)<>1,SUMPRODUCT(--($AA$4:$AA$243=A4),--($AB$4:$AB$243=B4),--ISNUMBER($AC$4:$AC$243))<>1),"",SUMIFS($AC$4:$AC$243,$AA$4:$AA$243,A4,$AB$4:$AB$243,B4)-SUMIFS($I$4:I4,$A$4:A4,A4,$B$4:B4,B4)))',
  17:'=IF(COUNTA(K4:Q4)=0,"",SUM(K4:Q4))',18:'=IF(J4="","",J4-R4)',
  20:'=IF(AND(ISNUMBER(A4),ISNUMBER(B4),ISNUMBER(C4),A4>=1900,A4<=9999,B4>=1,B4<=12,C4>=1,C4<=31),IF(AND(YEAR(DATE(A4,B4,C4))=A4,MONTH(DATE(A4,B4,C4))=B4,DAY(DATE(A4,B4,C4))=C4),DATE(A4,B4,C4),""),"")'
 });
 for(const column of [8,9,17,18,20])for(const bad of ['', '=0', 42]){
  const input=fixture();input.rows[3][column]=bad;assert.equal(planContinuousDailyExpense(input).reason,'HELPER_FORMULA_UNVERIFIED',`column ${column}`);
 }
 assert.equal(continuousDailyDateFormula(4),'=IF(AND(ISNUMBER(A4),ISNUMBER(B4),ISNUMBER(C4),A4>=1900,A4<=9999,B4>=1,B4<=12,C4>=1,C4<=31),IF(AND(YEAR(DATE(A4,B4,C4))=A4,MONTH(DATE(A4,B4,C4))=B4,DAY(DATE(A4,B4,C4))=C4),DATE(A4,B4,C4),""),"")');
});

test('dangerous-looking description remains a typed literal string, never a formula',()=>{
 const description='=IMPORTXML("https://example.invalid","//x")';
 const plan=planContinuousDailyExpense(fixture({description}));assert.equal(plan.status,'APPEND');
 assert.deepEqual(plan.changes.find(c=>c.column===3).userEnteredValue,{stringValue:description});
 for(const c of plan.changes)assert.equal('formulaValue' in c.userEnteredValue,false);
});

test('duplicate IDs, ambiguous headers, no proof and invalid source fail closed',()=>{
 const input=fixture(),plan=planContinuousDailyExpense(input),rows=materialize(input,plan);Object.assign(rows[4],rows[3]);
 assert.equal(planContinuousDailyExpense({...input,rows}).reason,'DUPLICATE_STABLE_ID');
 const ambiguous=fixture();ambiguous.rows[1][5]='เงินโอน';assert.equal(planContinuousDailyExpense(ambiguous).reason,'PAYMENT_UNVERIFIED');
 const misplaced=fixture();misplaced.rows[0][23]='MALIPANG_EXPENSE:exp_one';assert.equal(planContinuousDailyExpense(misplaced).reason,'IDENTITY_OUTSIDE_DATA');
 assert.equal(planContinuousDailyExpense(fixture({allowCreate:false})).reason,'NO_PRIOR_WRITE_UNVERIFIED');
 assert.equal(planContinuousDailyExpense(fixture({paymentKey:'transfer',sourceWallet:'CASH_DRAWER'})).reason,'INVALID_EXPENSE');
 assert.equal(planContinuousDailyExpense(fixture({snapshotComplete:false})).reason,'INCOMPLETE_SNAPSHOT');
});

test('does not overwrite unknown data or append past grid capacity',()=>{
 const input=fixture({rowCount:4});input.rows[3][24]='owner data';assert.equal(planContinuousDailyExpense(input).status,'CAPACITY_REQUIRED');
 for(const date of ['2026-02-30','2026-02-31','2025-02-29','2026-13-01'])assert.equal(planContinuousDailyExpense(fixture({transactionDate:date})).reason,'INVALID_TRANSACTION_DATE',date);
 for(const date of ['2024-02-29','2026-02-28'])assert.equal(planContinuousDailyExpense(fixture({transactionDate:date})).status,'APPEND',date);
});

test('budget panel never changes transaction append position or output cells',()=>{
 const input=fixture();Object.assign(input.rows[3],{26:2026,27:4,28:1000});Object.assign(input.rows[18],{26:2027,27:1,28:2000});
 const plan=planContinuousDailyExpense(input);assert.equal(plan.status,'APPEND');assert.equal(plan.observedRow,4);
 assert.equal(plan.changes.some(c=>c.column>=26),false);assert.equal(plan.requiresBalanceVerification,true);
 const rows=materialize(input,plan),expected=Array.from({length:29},(_,i)=>rows[3][i]??null);
 rows[3][28]=1500;
 assert.deepEqual(planContinuousDailyExpense({...input,rows,expectedPrevious:expected}),{status:'FOUND',observedRow:4,requiresBalanceVerification:true});
});

test('unknown content below bounded budget panel fails closed',()=>{
 const input=fixture({rowCount:244});input.rows[243][26]='unexpected owner data';
 assert.equal(planContinuousDailyExpense(input).reason,'BUDGET_PANEL_OUTSIDE_RANGE');
 assert.equal(planContinuousDailyExpense(fixture({columnCount:28})).reason,'INCOMPLETE_SNAPSHOT');
});
