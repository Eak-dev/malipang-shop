import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const cases=JSON.parse(await readFile(new URL('./fixtures/bank-slip-cases.json',import.meta.url),'utf8'));
const baseUrl=String(process.env.MALIPANG_VISION_BASE_URL||'').replace(/\/$/,'');
const tokenFile=process.env.MALIPANG_ADMIN_TOKEN_FILE||'';
const imageMap=process.env.MALIPANG_BANK_SLIP_IMAGE_MAP?JSON.parse(process.env.MALIPANG_BANK_SLIP_IMAGE_MAP):{};

test('bank slip fixture contract covers KBank, SCB, and Paotang',()=>{
  assert.deepEqual(cases.map(item=>item.id),['kbank-kplus','scb-easy','paotang-gwallet']);
  assert.deepEqual(new Set(cases.map(item=>item.expected.channel)),new Set(['BANK','G_WALLET']));
  for(const item of cases){assert.ok(item.expected.paidAmountBaht>0);assert.match(item.expected.paymentDate,/^\d{4}-\d{2}-\d{2}$/);}
});

test('live OpenAI evaluator extracts every supplied bank slip',{skip:!baseUrl||!tokenFile||cases.some(item=>!imageMap[item.id])},async t=>{
  const token=(await readFile(tokenFile,'utf8')).trim();
  for(const item of cases){await t.test(item.id,async t=>{
    const image=await readFile(imageMap[item.id]);
    const response=await fetch(`${baseUrl}/admin/vision/evaluate?provider=openai&model=gpt-4.1-mini`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'image/jpeg'},body:image});
    const result=await response.json();
    assert.equal(response.ok,true,`${response.status}: ${result.error||''}`);
    assert.equal(result.reading.kind,item.expected.kind);
    assert.equal(result.reading.document.channel,item.expected.channel);
    assert.equal(result.reading.document.paymentDate,item.expected.paymentDate);
    assert.equal(result.reading.document.paymentTime,item.expected.paymentTime);
    assert.equal(result.reading.document.paidAmountBaht,item.expected.paidAmountBaht);
    assert.ok(item.expected.institutionAliases.some(alias=>result.reading.document.institution.toLowerCase().includes(alias)),result.reading.document.institution);
    assert.ok(item.expected.allowedCategories.includes(result.reading.document.suggestedCategory),result.reading.document.suggestedCategory);
    assert.equal(result.documentValidation.ok,true,JSON.stringify(result.documentValidation));
    if('grossAmountBaht' in item.expected)assert.equal(result.reading.document.grossAmountBaht,item.expected.grossAmountBaht);
    if('discountAmountBaht' in item.expected)assert.equal(result.reading.document.discountAmountBaht,item.expected.discountAmountBaht);
    t.diagnostic(JSON.stringify({institution:result.reading.document.institution,date:result.reading.document.paymentDate,time:result.reading.document.paymentTime,paid:result.reading.document.paidAmountBaht,category:result.reading.document.suggestedCategory,referencePresent:Boolean(result.reading.document.referenceId)}));
  });}
});
