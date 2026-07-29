import test from 'node:test';
import assert from 'node:assert/strict';
import {authorize,assertAuthorized} from '../dist/access/authorization.js';

const actor=(role,branchId='B001',overrides={})=>({employeeId:'EMP001',role,scope:role==='OWNER'?'ORGANIZATION':'BRANCH',branchId:role==='OWNER'?null:branchId,employeeStatus:'ACTIVE',roleStatus:'ACTIVE',...overrides});

test('OWNER has organization scope for current and future branches',()=>{
  const owner=actor('OWNER');
  assert.equal(authorize(owner,'staff.branch.read',{branchId:'B001'}),true);
  assert.equal(authorize(owner,'staff.branch.read',{branchId:'B999'}),true);
  assert.equal(authorize(owner,'payroll.apply',{branchId:'B999'}),true);
});

test('BRANCH_MANAGER is confined to its branch and cannot escalate',()=>{
  const manager=actor('BRANCH_MANAGER');
  assert.equal(authorize(manager,'attendance.branch.read',{branchId:'B001'}),true);
  assert.equal(authorize(manager,'attendance.branch.read',{branchId:'B002'}),false);
  assert.equal(authorize(manager,'wage.write',{branchId:'B001'}),false);
  assert.equal(authorize(manager,'payroll.apply',{branchId:'B001'}),false);
  assert.equal(authorize(manager,'staff.owner.assign',{branchId:'B001'}),false);
});

test('ASSISTANT_MANAGER has operational reads only',()=>{
  const assistant=actor('ASSISTANT_MANAGER');
  assert.equal(authorize(assistant,'attendance.branch.read',{branchId:'B001'}),true);
  assert.equal(authorize(assistant,'expense.branch.read',{branchId:'B001'}),true);
  assert.equal(authorize(assistant,'wage.write',{branchId:'B001'}),false);
  assert.equal(authorize(assistant,'payroll.apply',{branchId:'B001'}),false);
  assert.equal(authorize(assistant,'staff.role.assign',{branchId:'B001'}),false);
});

test('EMPLOYEE can operate only on self records',()=>{
  const employee=actor('EMPLOYEE');
  assert.equal(authorize(employee,'attendance.self.write',{employeeId:'EMP001'}),true);
  assert.equal(authorize(employee,'attendance.self.read',{employeeId:'EMP001'}),true);
  assert.equal(authorize(employee,'attendance.self.read',{employeeId:'EMP002'}),false);
  assert.equal(authorize(employee,'payroll.self.read',{employeeId:'EMP001'}),true);
  assert.equal(authorize(employee,'payroll.self.read',{employeeId:'EMP002'}),false);
  assert.equal(authorize(employee,'attendance.branch.correct',{branchId:'B001'}),false);
  assert.equal(authorize(employee,'staff.self.low_risk_update',{employeeId:'EMP001'}),true);
});

test('inactive or missing staff is denied before capability evaluation',()=>{
  assert.equal(authorize(null,'attendance.self.write',{employeeId:'EMP001'}),false);
  assert.equal(authorize(actor('EMPLOYEE','B001',{employeeStatus:'INACTIVE'}),'attendance.self.write',{employeeId:'EMP001'}),false);
  assert.equal(authorize(actor('EMPLOYEE','B001',{roleStatus:'INACTIVE'}),'attendance.self.write',{employeeId:'EMP001'}),false);
  assert.throws(()=>assertAuthorized(actor('EMPLOYEE'),'payroll.apply',{branchId:'B001'}),/FORBIDDEN/);
});
