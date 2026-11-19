// #296 step 5: the cutover operator only works while CONTINUOUS_DAILY_ENABLED
// is unset, and START_REVIEW needs the fingerprint printed by the
// review_fingerprint workflow run.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const vars=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')).vars;
test('prewrite review on requires a 64-hex fingerprint',()=>{
  if(vars.CONTINUOUS_CUTOVER_PREWRITE_REVIEW_ENABLED!=='true')return;
  assert.match(vars.CONTINUOUS_CUTOVER_REVIEW_FINGERPRINT??'',/^[a-f0-9]{64}$/,'paste the review_fingerprint value from the workflow run');
});
test('operator on requires the gate, pacing and report cutover, with daily writes still off',()=>{
  if(vars.CONTINUOUS_CUTOVER_OPERATOR_ENABLED!=='true')return;
  for(const k of ['CONTINUOUS_REPORT_CUTOVER_ENABLED','STABLE_PHASE1_ENABLED','STABLE_RECOVERY_GATE_ENABLED','STABLE_SHEETS_PACING_ENABLED'])assert.equal(vars[k],'true',k);
  assert.ok([undefined,'','false'].includes(vars.CONTINUOUS_DAILY_ENABLED),'the operator refuses to run once CONTINUOUS_DAILY_ENABLED is set');
});
