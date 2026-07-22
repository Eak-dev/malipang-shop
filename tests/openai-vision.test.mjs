import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOpenAIVisionPayload,normalizeOpenAIVisionResult} from '../dist/vision/openai.js';

test('OpenAI fallback uses the proven MaliPang clock contract',()=>{
  const payload=buildOpenAIVisionPayload('gpt-4o-mini',new Uint8Array([255,216,255,217]).buffer);
  assert.equal(payload.model,'gpt-4o-mini');
  assert.equal(payload.store,false);
  assert.equal('reasoning' in payload,false);
  assert.equal(payload.text.format.type,'json_schema');
  assert.equal(payload.text.format.strict,true);
  const prompt=payload.input[0].content[0].text;
  assert.match(prompt,/wide and black/);
  assert.match(prompt,/Mon-Sun list on the left/);
  assert.match(prompt,/timestamp watermark or phone overlay is not evidence/i);
  assert.match(prompt,/curved, diagonal, or uneven glare/i);
  assert.match(prompt,/5 versus 9/i);
  assert.match(prompt,/second time/i);
  assert.match(prompt,/Always return weekday=null/i);
  assert.match(prompt,/note to an empty string/i);
  assert.match(prompt,/Never classify a banking, Paotang, or G-Wallet payment receipt as ONLINE_ORDER/i);
  assert.match(prompt,/paidAmountBaht is the actual amount leaving the wallet or account/i);
  assert.match(prompt,/price 40, subsidy 24, paid 16/i);
  assert.match(payload.input[0].content[1].image_url,/^data:image\/jpeg;base64,/);
  assert.equal(payload.input[0].content[1].detail,'high');
});

test('OpenAI normalization preserves structured G-Wallet paid amount',()=>{
  const result=normalizeOpenAIVisionResult({
    kind:'ONLINE_ORDER',hour:null,minute:null,month:null,day:null,weekday:null,
    confidence:0.98,clockFullyVisible:null,needsNewPhoto:false,note:'',
    document:{
      documentType:'BANK_SLIP',channel:'G_WALLET',institution:'Paotang',transactionType:'WALLET_PAYMENT',transactionStatus:'SUCCESS',printedYear:'2569',
      paymentDate:'2026-07-11',paymentTime:'16:04',referenceId:'REF-TEST',sender:'Eak',senderAccountMasked:'0722',recipient:'',recipientAccountMasked:'',merchant:'PA Plastic',
      grossAmountBaht:40,discountAmountBaht:24,paidAmountBaht:16,currency:'THB',suggestedDescription:'PA Plastic supplies',suggestedCategory:'packaging',confidence:0.98,needsReview:false,note:''
    }
  },{});
  assert.equal(result.kind,'BANK_SLIP');
  assert.equal(result.document.channel,'G_WALLET');
  assert.equal(result.document.grossAmountBaht,40);
  assert.equal(result.document.discountAmountBaht,24);
  assert.equal(result.document.paidAmountBaht,16);
});

test('OpenAI normalization expands printed year 26 and normalizes Baht to THB',()=>{
  const result=normalizeOpenAIVisionResult({
    kind:'BANK_SLIP',hour:null,minute:null,month:null,day:null,weekday:null,confidence:0.99,clockFullyVisible:null,needsNewPhoto:false,note:'',
    document:{documentType:'BANK_SLIP',channel:'BANK',institution:'KBank',transactionType:'TRANSFER',transactionStatus:'SUCCESS',printedYear:'26',paymentDate:'2023-07-21',paymentTime:'16:49',referenceId:'REF',sender:'A',senderAccountMasked:'',recipient:'B',recipientAccountMasked:'',merchant:'',grossAmountBaht:200,discountAmountBaht:0,paidAmountBaht:200,currency:'Baht',suggestedDescription:'Transfer to B',suggestedCategory:'general',confidence:0.99,needsReview:false,note:''}
  },{});
  assert.equal(result.document.paymentDate,'2026-07-21');
  assert.equal(result.document.currency,'THB');
});

test('OpenAI normalization treats textual null weekday as missing',()=>{
  const result=normalizeOpenAIVisionResult({
    kind:'CLOCK',hour:8,minute:43,month:7,day:21,weekday:'null',
    confidence:0.95,clockFullyVisible:true,needsNewPhoto:false,note:'  '
  },{});
  assert.equal(result.weekday,null);
  assert.equal(result.note,'');
});
