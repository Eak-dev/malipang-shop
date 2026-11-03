import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationTimeoutError,withTimeout,readBoundedJson} from '../dist/shared/async.js';

test('withTimeout returns a completed operation',async()=>{assert.equal(await withTimeout(Promise.resolve('ok'),50,'fast'),'ok');});
test('withTimeout rejects a stalled operation',async()=>{await assert.rejects(withTimeout(new Promise(()=>{}),5,'slow'),OperationTimeoutError);});
test('bounded JSON reads valid data and rejects oversized responses',async()=>{
 assert.deepEqual(await readBoundedJson(new Response('{"ok":true}'),100,100,'body'),{ok:true});
 await assert.rejects(readBoundedJson(new Response('x'.repeat(101)),100,100,'body'),/too large/);
});
test('bounded JSON times out even if stream read and cancel both stall',async()=>{
 let cancelled=0;const stream=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled++;return new Promise(()=>{});}});
 const start=Date.now();await assert.rejects(readBoundedJson(new Response(stream),100,20,'body'),OperationTimeoutError);
 assert.ok(Date.now()-start<1000);assert.equal(cancelled,1);
});
test('oversize stream is cancelled before the reader lock is released',async()=>{
 let cancelled=0;const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(9));},pull(){return new Promise(()=>{});},cancel(){cancelled++;return new Promise(()=>{});}});
 await assert.rejects(readBoundedJson(new Response(stream),8,100,'body'),/too large/);assert.equal(cancelled,1);
});
