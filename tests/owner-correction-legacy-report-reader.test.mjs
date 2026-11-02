import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const moduleUrl=process.env.LEGACY_READER_TEST_MODULE?pathToFileURL(process.env.LEGACY_READER_TEST_MODULE).href:new URL('../dist/sheets/owner-correction-legacy-report-reader.js',import.meta.url).href;
const {readLegacyReportFormulaProtection:read}=await import(moduleUrl);
function fixture(){
  const data={formula:[Array.from({length:12},(_,i)=>[`=F${i+1}()`]),[['=CLEAN()']]],protections:{'รายวัน':{sheetId:1,ranges:[]},'04_OWNER_MONTH_CLOSE':{sheetId:2,ranges:[]},'97_EXPENSE_CLEAN':{sheetId:3,ranges:[]}}},calls=[];
  const ports={formulas:async(_env,ranges)=>{calls.push(['formulas',ranges]);return structuredClone(data.formula)},protection:async(_env,title)=>{calls.push(['protection',title]);return structuredClone(data.protections[title])}};
  return {data,calls,ports};
}
test('collects exactly the expected read-only formula and protection ranges twice',async()=>{
  const x=fixture(),result=await read({},x.ports);assert.ok(result);assert.equal(result.reportFormulas.length,12);assert.equal(result.cleanFormula,'=CLEAN()');
  assert.deepEqual(x.calls.filter(c=>c[0]==='formulas').map(c=>c[1]),Array(2).fill(["'04_OWNER_MONTH_CLOSE'!C24:C35","'97_EXPENSE_CLEAN'!A2"]));
  assert.equal(x.calls.filter(c=>c[0]==='protection').length,6);
});
test('rejects incomplete formula responses, duplicate sheet identities and access errors',async()=>{
  const a=fixture();a.data.formula[0].pop();assert.equal(await read({},a.ports),null);
  const b=fixture();b.data.formula[0][0]=['not a formula'];assert.equal(await read({},b.ports),null);
  const c=fixture();c.data.protections['97_EXPENSE_CLEAN'].sheetId=2;assert.equal(await read({},c.ports),null);
  const d=fixture();d.ports.protection=async()=>{throw Error('unavailable')};assert.equal(await read({},d.ports),null);
});
test('rejects changes between the two reads, including shared-object mutation',async()=>{
  const x=fixture();let calls=0;x.ports.formulas=async()=>{if(++calls===2)x.data.formula[0][0]=['=DRIFT()'];return x.data.formula};
  assert.equal(await read({},x.ports),null);
  const y=fixture();let count=0;y.ports.protection=async(_env,title)=>{if(title==='รายวัน'&&++count===2)y.data.protections[title].ranges.push({warningOnly:true});return y.data.protections[title]};
  assert.equal(await read({},y.ports),null);
});
test('does not claim protection is safe merely because metadata was returned',async()=>{
  const x=fixture();x.data.protections['รายวัน'].ranges=[{warningOnly:true}];const result=await read({},x.ports);
  assert.equal(result.dailyProtection[0].warningOnly,true);
});
