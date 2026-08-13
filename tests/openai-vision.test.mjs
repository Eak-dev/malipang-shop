import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOpenAIVisionPayload,normalizeOpenAIVisionResult,normalizePurchaseDate} from '../dist/vision/openai.js';

test('OpenAI fallback uses photo timestamp and GPS as the attendance source',()=>{
  const payload=buildOpenAIVisionPayload('gpt-4o-mini',new Uint8Array([255,216,255,217]).buffer);
  assert.equal(payload.model,'gpt-4o-mini');
  assert.equal(payload.store,false);
  assert.equal('reasoning' in payload,false);
  assert.equal(payload.text.format.type,'json_schema');
  assert.equal(payload.text.format.strict,true);
  const prompt=payload.input[0].content[0].text;
  assert.match(prompt,/wide and black/);
  assert.match(prompt,/Mon-Sun list on the left/);
  assert.match(prompt,/timestamp watermark or phone overlay is not by itself evidence/i);
  assert.match(prompt,/entire image including every corner/i);
  assert.match(prompt,/authoritative attendance data is the white overlay/i);
  assert.match(prompt,/physical clock digits are never the attendance time/i);
  assert.match(prompt,/Do not geocode an address/i);
  assert.match(prompt,/note to an empty string/i);
  assert.match(prompt,/Never classify a banking, Paotang, or G-Wallet payment receipt as ONLINE_ORDER/i);
  assert.match(prompt,/paidAmountBaht is the actual amount leaving the wallet or account/i);
  assert.match(prompt,/Buyer, customer, bill-to, ship-to, receiver, delivery address, product brand and manufacturer are never sellers/i);
  assert.match(prompt,/Only for ONLINE_ORDER, sellerKey may identify each marketplace seller or store/i);
  assert.match(prompt,/ยอดรวมคำสั่งซื้อ/);
  assert.match(prompt,/Order total/);
  assert.match(prompt,/paymentStatus=PAID only when the screen visibly proves payment/i);
  assert.match(prompt,/generic credit\/debit-card label/i);
  assert.match(prompt,/price 40, subsidy 24, paid 16/i);
  const purchaseSchema=payload.text.format.schema.properties.document.anyOf[1];
  for(const field of ['paymentDateFormat','paymentDatePurpose','orderTotalBaht','orderTotalLabel','paymentStatus'])assert.ok(purchaseSchema.required.includes(field));
  assert.match(payload.input[0].content[1].image_url,/^data:image\/jpeg;base64,/);
  assert.equal(payload.input[0].content[1].detail,'high');
});

function onlineOrder(overrides={}){
  return{documentType:'ONLINE_ORDER',vendor:'Marketplace',legalVendorName:'',documentNumber:'',orderId:'MASKED',documentDate:'2026-08-12',paymentDate:'12-08-2026',paymentDateFormat:'DMY',paymentDatePurpose:'PAYMENT',paymentTime:'10:08',currency:'THB',subtotalBaht:54,shippingBaht:0,discountBaht:0,subsidyBaht:0,vatBaht:0,grossAmountBaht:54,finalPaidAmountBaht:null,orderTotalBaht:54,orderTotalLabel:'ยอดรวมคำสั่งซื้อ',paymentStatus:'PAID',paymentMethod:'บัตรเครดิต/บัตรเดบิต',sourceWalletCandidate:'CARD_KBANK',suggestedDescription:'Online order',suggestedCategory:'general',confidence:.98,needsReview:false,reviewReasons:[],items:[{sellerKey:'Store',productCode:'',description:'Item',quantity:1,unit:'item',unitPriceBaht:54,discountBaht:0,lineTotalBaht:54,vatBaht:0,confidence:.98,needsReview:false}],...overrides};
}
function normalizedOnline(overrides={}){
  return normalizeOpenAIVisionResult({kind:'ONLINE_ORDER',confidence:.98,document:onlineOrder(overrides)},{}).document;
}

test('purchase-date normalization supports proven formats and calendar-safe year policies',()=>{
  assert.equal(normalizePurchaseDate('2026-08-12'),'2026-08-12');
  assert.equal(normalizePurchaseDate('12-08-2026','DMY'),'2026-08-12');
  assert.equal(normalizePurchaseDate('12/08/2026','DMY'),'2026-08-12');
  assert.equal(normalizePurchaseDate('12-08-26','DMY'),'2026-08-12');
  assert.equal(normalizePurchaseDate('12-08-2569','DMY'),'2026-08-12');
  assert.equal(normalizePurchaseDate('31-02-2026','DMY'),'');
  assert.equal(normalizePurchaseDate('08/09/2026','UNKNOWN'),'');
  assert.equal(normalizePurchaseDate('09/08/2026','UNKNOWN'),'');
});

