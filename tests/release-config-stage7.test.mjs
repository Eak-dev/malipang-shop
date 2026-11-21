import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('gate release keeps both temporary operators off and pacing on',()=>{
 const vars=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')).vars;
 assert.equal(vars.CONTINUOUS_CANARY_OPERATOR_ENABLED,'false');
 assert.equal(vars.CANARY_UNWRITTEN_RECOVERY_ENABLED,'false');
 assert.equal(vars.STABLE_RECOVERY_GATE_ENABLED,'false');
 assert.equal(vars.STABLE_PHASE1_ENABLED,'true');
 assert.equal(vars.STABLE_SHEETS_PACING_ENABLED,'true');
 assert.equal(vars.CONTINUOUS_DAILY_ENABLED,'true');
 assert.equal(vars.UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED,undefined);
});
