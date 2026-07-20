import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileSheets} from '../dist/admin/reconcile-sheets.js';

test('reconcile recreates all report job types from D1',async()=>{
  const sent=[];
  const db={
    prepare(sql){return{bind(){return this;},async all(){if(sql.includes('attendance_events'))return{results:[{entity_key:'att_1',version:1}],meta:{}};if(sql.includes('attendance_daily'))return{results:[{entity_key:'EMP001|2026-07-20',version:2}],meta:{}};if(sql.includes('payroll_weekly'))return{results:[{entity_key:'EMP001|2026-07-20',version:2}],meta:{}};if(sql.includes('expense_events'))return{results:[{entity_key:'exp_1',version:1}],meta:{}};return{results:[],meta:{}};}};},
    async batch(statements){return statements.map(()=>({meta:{changes:1}}));}
  };
  const env={DB:db,SHEETS_SYNC_ENABLED:'true',JOB_QUEUE:{async send(){},async sendBatch(messages){sent.push(...messages.map(message=>message.body));}}};
  const result=await reconcileSheets(env,{fromDate:'2026-07-01',toDate:'2026-07-31',limitPerType:20});
  assert.equal(result.enqueued,4);
  assert.deepEqual(new Set(sent.map(job=>job.entityType)),new Set(['ATTENDANCE_EVENT','DAILY_PAYROLL','WEEKLY_PAYROLL','EXPENSE']));
});
