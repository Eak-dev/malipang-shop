import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {appendDailyRowFormulas}=require('../dist/sheets/append-daily-template.js');
const {continuousDailyHelperFormulas}=require('../dist/sheets/continuous-daily-plan.js');
const {encodeAtomicDailyPayload}=require('../dist/sheets/atomic-daily-template.js');
const {verifyMixedDailyAccounting}=require('../dist/sheets/mixed-daily-accounting.js');
const {verifyInsertedDailyFinalSnapshot}=require('../dist/sheets/insert-daily-writer.js');
const auth=require('../dist/sheets/daily-carrier-auth.js'),client=require('../dist/sheets/client.js');

function fixture(state='STAGED'){
 const formula=Array.from({length:6},()=>Array(29).fill(null)),effective=Array.from({length:6},()=>Array(29).fill(null));
 const publication={sheet:'publication',rows:100,markers:new Map([['exp_test',{state,version:state==='REVOKED'?2:1}]])};
 Object.assign(formula[3],continuousDailyHelperFormulas(4),{26:2026,27:11,28:1000});Object.assign(effective[3],{26:2026,27:11,28:1000});
 Object.assign(formula[4],appendDailyRowFormulas(publication));
 const payload=encodeAtomicDailyPayload({expenseId:'exp_test',postingYear:2026,postingMonth:11,postingDay:15,description:'fixture',amountColumn:'H',amountSatang:123,category:'ingredients',wallet:'บัญชีร้าน',operationMarker:'INSERT_'+'a'.repeat(32),publicationVersion:1});
 formula[4][24]=effective[4][24]=payload;effective[4][25]=state;
 if(state==='PUBLISHED')Object.assign(effective[4],{0:2026,1:11,2:15,3:'fixture',7:1.23,8:1.23,9:798.77,18:798.77,20:(Date.UTC(2026,10,15)-Date.UTC(1899,11,30))/86400000,21:'ingredients',22:'บัญชีร้าน',23:'MALIPANG_EXPENSE:exp_test'});
 Object.assign(formula[5],continuousDailyHelperFormulas(6));
 return{formula,effective,publication,legacy:{status:'VERIFIED',legacyDebitSatang:20000,openingSatang:100000,checkedRows:3,year:2026,month:11}};
}
const check=x=>verifyMixedDailyAccounting(x,6,29,2026,11,x.legacy,x.publication);
test('STAGED and REVOKED rows are recognized only when all public data are blank',()=>{
 for(const state of ['STAGED','REVOKED']){
  const x=fixture(state);assert.equal(check(x),true);
  for(const [col,value] of [[0,2026],[3,'fixture'],[4,1],[7,1.23],[8,1.23],[9,798.77],[23,'MALIPANG_EXPENSE:exp_test']]){x.effective[4][col]=value;assert.equal(check(x),false,`${state}: column ${col}`);x.effective[4][col]=null;}
 }
});
test('system rows reject a hidden income formula even when it currently evaluates blank',()=>{
 for(const state of ['STAGED','PUBLISHED','REVOKED']){const x=fixture(state);x.formula[4][4]='=IF(FALSE,100,"")';assert.equal(check(x),false);}
 const x=fixture('REVOKED'),tomb='MPD1_CANCELLED_'+'f'.repeat(64);x.formula[4][24]=x.effective[4][24]=tomb;x.effective[4][25]='';assert.equal(check(x),true);x.formula[4][4]='=IF(FALSE,100,"")';assert.equal(check(x),false);
});
test('PUBLISHED rows must match verified data, formula and marker version',()=>{
 const x=fixture('PUBLISHED');assert.equal(check(x),true);
 x.effective[4][7]=1.24;assert.equal(check(x),false);x.effective[4][7]=1.23;
 x.formula[4][25]='=TRUE';assert.equal(check(x),false);
});
test('missing, incorrect, duplicate or malformed marker evidence fails closed',()=>{
 for(const edit of [x=>x.publication.markers.clear(),x=>x.publication.markers.set('exp_test',{state:'PUBLISHED',version:1}),x=>x.publication.markers.set('exp_test',{state:'STAGED',version:2}),x=>x.effective[4][25]='#N/A',x=>x.publication.markers.set('exp_other',{state:'PUBLISHED',version:1}),x=>x.publication.markers.set('exp_other',{state:'REVOKED',version:1})]){const x=fixture();edit(x);assert.equal(check(x),false);}
});
test('only an explicitly reserved staged target may lack a row before insertion',()=>{
 const x=fixture();for(const r of [x.formula[4],x.effective[4]])r.fill(null);Object.assign(x.formula[4],continuousDailyHelperFormulas(5));
 assert.equal(check(x),false);x.publication.allowAbsentStaged='exp_test';assert.equal(check(x),true);
 x.publication.allowAbsentStaged='exp_other';assert.equal(check(x),false);
});
test('confirmation final verifier accepts exact staged data and rejects revoked or changed public identity',async()=>{
 const oldAuth=auth.verifyDailyCarrierEvidence,oldFormats=client.getSheetCellNumberFormats;
 auth.verifyDailyCarrierEvidence=async()=>true;
 client.getSheetCellNumberFormats=async()=>[...Array.from({length:15},()=>({type:'NUMBER',pattern:'#,##0.00'})),null,{type:'DATE',pattern:'dd/MM/yyyy'}];
 try{
  const x=fixture();x.formula[2][7]='เงินโอน';
  const env={GOOGLE_SPREADSHEET_ID:'book',DB:{prepare:()=>({bind:()=>({first:async()=>({ok:1})})})}};
  const job={kind:'SHEETS_SYNC',entityType:'EXPENSE',entityKey:'exp_test',entityVersion:1};
  const source={expense:{expense_id:'exp_test',description:'fixture',amount_satang:123,payment_key:'transfer',source_wallet:'SHOP_BANK',category:'ingredients',transaction_date:'2026-11-15',status:'CONFIRMED',created_at:'now'},links:[],documents:[],items:[],revision:0,digest:'a'.repeat(64),fingerprint:''};
  const grid={sheetId:2,rowCount:6,columnCount:29},journal={state:'VERIFIED',source_version:1,source_digest:source.digest,sheet_id:2,sheet_name:'draft',operation_token:'claim-token'};
  const run=()=>verifyInsertedDailyFinalSnapshot(env,job,source,'draft',2,grid,x,journal,x.legacy,x.publication);
  await run();x.effective[4][23]='MALIPANG_EXPENSE:exp_test';await assert.rejects(run,/INSERT_DAILY_FINAL_ACCOUNTING/);x.effective[4][23]=null;
  x.publication.markers.set('exp_test',{state:'REVOKED',version:2});x.effective[4][25]='REVOKED';await assert.rejects(run,/INSERT_DAILY_FINAL_PUBLICATION/);
 }finally{auth.verifyDailyCarrierEvidence=oldAuth;client.getSheetCellNumberFormats=oldFormats;}
});
