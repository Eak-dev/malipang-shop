import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parseExpenseText,autoCategory} from '../dist/expense/text-parser.js';

const now=new Date('2026-07-20T05:00:00Z');

const acceptedCases=[
  ['Thai cash quick save','ไข่ ทอน 375',{description:'ไข่',amountSatang:37500,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',transactionDate:'2026-07-20',quickSave:true}],
  ['English cash quick save','Egg change 500',{description:'Egg',amountSatang:50000,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',transactionDate:'2026-07-20',quickSave:true}],
  ['Thai transfer quick save','ค่าไฟ โอน 1,200.50',{description:'ค่าไฟ',amountSatang:120050,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'utilities',transactionDate:'2026-07-20',quickSave:true}],
  ['English transfer needs confirmation','ค่าไฟ transfer 1,200.50',{description:'ค่าไฟ',amountSatang:120050,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'utilities',transactionDate:'2026-07-20',quickSave:false}],
  ['Original English gas example','Gas transfer 371',{description:'Gas',amountSatang:37100,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'gas',transactionDate:'2026-07-20',quickSave:false}],
  ['card needs confirmation','กล่อง kbank 350',{description:'กล่อง',amountSatang:35000,paymentKey:'kbank',sourceWallet:'CARD_KBANK',category:'packaging',transactionDate:'2026-07-20',quickSave:false}],
  ['date without year','19/07 ไข่ ทอน 10',{description:'ไข่',amountSatang:1000,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',transactionDate:'2026-07-19',quickSave:true}],
  ['two digit year','19/07/26 นม ทอน 20',{description:'นม',amountSatang:2000,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',transactionDate:'2026-07-19',quickSave:true}],
  ['ISO date','2026-07-18 ค่าเช่า โอน 5000',{description:'ค่าเช่า',amountSatang:500000,paymentKey:'transfer',sourceWallet:'SHOP_BANK',category:'rent',transactionDate:'2026-07-18',quickSave:true}],
  ['multiword description without payment token','ซื้อของ เบ็ดเตล็ด 99',{description:'ซื้อของ เบ็ดเตล็ด',amountSatang:9900,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'general',transactionDate:'2026-07-20',quickSave:false}],
  ['unknown token is description not wallet','ไข่ ทอม 375',{description:'ไข่ ทอม',amountSatang:37500,paymentKey:'cash',sourceWallet:'CASH_DRAWER',category:'ingredients',transactionDate:'2026-07-20',quickSave:false}]
  ,['First Choice wallet mapping','กล่อง firstchoice 350',{description:'กล่อง',amountSatang:35000,paymentKey:'firstchoice',sourceWallet:'CARD_FIRST_CHOICE',category:'packaging',transactionDate:'2026-07-20',quickSave:false}]
  ,['The 1 wallet mapping','กล่อง t1 350',{description:'กล่อง',amountSatang:35000,paymentKey:'t1',sourceWallet:'CARD_THE1',category:'packaging',transactionDate:'2026-07-20',quickSave:false}]
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
const categoryGroups={
  utilities:['ค่าไฟ','ค่าน้ำ','อินเทอร์เน็ต','โทรศัพท์','electric','water','internet','phone','Wi-Fi'],
  packaging:['กล่อง','ถุง','ซีล','สติ๊กเกอร์','ซองกันชื้น','box','bag','seal','sticker','packaging','tape','gloves'],
  gas:['แก๊ส','lpg','alumax','gas cylinder','Gas'],
  rent:['ค่าเช่า','ค่าส่วนกลาง','rent','service charge','land tax'],
  staff:['ค่าแรง','เงินเดือน','salary','wage','payroll','labor'],
  transport:['ขนส่ง','ส่งของ','ค่าน้ำมัน','grab','delivery','shipping','parking','gasoline'],
  marketing:['โฆษณา','ป้าย','ยิงแอด','ads','facebook','poster','signage'],
  equipment:['เครื่อง','อุปกรณ์','ตะกร้อ','salad spinner','ช้อน','ส้อม','machine','equipment','tool'],
  ingredients:['แป้ง','ไข่','น้ำตาล','ยีสต์','นม','เนย','มาการีน','ไส้กรอก','แฮม','ชีส','flour','egg','sugar','yeast','milk','butter','ham','sausage','cheese','margarine'],
  fillings:['สังขยา','เผือก','ถั่วแดง','ฟิลลิ่ง','custard','taro','red bean','filling'],
  cleaning:['น้ำยาล้าง','ทำความสะอาด','cleaner','detergent','sponge'],
  bank_fee:['ค่าธรรมเนียม','bank fee','service fee','fee']
};
const cardAliasGroups={
  kbank:['kbank','kb','kasikorn'],firstchoice:['firstchoice','fc','first'],aeon:['aeon'],
  citibank:['citibank','citi'],ttb:['ttb','thanachart'],homepro:['homepro','hp'],t1:['t1','theone','the_one']
},cardWallets={kbank:'CARD_KBANK',firstchoice:'CARD_FIRST_CHOICE',aeon:'CARD_AEON',citibank:'CARD_CITIBANK',ttb:'CARD_TTB',homepro:'CARD_HOMEPRO',t1:'CARD_THE1'};

for(const [input,name] of rejectedCases){
  test(`rejects ${name}`,()=>assert.equal(parseExpenseText(input,now),null));
}

test('category aliases cover the shop master',()=>{
  for(const [category,descriptions] of Object.entries(categoryGroups))for(const description of descriptions)assert.equal(autoCategory(description),category,description);
  assert.equal(autoCategory('coffee beans'),'general','fee must not match inside coffee');
  assert.equal(autoCategory('bread'),'general','ad must not match inside bread');
  assert.equal(autoCategory('เบ็ดเตล็ด'),'general');
});

test('legacy card aliases map to canonical payment and wallet keys',()=>{
  for(const [paymentKey,tokens] of Object.entries(cardAliasGroups))for(const token of tokens){
    const parsed=parseExpenseText(`กล่อง ${token} 350`,now);
    assert.equal(parsed?.paymentKey,paymentKey,token);
    assert.equal(parsed?.sourceWallet,cardWallets[paymentKey],token);
    assert.equal(parsed?.quickSave,false,token);
  }
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
  for(const [paymentKey,tokens] of Object.entries(cardAliasGroups))for(const token of tokens){
    await t.test(`card alias ${token}`,async()=>{
      const result=await evaluate(`กล่อง ${token} 350`);
      assert.equal(result.accepted,true);
      assert.equal(result.parsed.paymentKey,paymentKey);
      assert.equal(result.parsed.sourceWallet,cardWallets[paymentKey]);
    });
  }
  for(const [category,descriptions] of Object.entries(categoryGroups))for(const description of descriptions){
    await t.test(`category ${category}: ${description}`,async()=>{
      const result=await evaluate(`${description} 1`);
      assert.equal(result.accepted,true);
      assert.equal(result.parsed.category,category);
    });
  }
});
