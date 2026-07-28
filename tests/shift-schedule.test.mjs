import test from "node:test";
import assert from "node:assert/strict";
import {generateDefaultSchedule,insertMissingScheduleRows,overrideShiftSchedule,parseShiftStatus} from "../dist/admin/shift-schedule.js";
import {shiftStatusCreatesMissingPunch} from "../dist/payroll/finalize.js";

function employee(employeeId,status="ACTIVE"){
  return{employee_id:employeeId,staff_name:employeeId,line_user_id:`U${"a".repeat(31)}${employeeId.slice(-1)}`,scheduled_in:"04:00",scheduled_out:"16:00",daily_wage_satang:50000,grace_min:5,late_deduction_satang:0,early_deduction_satang:0,can_submit_expense:1,status};
}
function makeEnv({inactive=[]}={}){
  const employeeIds=["EMP001","EMP002","EMP003","EMP004","UATAND"];
  const state={
    employees:new Map(employeeIds.map(id=>[id,employee(id,inactive.includes(id)?"INACTIVE":"ACTIVE")])),
    wages:new Map(employeeIds.map(id=>[id,[{employee_id:id,wage_id:`wage_${id}`,daily_wage_satang:50000,effective_from:"2026-07-30",effective_to:null}]])),
    shifts:new Map(),
    audits:[],
    queued:[],
    queuedMessages:[]
  };
  const statement=(sql)=>({sql,args:[],bind(...args){this.args=args;return this;},async all(){
    if(sql.includes("FROM employees WHERE employee_id IN"))return{results:this.args.map(id=>state.employees.get(String(id))).filter(Boolean),meta:{}};
    if(sql.includes("FROM employee_wage_history")){const ids=this.args.slice(0,-2).map(String);return{results:ids.flatMap(id=>state.wages.get(id)||[]),meta:{}};}
    return{results:[],meta:{}};
  },async first(){
    if(sql.includes("FROM employee_shift_days WHERE employee_id=? AND work_date=?"))return state.shifts.get(`${this.args[0]}|${this.args[1]}`)||null;
    return null;
  },async run(){return{meta:{changes:1}};}});
  const db={
    prepare(sql){return statement(sql);},
    async batch(statements){
      return statements.map(item=>{
        const{sql,args}=item;
        if(sql.startsWith("INSERT OR IGNORE INTO employee_shift_days")){
          const[employeeId,workDate,scheduledIn,scheduledOut,wageSatang,wageSourceId,status,note,createdAt,updatedAt,createdActionId]=args,key=`${employeeId}|${workDate}`;
          if(state.shifts.has(key))return{meta:{changes:0}};
          state.shifts.set(key,{employee_id:employeeId,work_date:workDate,scheduled_in:scheduledIn,scheduled_out:scheduledOut,daily_wage_snapshot_satang:wageSatang,wage_source_id:wageSourceId,status,note,version:1,created_at:createdAt,updated_at:updatedAt,created_action_id:createdActionId});
          return{meta:{changes:1}};
        }
        if(sql.includes("INSERT INTO shift_schedule_audit")&&sql.includes("created_action_id=?")){
          const[auditId,changedBy,reason,action,createdAt,employeeId,workDate,operationId]=args,row=state.shifts.get(`${employeeId}|${workDate}`);
          if(!row||row.created_action_id!==operationId)return{meta:{changes:0}};
          state.audits.push({audit_id:auditId,employee_id:employeeId,work_date:workDate,previous_status:null,new_status:row.status,previous_scheduled_in:null,previous_scheduled_out:null,new_scheduled_in:row.scheduled_in,new_scheduled_out:row.scheduled_out,changed_by:changedBy,reason,action,created_at:createdAt});
          return{meta:{changes:1}};
        }
        if(sql.includes("INSERT INTO shift_schedule_audit")&&sql.includes("'OWNER_OVERRIDE'")){
          const[auditId,newStatus,changedBy,reason,createdAt,employeeId,workDate,version,previousStatus]=args,row=state.shifts.get(`${employeeId}|${workDate}`);
          if(!row||row.version!==version||row.status!==previousStatus)return{meta:{changes:0}};
          state.audits.push({audit_id:auditId,employee_id:employeeId,work_date:workDate,previous_status:row.status,new_status:newStatus,previous_scheduled_in:row.scheduled_in,previous_scheduled_out:row.scheduled_out,new_scheduled_in:row.scheduled_in,new_scheduled_out:row.scheduled_out,changed_by:changedBy,reason,action:"OWNER_OVERRIDE",created_at:createdAt});
          return{meta:{changes:1}};
        }
        if(sql.startsWith("UPDATE employee_shift_days SET status=")){
          const[newStatus,note,updatedAt,employeeId,workDate,version,previousStatus]=args,key=`${employeeId}|${workDate}`,row=state.shifts.get(key);
          if(!row||row.version!==version||row.status!==previousStatus)return{meta:{changes:0}};
          state.shifts.set(key,{...row,status:newStatus,note,updated_at:updatedAt,version:row.version+1});
          return{meta:{changes:1}};
        }
        if(sql.startsWith("INSERT INTO sync_jobs"))return{meta:{changes:1}};
        throw new Error(`Unhandled SQL in test: ${sql}`);
      });
    }
  };
  return{state,env:{DB:db,SHEETS_SYNC_ENABLED:"true",JOB_QUEUE:{async sendBatch(messages){state.queuedMessages.push(...messages);state.queued.push(...messages.map(message=>message.body));}}}};
}
const generateInput=(employeeIds=["EMP001"])=>({employeeIds,fromDate:"2026-07-30",toDate:"2026-07-30",scheduledIn:"04:00",scheduledOut:"16:00",changedBy:"OWNER",reason:"Initial default schedule"});

