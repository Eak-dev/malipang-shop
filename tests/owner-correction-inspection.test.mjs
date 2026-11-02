import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectOwnerCorrectionTargets} from '../dist/sheets/owner-correction-inspection.js';
import {syntheticCorrectionHeaderDigest,syntheticCorrectionHeaders} from './helpers/owner-correction-periods.mjs';

function fixture(){
  const daily=Array(23).fill(null);Object.assign(daily,{1:10,2:28,3:'Driver',7:2000,21:'general',22:'บัญชีร้าน'});
  const raw=['exp_check','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED'];
  const plan={expenseId:'exp_check',dailyMetadataId:10,rawMetadataId:20,patches:[{metadataId:10,cells:[{columnIndex:21,value:'transport'}]},{metadataId:20,cells:[{columnIndex:6,value:'transport'}]}],originalRows:[{metadataId:10,values:daily},{metadataId:20,values:raw}],rebind:null};
  const metadata=[{metadataId:10,metadataKey:'malipang_expense_daily',metadataValue:'exp_check',sheetId:1,rowIndex:8},{metadataId:20,metadataKey:'malipang_expense_raw',metadataValue:'exp_check',sheetId:2,rowIndex:1}];
  const rows=new Map([[10,[...daily]],[20,[...raw]]]),env={SHEET_EXPENSE_DAILY:'daily',SHEET_EXPENSE_RAW:'raw',SHEET_PURCHASE_DETAILS:'detail'};
  const ports={sheetId:async(_env,name)=>({daily:1,raw:2,detail:3})[name],metadata:async(_env,key)=>metadata.filter(item=>item.metadataKey===key),rows:async()=>rows};
  return {env,plan,ports,metadata,rows};
}
test('inspection verifies metadata and unchanged identifying cells',async()=>{
  const x=fixture();assert.equal((await inspectOwnerCorrectionTargets(x.env,x.plan,x.ports)).identitiesVerified,true);
  x.rows.get(20)[2]='Another vendor';assert.equal((await inspectOwnerCorrectionTargets(x.env,x.plan,x.ports)).identitiesVerified,false);
});
test('duplicated metadata identities and wrong sheet associations fail closed',async()=>{
  let x=fixture();x.metadata.push({...x.metadata[0],metadataId:11,rowIndex:9});assert.equal((await inspectOwnerCorrectionTargets(x.env,x.plan,x.ports)).identitiesVerified,false);
  x=fixture();x.metadata[0].sheetId=2;assert.equal((await inspectOwnerCorrectionTargets(x.env,x.plan,x.ports)).identitiesVerified,false);
});
test('metadata attached to a different raw expense is not accepted even when the old snapshot matches',async()=>{
  const x=fixture();x.plan.originalRows[1].values[0]='other';x.rows.get(20)[0]='other';
  assert.equal((await inspectOwnerCorrectionTargets(x.env,x.plan,x.ports)).identitiesVerified,false);
});
test('a plan bound to payment headers stops if they change or cannot be read',async()=>{
  const x=fixture();x.plan.headerDigest=syntheticCorrectionHeaderDigest;
  assert.equal((await inspectOwnerCorrectionTargets(x.env,x.plan,x.ports)).identitiesVerified,false);
  x.ports.headers=async()=>syntheticCorrectionHeaders();x.ports.protection=async()=>true;assert.equal((await inspectOwnerCorrectionTargets(x.env,x.plan,x.ports)).identitiesVerified,true);
  x.ports.protection=async()=>false;assert.equal((await inspectOwnerCorrectionTargets(x.env,x.plan,x.ports)).identitiesVerified,false);x.ports.protection=async()=>true;
  x.ports.headers=async()=>[[],['changed'],[]];assert.equal((await inspectOwnerCorrectionTargets(x.env,x.plan,x.ports)).identitiesVerified,false);
});
