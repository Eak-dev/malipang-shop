import test from 'node:test';
import assert from 'node:assert/strict';
import {queueRetryDelaySeconds} from '../dist/shared/retry.js';
import {parseRetryAfterSeconds} from '../dist/sheets/client.js';

test('Google Sheets quota errors use exponential backoff with bounded jitter',()=>{
  const error=new Error('Sheets HTTP 429: RESOURCE_EXHAUSTED RATE_LIMIT_EXCEEDED');
  assert.equal(queueRetryDelaySeconds(error,1,()=>0),60);
  assert.equal(queueRetryDelaySeconds(error,2,()=>0.5),135);
  assert.equal(queueRetryDelaySeconds(error,3,()=>0),240);
});

test('Google Sheets retry honors Retry-After when it is longer than exponential delay',()=>{
  const error=Object.assign(new Error('Sheets HTTP 429: RESOURCE_EXHAUSTED'),{retryAfterSeconds:180});
  assert.equal(queueRetryDelaySeconds(error,1,()=>0),180);
  assert.equal(parseRetryAfterSeconds('120',0),120);
  assert.equal(parseRetryAfterSeconds('Thu, 01 Jan 1970 00:02:00 GMT',0),120);
});

test('persisted sync attempt drives exponential delay when queue metadata is unavailable',()=>{
  const error=Object.assign(new Error('Sheets HTTP 429: RESOURCE_EXHAUSTED'),{retryAttempt:4});
  assert.equal(queueRetryDelaySeconds(error,1,()=>0),480);
});

test('transient server and timeout errors use a shorter retry delay',()=>{
  assert.equal(queueRetryDelaySeconds(new Error('Sheets HTTP 503'),1,()=>0),30);
  assert.equal(queueRetryDelaySeconds(new Error('Google Sheets timed out'),2,()=>0),60);
  assert.equal(queueRetryDelaySeconds(new Error('invalid request')),undefined);
});
