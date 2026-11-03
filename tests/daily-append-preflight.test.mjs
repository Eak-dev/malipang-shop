import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectDailyAppendSnapshot} from '../dist/sheets/daily-append-preflight.js';
import {expectedHelperFormulae} from '../dist/sheets/daily-stable-row-writes.js';
import {readDailyAppendPreflight} from '../dist/sheets/daily-recovery-identity-reader.js';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),auth=require('../dist/sheets/google-auth.js');

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
function provider(mode='normal'){
 const x=fixture(mode!=='capacity'),env={RUNTIME_MODE:'production',DAILY_APPEND_PREFLIGHT_ENABLED:'true',GOOGLE_SPREADSHEET_ID:'book',SHEET_EXPENSE_DAILY:'daily',SHEET_EXPENSE_RAW:'raw',SHEET_PERSONAL_USE_RAW:'personal',SHEET_PURCHASE_DETAILS:'detail',DB:{}},oldFetch=globalThis.fetch,oldAuth=auth.getGoogleAccessToken;let calls=0,formulaReads=0,annotationReads=0;
 auth.getGoogleAccessToken=async()=> 'fake';globalThis.fetch=async(url,init={})=>{calls++;assert.equal(init.method,undefined);const u=new URL(String(url));
  if(u.pathname.endsWith('/values:batchGet')){const formula=u.searchParams.get('valueRenderOption')==='FORMULA';if(formula&&++formulaReads===2&&mode==='change')x.formula[6][3]='changed';return new Response(JSON.stringify({valueRanges:[{range:`daily!A1:Y${x.rowCount}`,values:formula?x.formula:x.effective}]}));}
  if(u.searchParams.has('ranges')){annotationReads++;const cells=mode==='capacity'?x.formula[7].slice(0,19).map(v=>v===null?{}:{userEnteredValue:typeof v==='number'?{numberValue:v}:String(v).startsWith('=')?{formulaValue:v}:{stringValue:v}}):Array.from({length:mode==='short'?2:25},()=>({}));if(mode==='note'||mode==='note-late'&&annotationReads===2)cells[1].note='private';if(mode==='validation'||mode==='validation-late'&&annotationReads===2)cells[1].dataValidation={condition:{type:'NUMBER_GREATER'}};if(mode==='helper-late'&&annotationReads===2)cells[8].userEnteredValue={formulaValue:'=ROW()'};const data={startRow:mode==='wrong-row'?6:7,...(mode==='omitted'?{}:{rowData:mode==='empty'?[]:[{values:cells}]})},range={sheetId:7,startRowIndex:7,endRowIndex:8};return new Response(JSON.stringify({spreadsheetId:'book',sheets:[{properties:{sheetId:7},...(mode==='protected'||mode==='protected-late'&&annotationReads===2?{protectedRanges:[{range}]}:{}),...(mode==='merge-late'&&annotationReads===2?{merges:[range]}:{}),data:[data]}]}));}
  return new Response(JSON.stringify({spreadsheetId:'book',sheets:[{properties:{sheetId:7,title:'daily',gridProperties:{rowCount:x.rowCount,columnCount:25}}}]}));};
 return{env,calls:()=>calls,close(){globalThis.fetch=oldFetch;auth.getGoogleAccessToken=oldAuth;}};
}
test('Google read-only preflight double reads the live-shaped grid and checks annotations',async()=>{const h=provider();try{const r=await readDailyAppendPreflight(h.env,'exp_new',2026,10);assert.equal(r.status,'APPEND');assert.equal(h.calls(),8);}finally{h.close();}});
test('Google preflight handles sparse blank GridData without ignoring changed coordinates',async()=>{for(const mode of ['omitted','empty','short']){const h=provider(mode);try{assert.equal((await readDailyAppendPreflight(h.env,'exp_new',2026,10)).status,'APPEND',mode);}finally{h.close();}}});
test('Google preflight accepts a sparse subtotal when expansion is proposed',async()=>{const h=provider('capacity');try{assert.equal((await readDailyAppendPreflight(h.env,'exp_new',2026,10)).status,'CAPACITY_REQUIRED');}finally{h.close();}});
test('Google preflight is default-off and holds changed snapshots, notes, validation and protection',async()=>{for(const mode of ['change','note','validation','protected','wrong-row','note-late','validation-late','protected-late','merge-late','helper-late']){const h=provider(mode);try{assert.equal((await readDailyAppendPreflight(h.env,'exp_new',2026,10)).reason,'PROVIDER_SNAPSHOT_UNVERIFIED',mode);}finally{h.close();}}const h=provider();try{h.env.DAILY_APPEND_PREFLIGHT_ENABLED='false';await assert.rejects(readDailyAppendPreflight(h.env,'exp_new',2026,10),/DISABLED/);assert.equal(h.calls(),0);}finally{h.close();}});
