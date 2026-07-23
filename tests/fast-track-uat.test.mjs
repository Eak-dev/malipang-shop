import test from 'node:test';
import assert from 'node:assert/strict';
import {assertFastTrackUat} from '../dist/admin/fast-track-uat.js';

test('Fast-track UAT admin functions require the UAT app marker and Shadow Mode',()=>{
  assert.doesNotThrow(()=>assertFastTrackUat({APP_ENV:'uat',RUNTIME_MODE:'shadow'}));
  assert.throws(()=>assertFastTrackUat({APP_ENV:'production',RUNTIME_MODE:'shadow'}),/APP_ENV=uat/);
  assert.throws(()=>assertFastTrackUat({APP_ENV:'uat',RUNTIME_MODE:'production'}),/RUNTIME_MODE=shadow/);
});
