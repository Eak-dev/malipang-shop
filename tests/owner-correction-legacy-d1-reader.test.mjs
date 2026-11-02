import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const url=process.env.LEGACY_D1_TEST_MODULE?pathToFileURL(process.env.LEGACY_D1_TEST_MODULE).href:new URL('../dist/sheets/owner-correction-legacy-d1-reader.js',import.meta.url).href;
const {readLegacyD1Diagnostic:read,diagnoseLegacyD1Provenance:diagnose}=await import(url);
const digest=async v=>createHash('sha256').update(v).digest('hex');
const at='2026-07-15T04:00:00.000Z';
const posting=()=>({postingYear:2026,postingMonth:7,postingDay:15,amountColumn:7,wallet:'บัญชีร้าน'});
async function fixture(){
  const expense={expenseId:'exp_fake_one',status:'CONFIRMED',version:2,updatedAt:at,approvedAt:at,reviewedBy:'owner',description:'fixture',category:'general',amountSatang:1000,transactionDate:'2026-07-15',paymentKey:'transfer',sourceWallet:'shop_bank'};
  const role={assignmentId:'role_owner',employeeId:'owner',role:'OWNER',scope:'ORGANIZATION',status:'ACTIVE',effectiveFrom:'2020-01-01T00:00:00.000Z',effectiveTo:null};
  const data={expenses:[expense],audits:[{auditId:'audit_fake_one',expenseId:expense.expenseId,actorEmployeeId:'owner',action:'CONFIRM',createdAt:at,afterJson:JSON.stringify({status:'CONFIRMED',version:2})}],roles:[role],indexes:[{entityKey:expense.expenseId,rowNumber:5}]};
  let batchCalls=0;const statements=[];
  const db={prepare(sql){assert.match(sql,/^SELECT /);assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i);const s={sql,args:[],bind(...args){this.args=args;return this}};statements.push(s);return s},async batch(stmts){assert.equal(stmts.length,8);batchCalls++;const sets=[data.expenses,data.audits,data.roles,data.indexes];return sets.flatMap(rows=>[{success:true,results:[{n:rows.length}],meta:{}},{success:true,results:structuredClone(rows),meta:{}}])}};
  const values=Array(25).fill('');values[1]=7;values[2]=15;values[3]='fixture';values[7]=10;values[21]='general';values[22]='บัญชีร้าน';values[23]='general';values[24]='fixture';
  const sheet={sheetId:1,lastRow:5,rows:[{rowNumber:5,sheetYear:2026,values}],markers:[{metadataId:1,metadataKey:'malipang_expense_daily',metadataValue:expense.expenseId,sheetId:1,rowIndex:4}],coverage:{rows:'ALL_DAILY_ROWS',markers:'ALL_DOCUMENT_MARKERS'}};
  const proof={evidenceId:'independent-proof',coveredFrom:'2020-01-01T00:00:00.000Z',coveredThrough:'2027-01-01T00:00:00.000Z',roleHistoryDigest:await digest(JSON.stringify(data.roles))};
  return {db,data,sheet,proof,statements,get batchCalls(){return batchCalls},params(){return {db,sheet,sheetName:'รายวัน',limit:100,proof,digest,verifyProof:async()=>true,posting}}};
}
test('reads complete counts and SELECT rows twice, then runs diagnostic with authenticated mock history',async()=>{
  const x=await fixture(),r=await diagnose(x.params());assert.equal(r.ok,true);assert.equal(r.result.decisions[0].status,'MATCHED_OWNER_AUDIT');assert.equal(x.batchCalls,2);assert.equal(x.statements.length,16);
});
test('fails closed on missing history proof or untrusted proof and never treats current role alone as enough',async()=>{
  const x=await fixture();assert.equal((await diagnose({...x.params(),proof:null})).ok,false);assert.equal(x.batchCalls,0);
  assert.equal((await diagnose({...x.params(),verifyProof:async()=>false})).reason,'ROLE_HISTORY_UNVERIFIED');
  const y=await fixture();y.data.roles[0].effectiveFrom='2026-08-01T00:00:00.000Z';y.proof.roleHistoryDigest=await digest(JSON.stringify(y.data.roles));const r=await diagnose(y.params());assert.equal(r.ok,true);assert.equal(r.result.decisions[0].status,'REVIEW');
});
test('rejects truncation, failed query, unstable reads and role digest drift',async()=>{
  const a=await fixture();assert.equal(await read(a.db,'รายวัน',0),null);assert.equal(await read(a.db,'other',100),null);
  const b=await fixture(),original=b.db.batch;b.db.batch=async s=>{const r=await original(s);r[0].results[0].n++;return r};assert.equal(await read(b.db,'รายวัน',100),null);
  const c=await fixture();c.db.batch=async()=>{throw Error('unavailable')};assert.equal(await read(c.db,'รายวัน',100),null);
  const d=await fixture(),orig=d.db.batch;d.db.batch=async s=>{const r=await orig(s);if(d.batchCalls===2)r[1].results[0].category='transport';return r};assert.equal(await read(d.db,'รายวัน',100),null);
  const e=await fixture();e.proof.roleHistoryDigest='0'.repeat(64);assert.equal((await diagnose(e.params())).reason,'ROLE_HISTORY_UNVERIFIED');
});
test('rejects incomplete role interval, overlapping assignments and audit outside proof coverage',async()=>{
  const a=await fixture();a.data.roles[0].status='INACTIVE';assert.equal((await diagnose(a.params())).reason,'ROLE_HISTORY_INCOMPLETE');
  const b=await fixture();b.data.roles.push({...b.data.roles[0],assignmentId:'another'});assert.equal((await diagnose(b.params())).reason,'ROLE_HISTORY_AMBIGUOUS');
  const c=await fixture();c.proof.coveredThrough='2025-01-01T00:00:00.000Z';assert.equal((await diagnose(c.params())).reason,'ROLE_HISTORY_OUTSIDE_COVERAGE');
});