test("default generation inserts a missing EXPECTED row and rerun is insert-only",async()=>{
  const{env,state}=makeEnv(),first=await generateDefaultSchedule(env,generateInput()),key="EMP001|2026-07-30";
  assert.deepEqual(first,{inserted:1,existing:0,requested:1});
  assert.equal(state.shifts.get(key).status,"EXPECTED");
  assert.equal(state.audits.length,1);
  state.shifts.get(key).scheduled_in="05:00";
  const second=await generateDefaultSchedule(env,generateInput());
  assert.deepEqual(second,{inserted:0,existing:1,requested:1});
  assert.equal(state.shifts.get(key).scheduled_in,"05:00","rerun must not modify an existing time");
  assert.equal(state.audits.length,1,"rerun must not create a false change audit");
});

test("locked default range creates 620 EXPECTED rows with no gaps or duplicates",async()=>{
  const{env,state}=makeEnv(),result=await generateDefaultSchedule(env,{...generateInput(["EMP001","EMP002","EMP003","EMP004"]),toDate:"2026-12-31"});
  assert.deepEqual(result,{inserted:620,existing:0,requested:620});
  assert.equal(state.shifts.size,620);
  for(const employeeId of["EMP001","EMP002","EMP003","EMP004"]){
    const shifts=[...state.shifts.values()].filter(row=>row.employee_id===employeeId);
    assert.equal(shifts.length,155);
    assert.ok(shifts.every(row=>row.status==="EXPECTED"&&row.scheduled_in==="04:00"&&row.scheduled_out==="16:00"));
  }
  assert.equal(new Set([...state.shifts.keys()]).size,620);
  assert.equal(state.audits.length,620);
  assert.equal(state.queuedMessages[39].delaySeconds,undefined);
  assert.equal(state.queuedMessages[40].delaySeconds,60);
  assert.equal(state.queuedMessages[619].delaySeconds,900);
});

