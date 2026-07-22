import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateRows,dailyInputRanges,findMonthBlocks,legacySourceWallet,resolvePayment} from '../dist/sheets/daily-expense.js';

function liveHeaders(){
  const rows=[Array(23).fill(''),Array(23).fill(''),Array(23).fill('')];
  rows[1][5]='เงินสด';rows[1][7]='เงินโอน';
  rows[2][5]='FIXED';rows[2][6]='NON-FIXED';
  const cards=[['Kbank',17],['First Choice',24],['Aeon',24],['Cibit Bank',13],['Thanachart',22],['Homepro',15],['The One',15]];
  cards.forEach(([name,cutoff],i)=>{rows[2][10+i]=name;rows[1][10+i]=cutoff;});
  return rows;
}

test('finds only empty detail rows inside the requested month block',()=>{
  const body=[
    ['',7,'','รายรับทั้งหมดในบัญชี'],
    ['',7,21,'ไข่'],
    ['',7,'',''],
    ['รวม',7,'',''],
    ['',8,'','รายรับทั้งหมดในบัญชี'],
    ['',8,'',''],
    ['รวม',8,'','']
  ];
  const blocks=findMonthBlocks(body);
  assert.deepEqual(blocks,[{month:7,headerRow:1,totalRow:4},{month:8,headerRow:5,totalRow:7}]);
  assert.deepEqual(candidateRows(body,blocks,7),[3]);
  assert.deepEqual(candidateRows(body,blocks,8),[6]);
});

test('cash and transfer map to live daily columns without shifting month',()=>{
  const headers=liveHeaders();
  assert.deepEqual(resolvePayment(headers,'cash',2026,7,22),{amountColumn:'G',postingMonth:7,postingYear:2026,postingDay:22});
  assert.deepEqual(resolvePayment(headers,'transfer',2026,7,22),{amountColumn:'H',postingMonth:7,postingYear:2026,postingDay:22});
});

test('credit cards use K-Q headers, cutoff dates, month shift, and day clamp',()=>{
  const headers=liveHeaders();
  assert.equal(resolvePayment(headers,'kbank',2026,7,17).amountColumn,'K');
  assert.deepEqual(resolvePayment(headers,'kbank',2026,7,18),{amountColumn:'K',postingMonth:8,postingYear:2026,postingDay:18});
  assert.deepEqual(resolvePayment(headers,'kbank',2026,1,31),{amountColumn:'K',postingMonth:2,postingYear:2026,postingDay:28});
  assert.equal(resolvePayment(headers,'firstchoice',2026,7,22).amountColumn,'L');
  assert.equal(resolvePayment(headers,'aeon',2026,7,22).amountColumn,'M');
  assert.equal(resolvePayment(headers,'citibank',2026,7,22).amountColumn,'N');
  assert.equal(resolvePayment(headers,'ttb',2026,7,22).amountColumn,'O');
  assert.equal(resolvePayment(headers,'homepro',2026,7,22).amountColumn,'P');
  assert.equal(resolvePayment(headers,'t1',2026,7,22).amountColumn,'Q');
});

test('daily writes and undo clear only legacy input cells, never formula columns',()=>{
  const ranges=dailyInputRanges('รายวัน',769);
  assert.deepEqual(ranges,["'รายวัน'!B769:D769","'รายวัน'!F769:H769","'รายวัน'!K769:Q769","'รายวัน'!V769:W769"]);
  for(const protectedColumn of ['I','J','R','S','U'])assert.equal(ranges.some(range=>range.includes(`${protectedColumn}769`)),false);
  assert.equal(legacySourceWallet('cash','CASH_DRAWER'),'ทอน/หน้าร้าน');
  assert.equal(legacySourceWallet('transfer','SHOP_BANK'),'บัญชีร้าน');
});

test('refuses a full month instead of overwriting the total row',()=>{
  const body=[['',7,'','รายรับทั้งหมดในบัญชี'],['',7,22,'used'],['รวม',7,'','']];
  assert.throws(()=>candidateRows(body,findMonthBlocks(body),7),/no empty expense row/);
});
