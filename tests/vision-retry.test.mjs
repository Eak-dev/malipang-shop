import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseBetterAttendanceReading,shouldRetryOpenAIAttendance} from '../dist/vision/service.js';

const reading=(overrides={})=>({
  kind:'CLOCK',hour:null,minute:null,month:null,day:null,weekday:null,confidence:0.99,
  clockFullyVisible:true,clockPresent:true,clockConfidence:0.9,
  overlayPresent:true,overlayTextWhite:true,photoDate:'2026-07-20',photoTime:'17:33:23',
  latitude:13.8968095,longitude:100.6083093,locationText:'Bang Khen Bangkok',
  overlayRawText:'Jul 20, 2026 5:33:23 PM',overlayConfidence:0.95,
  needsNewPhoto:false,note:'',provider:'openai',raw:null,document:null,...overrides
});

test('retries only a complete attendance extraction with borderline confidence',()=>{
  assert.equal(shouldRetryOpenAIAttendance(reading({overlayConfidence:0.89}),0.9,0.7),true);
  assert.equal(shouldRetryOpenAIAttendance(reading({clockConfidence:0.69}),0.9,0.7),true);
  assert.equal(shouldRetryOpenAIAttendance(reading(),0.9,0.7),false);
});

test('does not retry a genuinely incomplete attendance photo',()=>{
  assert.equal(shouldRetryOpenAIAttendance(reading({latitude:null,longitude:null,overlayConfidence:0.5}),0.9,0.7),false);
  assert.equal(shouldRetryOpenAIAttendance(reading({locationText:'',overlayConfidence:0.5}),0.9,0.7),false);
  assert.equal(shouldRetryOpenAIAttendance(reading({clockPresent:false,overlayConfidence:0.5}),0.9,0.7),false);
});

test('keeps the more reliable complete extraction after retry',()=>{
  const first=reading({overlayConfidence:0.88,clockConfidence:0.9});
  const retry=reading({overlayConfidence:0.96,clockConfidence:0.92});
  assert.equal(chooseBetterAttendanceReading(first,retry),retry);
  assert.equal(chooseBetterAttendanceReading(retry,first),retry);
  assert.equal(chooseBetterAttendanceReading(first,reading({latitude:null})),first);
});

test('prefers the retry that passes both thresholds over a higher combined failing score',()=>{
  const first=reading({overlayConfidence:0.89,clockConfidence:0.99});
  const retry=reading({overlayConfidence:0.91,clockConfidence:0.70});
  assert.equal(chooseBetterAttendanceReading(first,retry,0.9,0.7),retry);
});
