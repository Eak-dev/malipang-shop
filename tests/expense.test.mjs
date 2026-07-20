import test from 'node:test';
import assert from 'node:assert/strict';
import {parseExpenseText,autoCategory} from '../dist/expense/text-parser.js';
const now=new Date('2026-07-20T05:00:00Z');
test('Thai change saves immediately to cash drawer',()=>{const r=parseExpenseText('ไข่ ทอน 375',now);assert.equal(r?.quickSave,true);assert.equal(r?.amountSatang,37500);assert.equal(r?.sourceWallet,'CASH_DRAWER');});
test('transfer requires confirmation',()=>{const r=parseExpenseText('ค่าไฟ โอน 1,200.50',now);assert.equal(r?.quickSave,false);assert.equal(r?.amountSatang,120050);assert.equal(r?.sourceWallet,'SHOP_BANK');assert.equal(r?.category,'utilities');});
test('English change is supported',()=>{const r=parseExpenseText('Egg change 500',now);assert.equal(r?.quickSave,true);assert.equal(r?.description,'Egg');});
test('date prefix is parsed and invalid calendar dates are rejected',()=>{assert.equal(parseExpenseText('19/07 ไข่ ทอน 10',now)?.transactionDate,'2026-07-19');assert.equal(parseExpenseText('31/02 ไข่ ทอน 10',now),null);});
test('actual category master aliases are covered',()=>{assert.equal(autoCategory('แก๊สถัง ALUMAX'),'gas');assert.equal(autoCategory('ซองกันชื้น'),'packaging');assert.equal(autoCategory('สังขยา'),'fillings');});
