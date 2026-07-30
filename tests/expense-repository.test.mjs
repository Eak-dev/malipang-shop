import test from 'node:test';
import assert from 'node:assert/strict';
import {getExpenseCase} from '../dist/expense/repository.js';

const row={expense_id:'exp_1',branch_id:'B001',submitted_by_employee_id:'EMP001',status:'WAITING_CONFIRM',transaction_date:'2026-07-30',amount_satang:13200,description:'supplier',document_id:'doc_1',document_type:'RECEIPT'};
const env={DB:{prepare(){return{bind(){return this;},async first(){return row;}};}}};
const actor=(employeeId,role,scope='BRANCH',branchId='B001')=>({employeeId,role,scope,branchId,employeeStatus:'ACTIVE',roleStatus:'ACTIVE',employee:{}});

test('V2 expense query keeps employee records private and permits branch/organization scope',async()=>{
  await assert.doesNotReject(getExpenseCase(env,actor('EMP001','EMPLOYEE'),'exp_1'));
  await assert.rejects(getExpenseCase(env,actor('EMP002','EMPLOYEE'),'exp_1'),/FORBIDDEN/);
  await assert.doesNotReject(getExpenseCase(env,actor('MGR001','BRANCH_MANAGER'),'exp_1'));
  await assert.rejects(getExpenseCase(env,actor('MGR002','BRANCH_MANAGER','BRANCH','B002'),'exp_1'),/FORBIDDEN/);
  await assert.doesNotReject(getExpenseCase(env,actor('OWN001','OWNER','ORGANIZATION',null),'exp_1'));
});
