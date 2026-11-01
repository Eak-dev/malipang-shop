import test from 'node:test';
import assert from 'node:assert/strict';
import {planDailyCategoryProjection} from '../dist/sheets/daily-category-projection.js';

const raw=()=>({metadataId:10,sheetId:1,metadataKey:'malipang_expense_raw',metadataValue:'exp',values:['exp',null,null,null,null,null,'general','CONFIRMED']});
const detail=()=>{const values=Array(17).fill(null);values[0]='item';values[1]='exp';values[14]='general';values[16]='CONFIRMED';return {metadataId:11,sheetId:2,metadataKey:'malipang_expense_item',metadataValue:'item',values}};
const input=()=>({expenseId:'exp',expenseVersion:2,jobVersion:2,status:'CONFIRMED',fromCategory:'general',toCategory:'transport',currentCategory:'transport',rawSheetId:1,detailSheetId:2,raw:raw(),details:[detail()],expectedItemIds:['item']});

test('projects only category cells on verified raw and item rows',()=>{
  assert.deepEqual(planDailyCategoryProjection(input()),[{metadataId:10,columnIndex:6,value:'transport'},{metadataId:11,columnIndex:14,value:'transport'}]);
  const replay=input();replay.raw.values[6]='transport';replay.details[0].values[14]='transport';assert.equal(planDailyCategoryProjection(replay).length,2);
});

test('stale versions, moved or missing identities and concurrent category edits fail closed',()=>{
  for(const mutate of [x=>x.expenseVersion++,x=>x.raw.values[0]='different',x=>x.raw.values[6]='rent',x=>x.raw.sheetId=2,x=>x.details[0].metadataValue='different',x=>x.details[0].values[1]='different',x=>x.details[0].values[14]='rent',x=>x.details[0].metadataId=10,x=>x.expectedItemIds.push('missing'),x=>x.status='CANCELLED']){
    const x=input();mutate(x);assert.throws(()=>planDailyCategoryProjection(x));
  }
});
