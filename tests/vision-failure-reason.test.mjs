import test from 'node:test';
import assert from 'node:assert/strict';
import {describeClockValidationFailure,describeVisionRejection} from '../dist/vision/failure-reason.js';

const base={kind:'UNKNOWN',hour:null,minute:null,month:null,day:null,weekday:null,confidence:0,clockFullyVisible:null,clockPresent:null,clockConfidence:0,overlayPresent:false,overlayTextWhite:false,photoDate:null,photoTime:null,latitude:null,longitude:null,locationText:'',overlayRawText:'',overlayConfidence:0,needsNewPhoto:true,note:'',provider:'openai',raw:null};

test('budget guard says the photo is not at fault and tells staff to contact admin',()=>{
  const result=describeVisionRejection({...base,provider:'budget-guard'});
  assert.equal(result.code,'VISION_DAILY_LIMIT');
  assert.match(result.message,/รูปของคุณไม่ได้ผิด/);
  assert.match(result.message,/ผู้ดูแลร้าน/);
});

test('provider failure and unknown image have distinct safe explanations',()=>{
  const failure=describeVisionRejection({...base,provider:'openai-error',note:'OpenAI HTTP 401: secret'});
  const unknown=describeVisionRejection(base);
  assert.equal(failure.code,'VISION_SERVICE_ERROR');
  assert.equal(unknown.code,'IMAGE_KIND_UNKNOWN');
  assert.doesNotMatch(failure.message,/401|secret|OpenAI HTTP/);
  assert.match(failure.message,/Reason:/);
  assert.match(failure.message,/[က-႟]/);
});

test('attendance failures explain timestamp, GPS, radius, and clock evidence in three languages',()=>{
  for(const [code,pattern] of [['TIMESTAMP_MISSING',/ตัวหนังสือสีขาว/],['GPS_MISSING',/Latitude\/Longitude/],['OUTSIDE_STORE_RADIUS',/นอกรัศมีร้าน/],['CLOCK_NOT_CONFIRMED',/นาฬิกาประจำร้าน/],['PHOTO_TIME_TOO_OLD',/เวลาที่ส่ง LINE/]]){
    const failure=describeClockValidationFailure(code);assert.match(failure.message,pattern);assert.match(failure.message,new RegExp(code));assert.match(failure.message,/Reason:/);assert.match(failure.message,/[က-႟]/);
  }
});
