import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDailyExpenseEntries,buildDailySheetWritePlan,candidateRows,dailyInputRanges,findMonthBlocks,isDailyExpenseMappingKey,legacySourceWallet,monthCapacityExpansionRequests,requiredMonthlyCapacityExpansions,resolvePayment} from '../dist/sheets/daily-expense.js';
import {buildExpenseRawSheetValues} from '../dist/sheets/sync.js';

function liveHeaders(){
  const rows=[Array(23).fill(''),Array(23).fill(''),Array(23).fill('')];
  rows[1][5]='เงินสด';rows[1][7]='เงินโอน';
  rows[2][5]='FIXED';rows[2][6]='NON-FIXED';
  const cards=[['Kbank',17],['First Choice',24],['Aeon',24],['Cibit Bank',13],['Thanachart',22],['Homepro',15],['The One',15]];
  cards.forEach(([name,cutoff],i)=>{rows[2][10+i]=name;rows[1][10+i]=cutoff;});
  return rows;
}

function receiptRecord(overrides={}){return{expenseId:'exp_receipt_180',transactionDate:'2026-07-27',description:'Baker supply purchase',amountBaht:180,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',...overrides};}
function receiptDocument(overrides={}){return{documentId:'doc_receipt_1',documentType:'RECEIPT',vendorName:'Makro',legalVendorName:'Makro',documentNumber:'008901508651',orderId:'',...overrides};}
function receiptItem(index,overrides={}){return{itemId:`item_${index}`,documentId:'doc_receipt_1',expenseId:'exp_receipt_180',sellerKey:'Makro',productCode:`SKU-${index}`,description:`Item ${index}`,quantity:1,unit:'pcs',unitPriceSatang:4500,discountSatang:0,lineTotalSatang:4500,...overrides};}

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

test('a full month is detected for formula-safe expansion instead of overwriting the total row',()=>{
  const body=[['',7,'','รายรับทั้งหมดในบัญชี'],['',7,22,'used'],['รวม',7,'','']];
  assert.deepEqual(candidateRows(body,findMonthBlocks(body),7),[]);
  assert.deepEqual(monthCapacityExpansionRequests(123,3),[
    {insertDimension:{range:{sheetId:123,dimension:'ROWS',startIndex:2,endIndex:3},inheritFromBefore:true}},
    {copyPaste:{source:{sheetId:123,startRowIndex:1,endRowIndex:2,startColumnIndex:0,endColumnIndex:23},destination:{sheetId:123,startRowIndex:2,endRowIndex:3,startColumnIndex:0,endColumnIndex:23},pasteType:'PASTE_NORMAL',pasteOrientation:'NORMAL'}}
  ]);
});

test('confirmed receipt posts exactly one 180 baht summary row in รายวัน',()=>{
  const plan=buildDailyExpenseEntries(receiptRecord(),receiptDocument(),[1,2,3,4].map(receiptItem));
  assert.equal(plan.mode,'SUMMARY');
  assert.equal(plan.entries.length,1);
  assert.deepEqual(plan.entries.map(entry=>entry.rowKey),['exp_receipt_180']);
  assert.equal(plan.entries.reduce((total,entry)=>total+entry.amountBaht,0),180);
});

test('a long unseen-vendor invoice remains one daily cash-outflow row',()=>{
  const record=receiptRecord({expenseId:'exp_kcc',amountBaht:1341,description:'KCC purchase'});
  const document=receiptDocument({documentId:'doc_kcc',documentType:'TAX_INVOICE',vendorName:'KCC',documentNumber:'S26001-007778'});
  const items=[
    receiptItem(1,{documentId:'doc_kcc',expenseId:'exp_kcc',description:'แฮมหมูใหญ่ 1 กก. ศรีไทย',quantity:1,unit:'กก.',unitPriceSatang:121500,lineTotalSatang:121500}),
    receiptItem(2,{documentId:'doc_kcc',expenseId:'exp_kcc',description:'ถุงบรรจุภัณฑ์',quantity:1,unit:'แพ็ค',unitPriceSatang:7800,lineTotalSatang:7800}),
    receiptItem(3,{documentId:'doc_kcc',expenseId:'exp_kcc',description:'อุปกรณ์',quantity:1,unit:'ชิ้น',unitPriceSatang:4800,lineTotalSatang:4800})
  ];
  const plan=buildDailyExpenseEntries(record,document,items);
  assert.equal(plan.mode,'SUMMARY');
  assert.equal(plan.entries.length,1);
  assert.equal(plan.entries[0].amountBaht,1341);
});

test('retry and reconciliation produce the same summary row plan without touching formulas',()=>{
  const record=receiptRecord(),entries=buildDailyExpenseEntries(record,receiptDocument(),[1,2,3,4].map(receiptItem)).entries;
  const rows=new Map(entries.map((entry,index)=>[entry.rowKey,100+index]));
  const payment=resolvePayment(liveHeaders(),'cash',2026,7,27);
  const first=buildDailySheetWritePlan('รายวัน',record,payment,'ทอน/หน้าร้าน',entries,rows);
  const retry=buildDailySheetWritePlan('รายวัน',record,payment,'ทอน/หน้าร้าน',entries,rows);
  assert.deepEqual(retry,first);
  assert.equal(first.writes.length,3,'three bounded writes for the one summary row');
  assert.equal(first.clearRanges.length,4,'four formula-safe clear ranges for one row');
  for(const protectedColumn of ['I','J','R','S','U'])assert.equal(first.clearRanges.some(range=>range.includes(`${protectedColumn}10`)),false,protectedColumn);
});

test('items, document discount, Paotang subsidy and Shopee list-price mismatch always preserve one final summary amount',()=>{
  const missing=buildDailyExpenseEntries(receiptRecord(),receiptDocument(),[]);
  assert.equal(missing.mode,'SUMMARY');
  const discounted=buildDailyExpenseEntries(receiptRecord({amountBaht:160}),receiptDocument(),[1,2,3,4].map(receiptItem));
  assert.equal(discounted.mode,'SUMMARY');
  const paotang=buildDailyExpenseEntries(receiptRecord({expenseId:'exp_paotang',amountBaht:132}),receiptDocument({documentId:'doc_paotang'}),[receiptItem(1,{documentId:'doc_paotang',expenseId:'exp_paotang',lineTotalSatang:33000,unitPriceSatang:33000})]);
  assert.equal(paotang.mode,'SUMMARY');
  assert.equal(paotang.entries[0].amountBaht,132);
  const shopee=buildDailyExpenseEntries(receiptRecord({expenseId:'exp_shopee',amountBaht:356}),receiptDocument({documentId:'doc_shopee',documentType:'ONLINE_ORDER'}),[receiptItem(1,{documentId:'doc_shopee',expenseId:'exp_shopee',lineTotalSatang:47500,unitPriceSatang:47500})]);
  assert.equal(shopee.mode,'SUMMARY');
  assert.equal(shopee.entries[0].amountBaht,356);
});

test('delivery orders cannot duplicate a linked purchase and remain one daily summary when finalized',()=>{
  const plan=buildDailyExpenseEntries(receiptRecord(),receiptDocument({documentType:'DELIVERY_ORDER'}),[1,2,3,4].map(receiptItem));
  assert.equal(plan.mode,'SUMMARY');
  assert.equal(plan.entries.length,1);
});

test('capacity requirement remains formula-safe for a single summary row',()=>{
  assert.equal(requiredMonthlyCapacityExpansions(0,1),1);
  assert.equal(requiredMonthlyCapacityExpansions(1,1),0);
});

test('cancel scope includes every item mapping and only that Expense mappings',()=>{
  assert.deepEqual(['exp_1','exp_1|item_a','exp_1|item_b','exp_10|item_a'].filter(key=>isDailyExpenseMappingKey('exp_1',key)),['exp_1','exp_1|item_a','exp_1|item_b']);
});

test('V52_EXPENSE_RAW and รายวัน are each exactly one summary row per Expense',()=>{
  const values=buildExpenseRawSheetValues({expense_id:'exp_1',transaction_date:'2026-07-27',description:'Receipt purchase',amount_satang:18000,payment_key:'cash',source_wallet:'CASH_DRAWER',category:'ingredients',status:'CONFIRMED',message_id:'msg_1',trace_id:'trace_1',submitted_by_employee_id:'EMP001',branch_id:'B001'},{document_id:'doc_1',document_type:'RECEIPT',vendor_name:'Makro',document_number:'008901508651',order_id:''});
  assert.equal(values.length,17);
  assert.equal(values[0],'exp_1');
  assert.equal(values[3],180);
  assert.equal(values[12],'doc_1');
});
