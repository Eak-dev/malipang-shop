import test from 'node:test';
import assert from 'node:assert/strict';
import {describeClockValidationFailure,describeVisionRejection} from '../dist/vision/failure-reason.js';

const base={kind:'UNKNOWN',hour:null,minute:null,month:null,day:null,weekday:null,confidence:0,clockFullyVisible:null,needsNewPhoto:true,note:'',provider:'openai',raw:null};

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
});

test('clock failures explain the exact validation condition in Thai',()=>{
  const missing=describeClockValidationFailure('CLOCK_FIELDS_MISSING');
  const date=describeClockValidationFailure('CLOCK_DATE_MISMATCH');
  assert.match(missing.message,/เวลา เดือน หรือวันที่/);
  assert.match(date.message,/วันที่บนหน้าปัดต่างจากวันที่ส่งรูป/);
  assert.match(date.message,/CLOCK_DATE_MISMATCH/);
});
