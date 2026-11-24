import test from 'node:test';
import assert from 'node:assert/strict';
import {liveSelected,LIVE_SUITES} from './helpers/live-opt-in.mjs';

test('live suites run only when named, and "all" leaves out the deferred online-order images',()=>{
  for(const suite of LIVE_SUITES){
    assert.equal(liveSelected(suite,''),false,suite);
    assert.equal(liveSelected(suite,undefined),false,suite);
    assert.equal(liveSelected(suite,` ${suite} `),true,suite);
  }
  assert.equal(liveSelected('clock-photos','bank-slips,clock-photos'),true);
  assert.equal(liveSelected('expense-text','bank-slips,clock-photos'),false);
  for(const suite of ['clock-photos','bank-slips','expense-text'])assert.equal(liveSelected(suite,'all'),true,suite);
  assert.equal(liveSelected('online-order-images','all'),false);
  assert.equal(liveSelected('online-order-images','all,online-order-images'),true);
});

test('a mistyped live suite fails instead of silently selecting nothing',()=>{
  assert.throws(()=>liveSelected('clock-photos','clock-photo'),/unknown suite: clock-photo/);
  assert.throws(()=>liveSelected('clock','all'),/unknown live suite/);
});
