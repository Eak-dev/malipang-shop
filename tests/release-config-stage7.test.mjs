import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

test('stage 7 disables Canary while preserving the recovery gate',()=>{
 const vars=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')).vars;
 assert.equal(vars.CONTINUOUS_CANARY_OPERATOR_ENABLED,'false');
 assert.equal(vars.STABLE_RECOVERY_GATE_ENABLED,'true');
 assert.equal(vars.CONTINUOUS_DAILY_ENABLED,'true');
 assert.equal(vars.UNWRITTEN_EXPENSE_AUTO_CANCEL_ENABLED,undefined);
});
