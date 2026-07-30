import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {approveIdentityLinkRequest,assignStaffRole,getStaffActorByLineId} from '../dist/access/repository.js';

const owner={employeeId:'OWN001',role:'OWNER',scope:'ORGANIZATION',branchId:null,branchName:null,employeeStatus:'ACTIVE',roleStatus:'ACTIVE',employee:{employeeId:'OWN001',staffName:'Eak',lineUserId:'U-owner',scheduledIn:'04:00',scheduledOut:'16:00',dailyWageSatang:0,graceMin:0,lateDeductionSatang:0,earlyDeductionSatang:0,canSubmitExpense:true,status:'ACTIVE'}};
function db(state){return {prepare(sql){return {sql,values:[],bind(...values){this.values=values;return this;},async first(){
  if(sql.includes('FROM line_identity_bindings i JOIN employees'))return state.actorRow||null;
  if(sql.startsWith('SELECT request_id,external_user_id'))return state.request;
  if(sql.startsWith('SELECT employee_id,staff_name,status'))return state.staff;
  return null;
},async run(){state.sql.push({sql,values:this.values});return{meta:{changes:1}};}};},async batch(statements){for(const statement of statements)state.sql.push({sql:statement.sql||'BATCH',values:statement.values||[]});return[];}};}

test('Owner approval creates one verified binding and audit record',async()=>{
  const state={sql:[],request:{request_id:'req_1',external_user_id:'U-new',requested_staff_id:'EMP004',status:'PENDING_OWNER_APPROVAL'},staff:{employee_id:'EMP004',staff_name:'New staff',status:'ACTIVE',line_user_id:'PENDING_EMP004'}};
  const result=await approveIdentityLinkRequest({DB:db(state)},'req_1',owner);
  assert.deepEqual(result,{requestId:'req_1',employeeId:'EMP004',idempotent:false});
  assert.ok(state.sql.some(entry=>String(entry.sql).includes('INSERT INTO line_identity_bindings')));
  assert.ok(state.sql.some(entry=>entry.values.includes('IDENTITY_LINK_APPROVED')));
});

test('OWN002 is bound only after a verified Owner approves its request',async()=>{
  const state={sql:[],request:{request_id:'req_nea',external_user_id:'U-nea',requested_staff_id:'OWN002',status:'PENDING_OWNER_APPROVAL'},staff:{employee_id:'OWN002',staff_name:'Nea',status:'ACTIVE',line_user_id:'PENDING_OWN002'}};
  const result=await approveIdentityLinkRequest({DB:db(state)},'req_nea',owner);
  assert.deepEqual(result,{requestId:'req_nea',employeeId:'OWN002',idempotent:false});
  assert.ok(state.sql.some(entry=>String(entry.sql).includes('INSERT INTO line_identity_bindings')&&entry.values.includes('OWN002')));
});

test('duplicate owner approval is idempotent and does not make a second binding',async()=>{
  const state={sql:[],request:{request_id:'req_1',external_user_id:'U-new',requested_staff_id:'EMP004',status:'APPROVED'},staff:null};
  assert.deepEqual(await approveIdentityLinkRequest({DB:db(state)},'req_1',owner),{requestId:'req_1',employeeId:'EMP004',idempotent:true});
  assert.equal(state.sql.length,0);
});

test('an Owner cannot silently remove or downgrade their own Owner role',async()=>{
  await assert.rejects(()=>assignStaffRole({DB:db({sql:[]})},owner,{employeeId:'OWN001',role:'BRANCH_MANAGER',branchId:'B001',reason:'test'}),/OWNER_CANNOT_CHANGE_OWN_ROLE/);
});

test('verified active binding retains ACTIVE status for both actor and employee image gates',async()=>{
  const actorRow={employee_id:'EMP001',staff_name:'Win',line_user_id:'U-existing',scheduled_in:'04:00',scheduled_out:'16:00',daily_wage_satang:50000,grace_min:10,late_deduction_satang:0,early_deduction_satang:0,can_submit_expense:1,status:'ACTIVE',employee_status:'ACTIVE',role:'EMPLOYEE',scope:'BRANCH',branch_id:'B001',role_status:'ACTIVE',branch_name:'Yingcharoen'};
  const actor=await getStaffActorByLineId({DB:db({sql:[],actorRow})},'U-existing');
  assert.equal(actor.employee.status,'ACTIVE');
  assert.equal(actor.employeeStatus,'ACTIVE');
});

test('schema enforces one active LINE identity per staff and per external user, manager cardinality, and append-only audit',()=>{
  const sql=readFileSync(new URL('../migrations/0011_identity_access_foundation.sql',import.meta.url),'utf8');
  assert.match(sql,/idx_line_identity_one_active_external/);
  assert.match(sql,/idx_line_identity_one_active_staff/);
  assert.match(sql,/idx_staff_roles_one_active_manager/);
  assert.match(sql,/idx_staff_roles_one_active_assistant_manager/);
  assert.match(sql,/access_audit_log_no_update/);
  assert.match(sql,/access_audit_log_no_delete/);
  assert.doesNotMatch(sql,/\bDROP\s+(TABLE|COLUMN)\b/i);
});
