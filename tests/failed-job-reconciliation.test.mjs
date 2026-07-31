import test from "node:test";
import assert from "node:assert/strict";
import {classifyHistoricalFailedJob} from "../dist/admin/failed-job-reconciliation.js";

const base={kind:"LINE_EVENT",messageType:"image",purpose:"",hasAttendance:false,hasExpense:false,hasDocument:false};

test("historical failed job reconciliation never replays an already committed attendance",()=>{
  const decision=classifyHistoricalFailedJob({...base,hasAttendance:true});
  assert.equal(decision.outcome,"ATTENDANCE_COMMITTED");
  assert.equal(decision.resolved,true);
});

test("historical failed job reconciliation never creates a duplicate Expense",()=>{
  const decision=classifyHistoricalFailedJob({...base,messageType:"text",hasExpense:true});
  assert.equal(decision.outcome,"EXPENSE_COMMITTED");
  assert.equal(decision.resolved,true);
});

test("existing review document is accounted without finalizing another Expense",()=>{
  const decision=classifyHistoricalFailedJob({...base,hasDocument:true});
  assert.equal(decision.outcome,"EXPENSE_DOCUMENT_COMMITTED");
  assert.equal(decision.resolved,true);
});

test("unrecoverable historical image requires resubmission instead of fabricated accounting",()=>{
  const decision=classifyHistoricalFailedJob(base);
  assert.equal(decision.outcome,"IMAGE_RESUBMISSION_REQUIRED");
  assert.equal(decision.resolved,true);
});

test("ordinary notification failures remain open for manual review",()=>{
  const decision=classifyHistoricalFailedJob({...base,kind:"LINE_NOTIFICATION",purpose:"EXPENSE_RESPONSE"});
  assert.equal(decision.outcome,"NOTIFICATION_REVIEW_REQUIRED");
  assert.equal(decision.resolved,false);
});

test("attendance smoke notification is delivery-only and safely reconciled",()=>{
  const decision=classifyHistoricalFailedJob({...base,kind:"LINE_NOTIFICATION",purpose:"ATTENDANCE_SMOKE"});
  assert.equal(decision.outcome,"SMOKE_NOTIFICATION_EXHAUSTED");
  assert.equal(decision.resolved,true);
});
