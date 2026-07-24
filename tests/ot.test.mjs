import test from 'node:test';
import assert from 'node:assert/strict';
import {actualOtMinutes,fixedOtSatang} from '../dist/domain/ot.js';
test('fixed OT converts baht to satang',()=>{assert.equal(fixedOtSatang(100),10000);assert.equal(fixedOtSatang(200),20000);});
test('fixed OT rejects invalid amounts',()=>{assert.throws(()=>fixedOtSatang(0));assert.throws(()=>fixedOtSatang(Number.NaN));});
test('actual OT uses planned start when provided',()=>{assert.equal(actualOtMinutes('18:15','16:00','16:30'),105);});
test('actual OT falls back to scheduled out',()=>{assert.equal(actualOtMinutes('17:30','16:00'),90);assert.equal(actualOtMinutes(null,'16:00'),0);});
