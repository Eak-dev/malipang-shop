import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const moduleUrl=process.env.LEGACY_TEST_MODULE?pathToFileURL(process.env.LEGACY_TEST_MODULE).href:new URL('../dist/sheets/owner-correction-legacy-report-validation.js',import.meta.url).href;
const {legacyReportMatchesTrustedEvidence:validate,normalizeLegacyReportFormula:normalize}=await import(moduleUrl);
const digest=async v=>createHash('sha256').update(v).digest('hex');
const guard=(sheetId,startRowIndex,endRowIndex,startColumnIndex,endColumnIndex)=>({range:{sheetId,startRowIndex,...(endRowIndex===undefined?{}:{endRowIndex}),startColumnIndex,endColumnIndex},requestingUserCanEdit:true,editors:{users:['worker@example.test']}});
async function fixture(){
  const report=Array.from({length:12},()=>"=SUM('รายวัน'!$X$5:$X$6,'รายวัน'!$Y$5:$Y$6)");
  const clean="=SUM('รายวัน'!X5:X6,'รายวัน'!Y5:Y6)";
  const first={dailySheetId:1,reportSheetId:2,cleanSheetId:3,lastRow:6,reportFormulas:report,cleanFormula:clean,rows:[{row:5,identity:'one',hasFinancialData:true,displayCategory:'untrusted',displayDescription:'display',approvedCategory:'general',approvedDescription:'approved'},{row:6,identity:null,hasFinancialData:false,displayCategory:'',displayDescription:'',approvedCategory:'',approvedDescription:''}],dailyProtection:[guard(1,4,undefined,23,25)],reportProtection:[guard(2,23,35,2,3)],cleanProtection:[guard(3,1,2,0,1)]};
  const approved=[{row:5,identity:'one',kind:'verified_d1',evidenceId:'evidence-one',approvedCategory:'general',approvedDescription:'approved'}];
  const policy={serviceAccount:'worker@example.test',formulaDigest:await digest(JSON.stringify([...report,clean].map(f=>normalize(f,6))))};
  return {first,second:structuredClone(first),policy,approved};
}
const check=x=>validate(x.first,x.second,x.policy,x.approved,digest);
test('matches only complete, stable reads, pinned formulas, protection and independently supplied provenance',async()=>{
  const x=await fixture();assert.equal(await check(x),true);
  x.first.rows[0].displayCategory='another direct edit';x.second=structuredClone(x.first);assert.equal(await check(x),true);
  x.first.rows[0].approvedCategory='transport';x.second=structuredClone(x.first);assert.equal(await check(x),false);
});
test('rejects missing provenance, ambiguous identities and incomplete scans',async()=>{
  const x=await fixture();x.approved=[];assert.equal(await check(x),false);
  const y=await fixture();y.first.rows.pop();y.second=structuredClone(y.first);assert.equal(await check(y),false);
  const z=await fixture();z.approved.push({...z.approved[0],row:6});assert.equal(await check(z),false);
  const w=await fixture();w.first.rows[1].hasFinancialData=true;w.second=structuredClone(w.first);assert.equal(await check(w),false);
});
test('rejects drift, untrusted references, absent policy and weakened protection',async()=>{
  const x=await fixture();x.second.cleanFormula+=' ';assert.equal(await check(x),false);
  const y=await fixture();y.first.reportFormulas[0]+="+'รายวัน'!$V$5:$V$6";y.second=structuredClone(y.first);assert.equal(await check(y),false);
  const z=await fixture();z.first.dailyProtection[0].warningOnly=true;z.second=structuredClone(z.first);assert.equal(await check(z),false);
  const a=await fixture();a.first.cleanProtection[0].editors.groups=['everyone'];a.second=structuredClone(a.first);assert.equal(await check(a),false);
  const b=await fixture();b.first.dailyProtection[0].range.endRowIndex=6;b.second=structuredClone(b.first);assert.equal(await check(b),false);
  const c=await fixture();c.policy=null;assert.equal(await check(c),false);
});
test('rejects shortened or inconsistent range ends and formula digest mismatch',async()=>{
  assert.equal(normalize("=SUM('รายวัน'!X5:X5)",6),null);
  assert.equal(normalize("=SUM('รายวัน'!X5:X6,'รายวัน'!Y5:Y7)",6),null);
  const x=await fixture();x.first.cleanFormula+=' ';x.second=structuredClone(x.first);assert.equal(await check(x),false);
});
