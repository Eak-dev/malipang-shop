// #296 step 4b: durable alerts with a cutoff that is not a valid UTC time
// silently fall back to main behaviour, so the deployed config must carry a
// valid one whenever durable alerts are on.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const vars=JSON.parse(readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')).vars;
test('durable alerts on require a valid SYNC_ALERT_DURABLE_SINCE (ISO-8601 UTC)',()=>{
  if(vars.SYNC_ALERT_DURABLE_ENABLED!=='true')return;
  assert.match(vars.SYNC_ALERT_DURABLE_SINCE??'',/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,'set SYNC_ALERT_DURABLE_SINCE to the agreed UTC time after migrate');
  assert.ok(Number.isFinite(Date.parse(vars.SYNC_ALERT_DURABLE_SINCE)));
});
