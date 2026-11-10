import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
const workflow=readFileSync(new URL('../.github/workflows/issue248-original-notice-diagnostic-deploy.yml',import.meta.url),'utf8');
test('diagnostic workflow validates exact runtime before a bounded deploy and performs two postchecks',()=>{
 const pins=workflow.indexOf('sha256sum --check'),pre=workflow.indexOf('pr247-readonly-snapshot.sh A_POST'),deploy=workflow.indexOf('npx wrangler deploy >'),post=workflow.indexOf('pr247-readonly-snapshot.sh A_POST',pre+1),observe=workflow.indexOf('pr247-readonly-snapshot.sh A_POST',post+1);
 assert.ok(pins>=0&&pins<pre&&pre<deploy&&deploy<post&&post<observe);assert.match(workflow,/sleep 360/);assert.match(workflow,/STABLE_RECOVERY_GATE_ENABLED.*true/);assert.match(workflow,/STABLE_SHEETS_PACING_ENABLED.*true/);
});
test('diagnostic workflow preserves separate intent and verified receipt and stops on uncertain queue',()=>{
 assert.match(workflow,/\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT-intent\.json/);assert.match(workflow,/\$GITHUB_RUN_ID-\$GITHUB_RUN_ATTEMPT-verified\.json/);assert.match(workflow,/missing Queue delivery_paused field is UNKNOWN/);assert.doesNotMatch(workflow,/wrangler queues (?:resume|pause|purge)/);assert.doesNotMatch(workflow,/wrangler rollback/);assert.match(workflow,/updates configured Queue producers\/consumers and Cron triggers/);
});
test('deployment evidence binds Wrangler output to actual 100% provider version',()=>{
 assert.match(workflow,/issue248-version-proof\.mjs/);assert.match(workflow,/a939610311f6d4c34f931bc4aabeca11bf81f5c4ecaee405bc2737aeec550b99/);assert.match(workflow,/DEPLOY_ACK_UNKNOWN/);assert.match(workflow,/read-only|Read back guard/i);
});
