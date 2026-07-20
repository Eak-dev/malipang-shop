import test from 'node:test';
import assert from 'node:assert/strict';
import {validateCorrection} from '../dist/admin/correction-validation.js';

const valid={employeeId:'EMP001',workDate:'2020-07-20',timeIn:'04:05',timeOut:'16:00',reason:'ตรวจจากรูป'};
test('admin correction accepts a real date and time range',()=>{assert.deepEqual(validateCorrection(valid),valid);});
test('admin correction rejects impossible date',()=>{assert.throws(()=>validateCorrection({...valid,workDate:'2020-02-31'}));});
test('admin correction rejects invalid HH:mm',()=>{assert.throws(()=>validateCorrection({...valid,timeIn:'25:99'}));});
test('admin correction rejects reversed times',()=>{assert.throws(()=>validateCorrection({...valid,timeIn:'18:00',timeOut:'16:00'}));});
