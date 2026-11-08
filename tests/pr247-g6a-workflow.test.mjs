import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const text=fs.readFileSync(new URL("../.github/workflows/production-pr247-g6a-gate-on.yml",import.meta.url),"utf8");
const snapshot=fs.readFileSync(new URL("../scripts/pr247-readonly-snapshot.sh",import.meta.url),"utf8");
const wrangler=JSON.parse(fs.readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
const before=(needle)=>{let p=text.indexOf(needle);assert.ok(p>=0,needle);return p};

test("G6a manual-only and serialized with other production releases",()=>{
 assert.match(text,/^on:\n  workflow_dispatch:/m);
 assert.doesNotMatch(text,/^\s+(?:push|pull_request|schedule|workflow_run):/m);
 assert.match(text,/environment: production/);
 assert.match(text,/group: malipang-release-control/);
 assert.match(text,/cancel-in-progress: false/);
 assert.match(text,/OWNER APPROVED G6A GATE ON AFTER VERIFIED G5/);
});
test("G6a config is exactly gate ON/pacing ON without unapproved budget",()=>{
 assert.equal(wrangler.vars.STABLE_RECOVERY_GATE_ENABLED,"true");
 assert.equal(wrangler.vars.STABLE_SHEETS_PACING_ENABLED,"true");
 assert.equal(Object.hasOwn(wrangler.vars,"STABLE_SHEETS_READ_BUDGET_PER_MINUTE"),false);
 assert.match(text,/CONFIG_DRIFT_OUTSIDE_TWO_FLAGS/);
 assert.match(text,/REVIEWED_SOURCE_SHA: 4bb84a4869920f70981477de0ef69607438e2c74/);
});
test("G5 VERIFIED evidence, exact source and Worker are required before deploy",()=>{
 assert.ok(before("Verify exact G5 receipt")<before("Deploy precisely reviewed G6a config"));
 assert.match(text,/G5_RUN_ID/);
 assert.match(text,/G5_RUN_ATTEMPT/);
 assert.match(text,/G5_WORKER/);
 assert.match(text,/git diff --quiet/);
 assert.match(snapshot,/release-control\/pr247\/\$G5_RUN_ID-\$G5_RUN_ATTEMPT\.json/);
 assert.match(snapshot,/npx wrangler r2 object get|\$wrangler r2 object get/);
 assert.match(snapshot,/state/);
});
test("no replay, migration, Google write or claim release before or during G6a",()=>{
 assert.doesNotMatch(text,/(?:d1 migrations apply|queues pause-delivery|queues resume-delivery|queues purge|\/admin\/retry-sync|\/admin\/reconcile-sheets|sheets\.googleapis\.com|POST.*\/admin\/stable-sync)/i);
 assert.doesNotMatch(snapshot,/(?:d1 migrations apply|queues pause-delivery|queues resume-delivery|r2 object put|--command "\s*(?:DELETE|UPDATE|INSERT))/i);
 assert.match(snapshot,/d1 execute malipang-v5-2 --remote --json --command "\$sql"/);
 assert.match(snapshot,/\bSELECT\b/);
});
test("G6a requires observed gate UNARMED while retaining original REVIEW",()=>{
 assert.ok(before("Deploy precisely reviewed G6a config")<before("Readback must be ON/UNARMED"));
 assert.match(text,/scripts\/pr247-readonly-snapshot.sh A_PRE/);
 assert.match(text,/scripts\/pr247-readonly-snapshot.sh A_POST/);
 assert.match(text,/sleep 60/);
 assert.match(text,/NO_CANARY_STARTED/);
});
test("ambiguous G6a is an incident and never an automatic rollback",()=>{
 assert.match(text,/DEPLOY_ACK_UNKNOWN/);
 assert.match(text,/Incomplete or ambiguous results require Owner incident review/);
 assert.doesNotMatch(text,/wrangler rollback|rollbacks create|--force/);
});
