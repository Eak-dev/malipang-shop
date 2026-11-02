import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {ownerOrderFixture} from './helpers/owner-order-review.mjs';
const require=createRequire(import.meta.url),client=require('../dist/sheets/client.js'),{mapDailyCapacityExpansion,writeConfirmedExpenseToDaily}=require('../dist/sheets/daily-expense.js');
const marker='__MALIPANG_CAPACITY_10_10__',now='2026-11-02T00:00:00.000Z';
function setup(){const h=ownerOrderFixture();h.env.SHEET_EXPENSE_DAILY='daily';
  h.sqlite.prepare(`INSERT INTO daily_sheet_capacity_expansions(sheet_name,month,anchor_total_row,marker,state,created_at,updated_at) VALUES('daily',10,10,?,'PREPARED',?,?)`).run(marker,now,now);
  for(const [key,row] of [['exp_a',9],['exp_b',10],['exp_c',11]])h.sqlite.prepare('INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)').run('daily',key,row);
  return h;
}
const rows=h=>h.sqlite.prepare("SELECT entity_key,row_number FROM sheet_row_index WHERE sheet_name='daily' ORDER BY entity_key").all();
test('adjacent mapped rows shift atomically once without unique-index collisions',async()=>{
  const h=setup();try{
    assert.equal(await mapDailyCapacityExpansion(h.env,10,10,marker,now),true);assert.deepEqual(rows(h).map(row=>row.row_number),[9,11,12]);assert.equal(h.sqlite.prepare('SELECT state FROM daily_sheet_capacity_expansions').get().state,'MAPPED');
    assert.equal(await mapDailyCapacityExpansion(h.env,10,10,marker,now),false);assert.deepEqual(rows(h).map(row=>row.row_number),[9,11,12]);
  }finally{h.close()}
});
test('every failed mapping batch rolls back the expansion state and every row',async()=>{
  for(let index=0;index<5;index++){const h=setup();try{const before=rows(h);h.DB.failAt=index;await assert.rejects(mapDailyCapacityExpansion(h.env,10,10,marker,now),/fixture batch failure/);h.DB.failAt=null;assert.deepEqual(rows(h),before);assert.equal(h.sqlite.prepare('SELECT state FROM daily_sheet_capacity_expansions').get().state,'PREPARED')}finally{h.close()}}
});
test('unexpected nonpositive mappings stop the operation without changing any row',async()=>{
  const h=setup();try{h.sqlite.prepare('INSERT INTO sheet_row_index(sheet_name,entity_key,row_number) VALUES(?,?,?)').run('daily','exp_invalid',-20);const before=rows(h);
    await assert.rejects(mapDailyCapacityExpansion(h.env,10,10,marker,now));assert.deepEqual(rows(h),before);assert.equal(h.sqlite.prepare('SELECT state FROM daily_sheet_capacity_expansions').get().state,'PREPARED');
  }finally{h.close()}
});
test('a mapped expansion with a missing marker never inserts another sheet row',async()=>{
  const h=ownerOrderFixture(),oldRead=client.batchGetSheetValues,oldUpdate=client.batchUpdateSpreadsheet;try{
    Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily'});
    h.sqlite.prepare(`INSERT INTO daily_sheet_capacity_expansions(sheet_name,month,anchor_total_row,marker,state,created_at,updated_at) VALUES('daily',10,8,?,'MAPPED',?,?)`).run(marker,now,now);
    const body=Array.from({length:9},()=>[]),headers=[[],Array(8).fill(null),[]];body[5]=[null,10,null,'รายรับทั้งหมดในบัญชี'];body[6]=[null,10,1,'Occupied'];body[7]=['รวม',10];headers[1][7]='เงินโอน';
    client.batchGetSheetValues=async()=>[structuredClone(body),structuredClone(headers)];let inserts=0;client.batchUpdateSpreadsheet=async()=>{inserts++};
    const record={expenseId:'exp_synthetic_new',transactionDate:'2026-10-28',description:'Synthetic',amountBaht:100,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'general'};
    await assert.rejects(writeConfirmedExpenseToDaily(h.env,record),/capacity marker missing/);assert.equal(inserts,0);assert.equal(h.sqlite.prepare('SELECT state FROM daily_sheet_capacity_expansions').get().state,'MAPPED');assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM sheet_row_index WHERE entity_key='exp_synthetic_new'").get().n,0);
  }finally{client.batchGetSheetValues=oldRead;client.batchUpdateSpreadsheet=oldUpdate;h.close()}
});
test('a moved capacity marker is held before changing row mappings',async()=>{
  const h=ownerOrderFixture(),oldRead=client.batchGetSheetValues,oldUpdate=client.batchUpdateSpreadsheet;try{
    Object.assign(h.env,{OWNER_EXPENSE_CORRECTION_ENABLED:'true',SHEET_EXPENSE_DAILY:'daily'});
    h.sqlite.prepare(`INSERT INTO daily_sheet_capacity_expansions(sheet_name,month,anchor_total_row,marker,state,created_at,updated_at) VALUES('daily',10,8,?,'PREPARED',?,?)`).run(marker,now,now);
    const body=Array.from({length:9},()=>[]),headers=[[],Array(8).fill(null),[]];body[5]=[null,10,null,'รายรับทั้งหมดในบัญชี'];body[6]=[marker,10,1,''];body[7]=['รวม',10];headers[1][7]='เงินโอน';
    client.batchGetSheetValues=async()=>[structuredClone(body),structuredClone(headers)];let inserts=0;client.batchUpdateSpreadsheet=async()=>{inserts++};
    const record={expenseId:'exp_synthetic_new',transactionDate:'2026-10-28',description:'Synthetic',amountBaht:100,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'general'};
    await assert.rejects(writeConfirmedExpenseToDaily(h.env,record),/capacity marker moved/);assert.equal(inserts,0);assert.equal(h.sqlite.prepare('SELECT state FROM daily_sheet_capacity_expansions').get().state,'PREPARED');assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM sheet_row_index').get().n,0);
  }finally{client.batchGetSheetValues=oldRead;client.batchUpdateSpreadsheet=oldUpdate;h.close()}
});
