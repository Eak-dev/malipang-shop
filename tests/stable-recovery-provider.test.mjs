import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {inspectRecoverySheetSnapshots,inspectRecoveryProvider}=require('../dist/admin/stable-recovery-provider.js');
const {encodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js');
const {handleAdmin}=require('../dist/admin/handler.js');
const client=require('../dist/sheets/client.js');
const id='exp_test_a',key=`MALIPANG_EXPENSE:${id}`;
function fixture(){return [25,29,17,20].map(columnCount=>({rowCount:8,columnCount,formula:[[]],effective:[[]]}));}
function row(s,index,col,value,effective=value){s.formula[index]??=[];s.effective[index]??=[];s.formula[index][col]=value;s.effective[index][col]=effective;}
test('missing identities remain on hold, never authorize replay',()=>{
 const result=inspectRecoverySheetSnapshots(id,fixture());
 assert.equal(result.status,'HOLD');assert.equal(result.reason,'SETTLEMENT_UNPROVEN');assert.deepEqual(result.counts,{oldDaily:0,newDaily:0,raw:0,details:0});assert.ok(result.requires.includes('PROVIDER_SETTLEMENT'));
});
test('counts old and new identities and flags duplicates across tabs',()=>{
 const sheets=fixture();row(sheets[0],4,23,key);row(sheets[1],6,23,key);row(sheets[2],2,0,id);row(sheets[3],2,1,id);row(sheets[3],3,1,id);
 const result=inspectRecoverySheetSnapshots(id,sheets);assert.equal(result.reason,'DUPLICATE_IDENTITY');assert.deepEqual(result.counts,{oldDaily:1,newDaily:1,raw:1,details:2});
});
test('carrier verifies Y independently of displayed formula and flags mismatches',()=>{
 const sheets=fixture(),payload=encodeAtomicDailyPayload({expenseId:id,postingYear:2026,postingMonth:4,postingDay:11,description:'Makro',amountColumn:'H',amountSatang:123,category:'Ingredients',wallet:'Shop bank account'});
 row(sheets[1],4,24,payload);row(sheets[1],4,23,'=SOME_FORMULA()',key);
 assert.equal(inspectRecoverySheetSnapshots(id,sheets).reason,'SETTLEMENT_UNPROVEN');
 sheets[1].effective[4][23]='';assert.equal(inspectRecoverySheetSnapshots(id,sheets).reason,'IDENTITY_INCONSISTENT');
 sheets[1].formula[4][24]=`bad ${key}`;assert.equal(inspectRecoverySheetSnapshots(id,sheets).reason,'IDENTITY_INCONSISTENT');
});
test('invalid or truncated snapshots and raw formula mismatches fail closed',()=>{
 const bad=fixture();bad[0].rowCount=5001;assert.equal(inspectRecoverySheetSnapshots(id,bad).reason,'INCOMPLETE_SNAPSHOT');
 assert.equal(inspectRecoverySheetSnapshots('invalid|id',fixture()).reason,'INVALID_INPUT');
 const sheets=fixture();row(sheets[2],2,0,`=${id}`,id);assert.equal(inspectRecoverySheetSnapshots(id,sheets).reason,'IDENTITY_INCONSISTENT');
});
test('diagnostic requires admin authorization and rejects invalid targets without provider access',async()=>{
 const env={ADMIN_TOKEN:'synthetic-secret-'.repeat(4),DB:{prepare(){throw Error('unexpected DB access')}},GOOGLE_SPREADSHEET_ID:'book',EXPENSE_PROVIDER_DIAGNOSTIC_ENABLED:'true'};
 const make=(auth)=>new Request('https://local.invalid/admin/stable-sync/expense-provider-diagnostic',{method:'POST',headers:{authorization:auth,'content-type':'application/json'},body:JSON.stringify({expenseId:'invalid|target'})});
 assert.equal((await handleAdmin(make('Bearer wrong'),env,{})).status,401);
 const response=await handleAdmin(make(`Bearer ${env.ADMIN_TOKEN}`),env,{});
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
 const result=await response.json();assert.equal(result.status,'HOLD');assert.equal(result.reason,'INVALID_INPUT');assert.equal(result.counts,null);
 // R6: with the flag unset the route does not exist, as on main.
 delete env.EXPENSE_PROVIDER_DIAGNOSTIC_ENABLED;
 assert.equal((await handleAdmin(make(`Bearer ${env.ADMIN_TOKEN}`),env,{})).status,404);
});
test('provider diagnostic reads all four bounded grids and rejects a changed grid',async()=>{
 const original={grid:client.getSheetGridInfo,formula:client.batchGetSheetFormulaValues,effective:client.batchGetSheetEffectiveSerialValues};
 const names=['old','new','raw','detail'],sheets=fixture(),env={DB:{},GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'old',SHEET_EXPENSE_RAW:'raw',SHEET_PURCHASE_DETAILS:'detail'};
 let calls=0,changeGrid=false;
 try{
  client.getSheetGridInfo=async(_env,name)=>{calls++;const index=names.indexOf(name);assert.notEqual(index,-1);return{sheetId:index+1,rowCount:8+(changeGrid&&calls>4?1:0),columnCount:sheets[index].columnCount}};
  client.batchGetSheetFormulaValues=async(_env,ranges)=>{assert.equal(ranges.length,4);return sheets.map(s=>s.formula)};
  client.batchGetSheetEffectiveSerialValues=async(_env,ranges)=>{assert.equal(ranges.length,4);return sheets.map(s=>s.effective)};
  row(sheets[0],4,23,key);
  const good=await inspectRecoveryProvider(env,id,'old','new');assert.equal(good.reason,'SETTLEMENT_UNPROVEN');assert.equal(good.counts.oldDaily,1);assert.equal(calls,8);
  calls=0;changeGrid=true;const changed=await inspectRecoveryProvider(env,id,'old','new');assert.equal(changed.reason,'READ_UNVERIFIED');assert.equal(changed.counts,null);
 }finally{client.getSheetGridInfo=original.grid;client.batchGetSheetFormulaValues=original.formula;client.batchGetSheetEffectiveSerialValues=original.effective;}
});
