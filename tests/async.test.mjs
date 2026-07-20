import test from 'node:test';
import assert from 'node:assert/strict';
import {OperationTimeoutError,withTimeout} from '../dist/shared/async.js';

test('withTimeout returns a completed operation',async()=>{assert.equal(await withTimeout(Promise.resolve('ok'),50,'fast'),'ok');});
test('withTimeout rejects a stalled operation',async()=>{await assert.rejects(withTimeout(new Promise(()=>{}),5,'slow'),OperationTimeoutError);});
