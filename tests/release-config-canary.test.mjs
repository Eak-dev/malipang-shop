// #296 step 6: continuous daily writes. The owner decided unwritten expenses
// are held for review, never auto-cancelled (UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED
// stays unset), and the tab targets and preimage capture must already be on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const vars=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')).vars;
test('continuous daily on keeps auto-cancel off and needs the step 4d targets',()=>{
  if(vars.CONTINUOUS_DAILY_ENABLED!=='true')return;
  assert.equal(vars.UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED,undefined,'owner decision #296 item 7: leave auto-cancel unset');
  assert.equal(vars.STABLE_CANCELLATION_PREIMAGE_ENABLED,'true');
  for(const k of ['CONTINUOUS_CUTOVER_OPERATOR_ENABLED','CONTINUOUS_CUTOVER_PREWRITE_REVIEW_ENABLED','CONTINUOUS_VIEWS_INCIDENT_RECOVERY_ENABLED'])assert.equal(vars[k],'false',`${k} must be disabled after RELEASE`);
  if(vars.CONTINUOUS_CANARY_OPERATOR_ENABLED==='true')assert.equal(vars.STABLE_RECOVERY_GATE_ENABLED,'true','canary must keep the recovery gate enabled');
  for(const k of ['CONTINUOUS_DAILY_SHEET','CONTINUOUS_DAILY_SHEET_ID','CONTINUOUS_RAW_SHEET','CONTINUOUS_RAW_SHEET_ID','CONTINUOUS_DETAIL_SHEET','CONTINUOUS_DETAIL_SHEET_ID'])assert.ok(vars[k],k);
});
