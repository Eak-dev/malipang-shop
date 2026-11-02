import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectOwnerCorrectionReportDeduplication as inspect} from '../dist/sheets/owner-correction-report-inspection.js';
const before={expenseId:'e',status:'CONFIRMED',transactionDate:'2026-10-28',amountSatang:200000},after={...before,amountSatang:250000};
const row=['e','2026-10-28',null,2000,null,null,null,'CONFIRMED'];row[16]='ORDER';
const hash='9b7f6f3649c74be7f6f1f183ce1243faa753e55bfb60d1b8aeb74f037597d6a4';
test('live report preflight checks full reads, formula fingerprint and stable snapshots',async()=>{
  const env={SHEET_EXPENSE_RAW:'V52_EXPENSE_RAW'};let formula='formula',rows=[row],calls=0;
  const ports={formula:async()=>[[[formula]]],values:async()=>{calls++;return structuredClone(rows)},digest:async()=>hash};
  assert.equal(await inspect(env,before,after,ports),true);assert.equal(calls,2);
  assert.equal(await inspect({...env,SHEET_EXPENSE_RAW:'other'},before,after,ports),false);
  ports.digest=async()=> 'unexpected';assert.equal(await inspect(env,before,after,ports),false);ports.digest=async()=>hash;
  ports.formula=async()=>[];assert.equal(await inspect(env,before,after,ports),false);ports.formula=async()=>[[[formula]]];
  let formulaReads=0;ports.formula=async()=>[[[formulaReads++?'changed':formula]]];assert.equal(await inspect(env,before,after,ports),false);ports.formula=async()=>[[[formula]]];
  const duplicate=[...row];duplicate[0]='other';duplicate[3]=2500;rows=[row,duplicate];assert.equal(await inspect(env,before,after,ports),false);rows=[row];
  calls=0;ports.values=async()=>{calls++;return calls===1?[row]:[]};assert.equal(await inspect(env,before,after,ports),false);
  ports.values=async()=>{throw Error('unavailable')};await assert.rejects(inspect(env,before,after,ports),/unavailable/);
});
