import test from 'node:test';
import assert from 'node:assert/strict';
import {planDailyCategoryBootstrap} from '../dist/sheets/daily-category-bootstrap.js';

const expense={expenseId:'exp',postingYear:2026,postingMonth:10,postingDay:28,description:'Driver',amountSatang:200000,amountColumn:7,category:'general',transactionDate:'2026-10-28',version:1,itemIds:[]};
const daily=()=>{const v=Array(23).fill(null);v[1]=10;v[2]=28;v[3]='Driver';v[7]=2000;v[21]='general';return {sheetId:1,rowNumber:100,sheetYear:2026,values:v}};
const raw=()=>({sheetId:2,rowNumber:5,values:['exp','2026-10-28','Driver',2000,'transfer','SHOP_BANK','general','CONFIRMED']});

test('bootstrap requires an unambiguous exact daily and raw snapshot',()=>{
  const p=planDailyCategoryBootstrap([expense],[daily()],[raw()],[],[])[0];assert.equal(p.kind,'READY');assert.equal(p.targets.length,2);
  assert.equal(planDailyCategoryBootstrap([expense],[daily(),{...daily(),rowNumber:101}],[raw()],[],[])[0].reason,'DAILY_IDENTITY_AMBIGUOUS');
  const changed=raw();changed.values[3]=2001;assert.equal(planDailyCategoryBootstrap([expense],[daily()],[changed],[],[])[0].reason,'RAW_SNAPSHOT_DIFFERS');
  const changedDaily=daily();changedDaily.values[21]='transport';assert.equal(planDailyCategoryBootstrap([expense],[changedDaily],[raw()],[],[])[0].reason,'DAILY_CATEGORY_DIFFERS');
});
test('bootstrap does not skip missing or duplicated receipt detail rows',()=>{
  const withItem={...expense,itemIds:['item']};assert.equal(planDailyCategoryBootstrap([withItem],[daily()],[raw()],[],[])[0].reason,'DETAIL_SNAPSHOT_DIFFERS');
  const v=Array(17).fill(null);v[0]='item';v[1]='exp';v[14]='general';v[16]='CONFIRMED';
  const detail={sheetId:3,rowNumber:4,values:v};assert.equal(planDailyCategoryBootstrap([withItem],[daily()],[raw()],[detail],[])[0].kind,'READY');
  assert.equal(planDailyCategoryBootstrap([withItem],[daily()],[raw()],[detail,{...detail,rowNumber:5}],[])[0].reason,'DETAIL_SNAPSHOT_DIFFERS');
});
