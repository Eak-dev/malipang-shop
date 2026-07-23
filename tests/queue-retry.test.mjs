import test from 'node:test';
import assert from 'node:assert/strict';
import {queueRetryDelaySeconds} from '../dist/shared/retry.js';

test('Google Sheets quota errors retry after one minute instead of exhausting DLQ immediately',()=>{
  assert.equal(queueRetryDelaySeconds(new Error('Sheets HTTP 429: RESOURCE_EXHAUSTED RATE_LIMIT_EXCEEDED')),60);
});

test('transient server and timeout errors use a shorter retry delay',()=>{
  assert.equal(queueRetryDelaySeconds(new Error('Sheets HTTP 503')),30);
  assert.equal(queueRetryDelaySeconds(new Error('Google Sheets timed out')),30);
  assert.equal(queueRetryDelaySeconds(new Error('invalid request')),undefined);
});