test("default generation never overwrites DAY_OFF or CANCELLED Owner overrides",async()=>{
  const{env,state}=makeEnv(),key="EMP001|2026-07-30";
  await generateDefaultSchedule(env,generateInput());
  await overrideShiftSchedule(env,{employeeId:"EMP001",workDate:"2026-07-30",newStatus:"DAY_OFF",changedBy:"OWNER",reason:"Approved day off"});
  assert.equal((await generateDefaultSchedule(env,generateInput())).existing,1);
  assert.equal(state.shifts.get(key).status,"DAY_OFF");
  await overrideShiftSchedule(env,{employeeId:"EMP001",workDate:"2026-07-30",newStatus:"CANCELLED",changedBy:"OWNER",reason:"Shift cancelled"});
  assert.equal((await generateDefaultSchedule(env,generateInput())).existing,1);
  assert.equal(state.shifts.get(key).status,"CANCELLED");
});

test("Owner override changes one employee/date and preserves append-only audit history",async()=>{
  const{env,state}=makeEnv();
  await generateDefaultSchedule(env,generateInput(["EMP001","EMP002"]));
  const result=await overrideShiftSchedule(env,{employeeId:"EMP001",workDate:"2026-07-30",newStatus:"DAY_OFF",changedBy:"OWNER_EAK",reason:"Approved leave"});
  assert.deepEqual(result,{employeeId:"EMP001",workDate:"2026-07-30",previousStatus:"EXPECTED",newStatus:"DAY_OFF",version:2});
  assert.equal(state.shifts.get("EMP001|2026-07-30").status,"DAY_OFF");
  assert.equal(state.shifts.get("EMP002|2026-07-30").status,"EXPECTED");
  await overrideShiftSchedule(env,{employeeId:"EMP001",workDate:"2026-07-30",newStatus:"CANCELLED",changedBy:"OWNER_EAK",reason:"Store closure"});
  const overrides=state.audits.filter(row=>row.action==="OWNER_OVERRIDE");
  assert.deepEqual(overrides.map(row=>[row.previous_status,row.new_status]),[["EXPECTED","DAY_OFF"],["DAY_OFF","CANCELLED"]]);
  assert.equal(overrides[0].changed_by,"OWNER_EAK");
  assert.equal(overrides[0].reason,"Approved leave");
  assert.equal(overrides[0].previous_scheduled_in,"04:00");
  assert.equal(overrides[0].new_scheduled_out,"16:00");
});

test("inactive employees are rejected by generation, import service, and override",async()=>{
  const{env}=makeEnv({inactive:["UATAND"]});
  await assert.rejects(()=>generateDefaultSchedule(env,generateInput(["UATAND"])),/not ACTIVE/);
  await assert.rejects(()=>insertMissingScheduleRows(env,[{employeeId:"UATAND",workDate:"2026-07-30",scheduledIn:"04:00",scheduledOut:"16:00",status:"EXPECTED"}],{changedBy:"ADMIN_SHEET_IMPORT",action:"SHEET_IMPORT",reason:"Initial import"}),/not ACTIVE/);
  const active=makeEnv();
  await generateDefaultSchedule(active.env,generateInput(["UATAND"]));
  active.state.employees.get("UATAND").status="INACTIVE";
  await assert.rejects(()=>overrideShiftSchedule(active.env,{employeeId:"UATAND",workDate:"2026-07-30",newStatus:"DAY_OFF",changedBy:"OWNER",reason:"Off"}),/not ACTIVE/);
});

test("strict status validation rejects blank and unknown values",()=>{
  assert.equal(parseShiftStatus("EXPECTED"),"EXPECTED");
  assert.equal(parseShiftStatus("DAY_OFF"),"DAY_OFF");
  assert.equal(parseShiftStatus("CANCELLED"),"CANCELLED");
  assert.throws(()=>parseShiftStatus(""),/Invalid shift status/);
  assert.throws(()=>parseShiftStatus("expect"),/Invalid shift status/);
});

test("only EXPECTED shifts participate in Missing Punch payroll",()=>{
  assert.equal(shiftStatusCreatesMissingPunch("EXPECTED"),true);
  assert.equal(shiftStatusCreatesMissingPunch("DAY_OFF"),false);
  assert.equal(shiftStatusCreatesMissingPunch("CANCELLED"),false);
});
