import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareSameMonthCorrectionPlan,prepareVerifiedSameMonthCorrectionPlan} from '../dist/sheets/owner-correction-plan-service.js';
import {syntheticCorrectionReport} from './helpers/owner-correction-periods.mjs';
const before={expenseId:'exp_plan',status:'CONFIRMED',version:1,updatedAt:null,description:'Driver',category:'general',amountSatang:200000,transactionDate:'2026-10-28',paymentKey:'transfer',sourceWallet:'SHOP_BANK'};
const after={...before,category:'transport'};
function fixture(){
  const body=Array.from({length:12},()=>[]);body[1]=Array(8).fill(null);body[1][7]='เงินโอน';body[4]=[2026];body[5]=[null,10,null,'รายรับทั้งหมดในบัญชี'];body[10]=['รวม',10];
  const daily=Array(23).fill(null);Object.assign(daily,{1:10,2:28,3:'Driver',7:2000,21:'general',22:'บัญชีร้าน'});body[7]=daily;
  const raw=['exp_plan','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED'];
  const links=[{metadataId:1,target:{sheetId:1,rowIndex:7,key:'malipang_expense_daily',value:'exp_plan'}},{metadataId:2,target:{sheetId:2,rowIndex:1,key:'malipang_expense_raw',value:'exp_plan'}}];
  const rows=new Map([[1,daily],[2,raw]]),expense={expense_id:'exp_plan',status:'CONFIRMED',version:1,updated_at:null,description:'Driver',category:'general',amount_satang:200000,transaction_date:'2026-10-28',payment_key:'transfer',source_wallet:'SHOP_BANK'};
  let inspected=true;
  const ports={existing:async()=>links,values:async()=>body,sheetId:async()=>3,rows:async()=>rows,expense:async()=>({expense,document:null,items:[]}),inspect:async()=>({identitiesVerified:inspected,rows})};
  return {env:{SHEET_EXPENSE_DAILY:'daily',SHEET_PURCHASE_DETAILS:'detail'},ports,expense,stop:()=>{inspected=false}};
}
test('builds a same-month plan from verified real-shaped sheet rows without writing',async()=>{
  const f=fixture(),plan=await prepareSameMonthCorrectionPlan(f.env,before,after,'corr',f.ports);
  assert.equal(plan.expenseId,'exp_plan');assert.equal(plan.rebind,null);assert.equal(plan.patches.find(x=>x.metadataId===2).cells[0].value,'transport');
  assert.deepEqual(plan.patches.find(x=>x.metadataId===1).cells,[{columnIndex:21,value:'transport'}]);
  f.stop();assert.equal(await prepareSameMonthCorrectionPlan(f.env,before,after,'corr',f.ports),null);
});
test('same-month planning covers description, amount, date and payment corrections',async()=>{
  for(const changed of [{description:'Taxi'},{amountSatang:205050},{transactionDate:'2026-10-29'},{paymentKey:'cash',sourceWallet:'CASH_DRAWER'}]){
    const f=fixture(),plan=await prepareSameMonthCorrectionPlan(f.env,before,{...before,...changed},'corr',f.ports);
    assert.ok(plan);assert.equal(plan.rebind,null);assert.equal(plan.patches.length,2);
    if(changed.amountSatang)assert.deepEqual(plan.patches.find(x=>x.metadataId===1).cells,[{columnIndex:7,value:2050.5}]);
  }
});
test('rejects stale database data and never plans an unreserved move',async()=>{
  const f=fixture();f.expense.version=2;assert.equal(await prepareSameMonthCorrectionPlan(f.env,before,after,'corr',f.ports),null);f.expense.version=1;
  await assert.rejects(prepareSameMonthCorrectionPlan(f.env,before,{...before,transactionDate:'2026-11-02'},'corr',f.ports),/MONTH_BLOCK|DESTINATION/);
  const load=f.ports.existing;let calls=0;f.ports.existing=async(...args)=>{const links=await load(...args);return ++calls===1?links:links.map((link,index)=>index?link:{...link,target:{...link.target,rowIndex:link.target.rowIndex+1}})};
  assert.equal(await prepareSameMonthCorrectionPlan(f.env,before,after,'corr',f.ports),null);
});
test('a commit-ready plan requires two identical report baselines and same calendar month',async()=>{
  const f=fixture(),ports={plan:(env,b,a,id)=>prepareSameMonthCorrectionPlan(env,b,a,id,f.ports),report:async()=>syntheticCorrectionReport(before)};
  const plan=await prepareVerifiedSameMonthCorrectionPlan(f.env,before,after,'corr',ports);assert.ok(plan?.reportBaseline);assert.equal(plan.reportBaseline.category,'general');
  let reads=0;ports.report=async()=>{const r=syntheticCorrectionReport(before);if(++reads===2)r.total++;return r};
  assert.equal(await prepareVerifiedSameMonthCorrectionPlan(f.env,before,after,'corr',ports),null);
  assert.equal(await prepareVerifiedSameMonthCorrectionPlan(f.env,before,{...before,transactionDate:'2026-11-01'},'corr',ports),null);
});
