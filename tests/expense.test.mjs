import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseExpenseText,autoCategory} from '../dist/expense/text-parser.js';

const now=new Date('2026-07-20T05:00:00Z');

const acceptedCases=[
  ['Thai cash quick save','ไข่ ทอน 375',{description:'ไข่',amountSatang:37500,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',transactionDate:'2026-07-20',quickSave:true}],
  ['English cash quick save','Egg change 500',{description:'Egg',amountSatang:50000,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',transactionDate:'2026-07-20',quickSave:true}],
  ['transfer needs confirmation','ค่าไฟ โอน 1,200.50',{description:'ค่าไฟ',amountSatang:120050,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'utilities',transactionDate:'2026-07-20',quickSave:false}],
  ['card needs confirmation','กล่อง kbank 350',{description:'กล่อง',amountSatang:35000,paymentKey:'kbank',sourceWallet:'CARD_KBANK',category:'packaging',transactionDate:'2026-07-20',quickSave:false}],
  ['date without year','19/07 ไข่ ทอน 10',{description:'ไข่',amountSatang:1000,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',transactionDate:'2026-07-19',quickSave:true}],
  ['two digit year','19/07/26 นม ทอน 20',{description:'นม',amountSatang:2000,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',transactionDate:'2026-07-19',quickSave:true}],
  ['ISO date','2026-07-18 ค่าเช่า โอน 5000',{description:'ค่าเช่า',amountSatang:500000,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'rent',transactionDate:'2026-07-18',quickSave:false}],
  ['multiword description without payment token','ซื้อของ เบ็ดเตล็ด 99',{description:'ซื้อของ เบ็ดเตล็ด',amountSatang:9900,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'general',transactionDate:'2026-07-20',quickSave:false}],
  ['unknown token is description not wallet','ไข่ ทอม 375',{description:'ไข่ ทอม',amountSatang:37500,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',transactionDate:'2026-07-20',quickSave:false}]
];

for(const [name,input,expected] of acceptedCases){
  test(name,()=>assert.deepEqual(parseExpenseText(input,now),expected));
}

const rejectedCases=[
  ['', 'empty text'],
  ['ไข่', 'missing amount'],
  ['ไข่ ทอน 0', 'zero amount'],
  ['ไข่ ทอน -10', 'negative amount'],
  ['ไข่ ทอน abc', 'non numeric amount'],
  ['ไข่ ทอน 0.001', 'more than two decimals'],
  ['ไข่ ทอน 1,2,00', 'bad comma grouping'],
  ['31/02 ไข่ ทอน 10', 'impossible date'],
  ['2026-13-01 ไข่ ทอน 10', 'invalid ISO month']
];

for(const [input,name] of rejectedCases){
  test(`rejects ${name}`,()=>assert.equal(parseExpenseText(input,now),null));
}

test('category aliases cover the shop master',()=>{
  const cases=[
    ['ค่าไฟ','utilities'],['Wi-Fi','utilities'],['โทรศัพท์','utilities'],
    ['สติกเกอร์','packaging'],['แก๊สถัง ALUMAX','gas'],['ค่าเช่า','rent'],
    ['ค่าน้ำมัน','transport'],['แป้ง','ingredients'],['สังขยา','fillings'],
    ['ซ่อมเครื่อง','equipment'],['ค่าแรง','staff'],['เบ็ดเตล็ด','general']
  ];
  for(const [description,category] of cases)assert.equal(autoCategory(description),category,description);
});

const liveBaseUrl=String(process.env.MALIPANG_EXPENSE_BASE_URL||'').replace(/\/$/,'');
const liveTokenFile=process.env.MALIPANG_ADMIN_TOKEN_FILE;

test('live Worker expense evaluator matches the complete text matrix',{
  skip:!liveBaseUrl||!liveTokenFile
},async t=>{
  const adminToken=(await readFile(liveTokenFile,'utf8')).trim();
  assert.ok(adminToken.length>=32,'admin token is missing or too short');
  const evaluate=async text=>{
    const response=await fetch(`${liveBaseUrl}/admin/expense/evaluate`,{
      method:'POST',
      headers:{authorization:`Bearer ${adminToken}`,'content-type':'application/json'},
      body:JSON.stringify({text,now:now.toISOString()})
    });
    const result=await response.json();
    assert.equal(response.ok,true,`HTTP ${response.status}: ${result.error||''}`);
    assert.equal(result.ok,true);
    return result;
  };

  for(const [name,input,expected] of acceptedCases){
    await t.test(name,async()=>{
      const result=await evaluate(input);
      assert.equal(result.accepted,true);
      assert.equal(result.action,expected.quickSave?'SAVE_NOW':'CONFIRM');
      assert.deepEqual(result.parsed,expected);
    });
  }
  for(const [input,name] of rejectedCases){
    await t.test(`rejects ${name}`,async()=>{
      const result=await evaluate(input);
      assert.equal(result.accepted,false);
      assert.equal(result.action,'REJECT');
      assert.equal(result.parsed,null);
    });
  }
});
