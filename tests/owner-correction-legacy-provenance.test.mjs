import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const provenanceUrl=process.env.LEGACY_PROVENANCE_TEST_MODULE?pathToFileURL(process.env.LEGACY_PROVENANCE_TEST_MODULE).href:new URL('../dist/sheets/owner-correction-legacy-provenance.js',import.meta.url).href;
const validatorUrl=process.env.LEGACY_TEST_MODULE?pathToFileURL(process.env.LEGACY_TEST_MODULE).href:new URL('../dist/sheets/owner-correction-legacy-report-validation.js',import.meta.url).href;
const {matchLegacyOwnerProvenance:match}=await import(provenanceUrl);
const {legacyReportMatchesTrustedEvidence:validate,normalizeLegacyReportFormula:normalize}=await import(validatorUrl);
const time='2026-07-15T04:00:00.000Z',digest=async v=>createHash('sha256').update(v).digest('hex');
const posting=()=>({postingYear:2026,postingMonth:7,postingDay:15,amountColumn:7,wallet:'บัญชีร้าน'});
function fixture(){
  const values=Array(25).fill('');values[1]=7;values[2]=15;values[3]='fixture';values[7]=10;values[21]='general';values[22]='บัญชีร้าน';values[23]='general';values[24]='fixture';
  const expense={expenseId:'exp_fake_one',status:'CONFIRMED',version:2,updatedAt:time,approvedAt:time,reviewedBy:'owner',description:'fixture',category:'general',amountSatang:1000,transactionDate:'2026-07-15',paymentKey:'transfer',sourceWallet:'shop_bank'};
  return {sheetId:1,lastRow:5,expenses:[expense],rows:[{rowNumber:5,sheetYear:2026,values}],markers:[{metadataId:7,metadataKey:'malipang_expense_daily',metadataValue:expense.expenseId,sheetId:1,rowIndex:4}],indexes:[{entityKey:expense.expenseId,rowNumber:5}],audits:[{auditId:'audit_fake_one',expenseId:expense.expenseId,actorEmployeeId:'owner',action:'CONFIRM',createdAt:time,afterJson:JSON.stringify({status:'CONFIRMED',version:2})}],roles:[{employeeId:'owner',role:'OWNER',scope:'ORGANIZATION',effectiveFrom:'2020-01-01T00:00:00.000Z',effectiveTo:null}],coverage:{expenses:'ALL_RELEVANT',rows:'ALL_DAILY_ROWS',markers:'ALL_DOCUMENT_MARKERS',indexes:'ALL_DAILY_INDEXES',audits:'ALL_EXPENSE_AUDITS',roles:'ALL_ROLE_HISTORY'}};
}
function decision(input){const r=match(input,posting);assert.equal(r.valid,true);return r.decisions[0];}
test('owner-confirmed current version plus unique stable identity yields source evidence',()=>{
  const d=decision(fixture());assert.equal(d.status,'MATCHED_OWNER_AUDIT');assert.equal(d.approvedRow.kind,'verified_d1');assert.equal(d.reasons.length,0);
});
test('missing, staff, expired, ambiguous or stale audit proof is held',()=>{
  for(const mutate of [x=>x.audits=[],x=>x.roles[0].role='EMPLOYEE',x=>x.roles[0].effectiveTo=time,x=>x.audits[0].afterJson=JSON.stringify({status:'CONFIRMED',version:1}),x=>x.expenses[0].approvedAt=null,x=>x.roles.push({...x.roles[0]})]){
    const x=fixture();mutate(x);assert.equal(decision(x).status,'REVIEW');assert.ok(decision(x).reasons.includes('OWNER_AUDIT_MISSING_OR_AMBIGUOUS'));
  }
});
test('owner edit requires full current after snapshot, including category and financial values',()=>{
  const x=fixture(),e=x.expenses[0];x.audits[0].action='EDIT';x.audits[0].afterJson=JSON.stringify(e);assert.equal(decision(x).status,'MATCHED_OWNER_AUDIT');
  const bad={...e,category:'transport'};x.audits[0].afterJson=JSON.stringify(bad);assert.equal(decision(x).status,'REVIEW');
});
test('ambiguous rows, stale index, missing marker and unapproved source are held',()=>{
  const a=fixture();a.lastRow=6;a.rows.push({...structuredClone(a.rows[0]),rowNumber:6});assert.ok(decision(a).reasons.includes('AMBIGUOUS_ROW'));
  const b=fixture();b.indexes[0].rowNumber=6;assert.ok(decision(b).reasons.includes('INDEX_MISSING_OR_CONFLICT'));
  const c=fixture();c.markers=[];assert.ok(decision(c).reasons.includes('MARKER_MISSING_OR_CONFLICT'));
  const d=fixture();d.rows[0].values[23]='transport';assert.ok(decision(d).reasons.includes('APPROVED_SOURCE_MISMATCH'));
  const e=fixture();e.rows[0].values[21]='transport';assert.ok(decision(e).reasons.includes('DAILY_CATEGORY_OR_WALLET_MISMATCH'));
  const f=fixture();f.expenses.push({...f.expenses[0],expenseId:'exp_fake_two'});assert.ok(decision(f).reasons.includes('ROW_SHARED_BY_EXPENSES'));
});
test('incomplete coverage, non-contiguous rows and unresolved posting fail closed',()=>{
  const a=fixture();a.coverage.roles='PARTIAL';assert.equal(match(a,posting).valid,false);
  const b=fixture();b.rows=[];assert.equal(match(b,posting).valid,false);
  const c=fixture();assert.equal(match(c,()=>null).valid,false);
  const d=fixture();d.roles.push(null);assert.equal(match(d,posting).valid,false);
  const e=fixture();assert.equal(match(e,()=>({...posting(),amountColumn:99})).valid,false);
});
test('owner audit provenance integrates with separately pinned report and protection validation',async()=>{
  const x=fixture(),d=decision(x),guard=(id,sr,er,sc,ec)=>({range:{sheetId:id,startRowIndex:sr,...(er===undefined?{}:{endRowIndex:er}),startColumnIndex:sc,endColumnIndex:ec},requestingUserCanEdit:true,editors:{users:['worker@example.test']}});
  const report=Array.from({length:12},()=>"=SUM('รายวัน'!X5:X5,'รายวัน'!Y5:Y5)"),clean="=SUM('รายวัน'!X5:X5,'รายวัน'!Y5:Y5)";
  const o={dailySheetId:1,reportSheetId:2,cleanSheetId:3,lastRow:5,reportFormulas:report,cleanFormula:clean,rows:[{row:5,identity:d.approvedRow.identity,hasFinancialData:true,displayCategory:'general',displayDescription:'fixture',approvedCategory:'general',approvedDescription:'fixture'}],dailyProtection:[guard(1,4,undefined,23,25)],reportProtection:[guard(2,23,35,2,3)],cleanProtection:[guard(3,1,2,0,1)]};
  const policy={serviceAccount:'worker@example.test',formulaDigest:await digest(JSON.stringify([...report,clean].map(f=>normalize(f,5))))};
  assert.equal(await validate(o,structuredClone(o),policy,[d.approvedRow],digest),true);
  assert.equal(await validate(o,structuredClone(o),policy,[],digest),false);
});