test('paid Online Order maps accepted Thai and English final-total labels deterministically',()=>{
  for(const label of ['รวมคำสั่งซื้อ','ยอดรวมคำสั่งซื้อ','ยอดชำระ','Total order','Order total','Paid total']){
    const document=normalizedOnline({orderTotalLabel:label});
    assert.equal(document.paymentDate,'2026-08-12',label);
    assert.equal(document.paymentTime,'10:08',label);
    assert.equal(document.finalPaidAmountBaht,54,label);
  }
  assert.equal(normalizedOnline({finalPaidAmountBaht:54}).finalPaidAmountBaht,54);
});

test('Online Order payment evidence and source selection fail closed',()=>{
  for(const paymentStatus of ['PENDING','UNPAID','UNKNOWN'])assert.equal(normalizedOnline({paymentStatus,finalPaidAmountBaht:54}).finalPaidAmountBaht,null);
  assert.equal(normalizedOnline({orderTotalLabel:'Expected delivery total',finalPaidAmountBaht:54}).finalPaidAmountBaht,null);
  assert.equal(normalizedOnline({orderTotalLabel:'',finalPaidAmountBaht:54}).finalPaidAmountBaht,null);
  assert.equal(normalizedOnline({orderTotalBaht:null,finalPaidAmountBaht:54}).finalPaidAmountBaht,null);
  assert.equal(normalizedOnline({orderTotalBaht:0,finalPaidAmountBaht:54}).finalPaidAmountBaht,null);
  assert.equal(normalizedOnline({paymentDate:'08/09/2026',paymentDateFormat:'UNKNOWN'}).paymentDate,'');
  assert.equal(normalizedOnline({paymentDatePurpose:'EXPECTED_DELIVERY'}).paymentDate,'');
  const conflict=normalizedOnline({finalPaidAmountBaht:59});
  assert.equal(conflict.finalPaidAmountBaht,null);
  assert.match(conflict.reviewReasons.join('; '),/amount evidence conflicts/i);
  for(const paymentMethod of ['credit card','debit card','credit/debit card','บัตรเครดิต','บัตรเดบิต','บัตรเครดิต/บัตรเดบิต'])assert.equal(normalizedOnline({paymentMethod,sourceWalletCandidate:'CARD_KBANK'}).sourceWalletCandidate,'',paymentMethod);
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

test('OpenAI normalization gives a stable G-Wallet institution label',()=>{
  const result=normalizeOpenAIVisionResult({
    kind:'BANK_SLIP',hour:null,minute:null,month:null,day:null,weekday:null,confidence:0.98,clockFullyVisible:null,needsNewPhoto:false,note:'',
    document:{
      documentType:'BANK_SLIP',channel:'G_WALLET',institution:'ไทยช่วยไทย พลัส 60/40',transactionType:'WALLET_PAYMENT',transactionStatus:'SUCCESS',printedYear:'2569',
      paymentDate:'2026-07-11',paymentTime:'16:04',referenceId:'REF-WALLET',sender:'Eak',senderAccountMasked:'0722',recipient:'',recipientAccountMasked:'',merchant:'PA Plastic',
      grossAmountBaht:40,discountAmountBaht:24,paidAmountBaht:16,currency:'THB',suggestedDescription:'PA Plastic supplies',suggestedCategory:'packaging',confidence:0.98,needsReview:false,note:''
    }
  },{});
  assert.match(result.document.institution,/^G-Wallet/);
  assert.match(result.document.institution,/ไทยช่วยไทย/);
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

test('OpenAI normalization preserves authoritative overlay fields',()=>{
  const result=normalizeOpenAIVisionResult({kind:'CLOCK',hour:null,minute:null,month:null,day:null,weekday:null,confidence:.99,clockFullyVisible:true,clockPresent:true,clockConfidence:.98,overlayPresent:true,overlayTextWhite:true,photoDate:'2026-07-21',photoTime:'17:15:56',latitude:13.896844,longitude:100.608314,locationText:'Yingcharoen Market',overlayRawText:'21 Jul BE 2569 at 17:15:56',overlayConfidence:.99,needsNewPhoto:false,note:'',document:null},{});
  assert.equal(result.clockPresent,true);assert.equal(result.photoDate,'2026-07-21');assert.equal(result.photoTime,'17:15:56');assert.equal(result.latitude,13.896844);assert.equal(result.overlayTextWhite,true);
});

test('OpenAI normalization derives date and time only from extracted white overlay text',()=>{
  const result=normalizeOpenAIVisionResult({kind:'CLOCK',hour:null,minute:null,month:null,day:null,weekday:null,confidence:.95,clockFullyVisible:true,clockPresent:true,clockConfidence:.9,overlayPresent:true,overlayTextWhite:true,photoDate:null,photoTime:null,latitude:13.896795,longitude:100.608147,locationText:'Yingcharoen Market',overlayRawText:'23 Jul BE 2569 at 04:41:46\n+13.896795,+100.608147',overlayConfidence:.95,needsNewPhoto:false,note:'',document:null},{});
  assert.equal(result.photoDate,'2026-07-23');assert.equal(result.photoTime,'04:41:46');assert.equal(result.hour,null);assert.equal(result.minute,null);
});
