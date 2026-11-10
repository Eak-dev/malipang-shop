import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { validateSteadyConfig } from "../scripts/pr247-steady-config-check.mjs";

const workflow = fs.readFileSync(new URL("../.github/workflows/production-pr247-steady-gate-off-pacing-on.yml", import.meta.url), "utf8");
const helper = fs.readFileSync(new URL("../scripts/pr247-readonly-snapshot.sh", import.meta.url), "utf8");
const guard = fs.readFileSync(new URL("../scripts/pr247-stage-guard.mjs", import.meta.url), "utf8");
const runbook = fs.readFileSync(new URL("../docs/ISSUE248_STEADY_PR_B_PREP_TH.md", import.meta.url), "utf8");
const idx=s=>{const x=workflow.indexOf(s);assert.notEqual(x,-1,s);return x;};
const base = {
  triggers:{crons:["*/5 * * * *"]},
  vars:{STABLE_PHASE1_ENABLED:"true",SHEETS_SYNC_ENABLED:"true"}
};
const steady = structuredClone(base);
steady.vars.STABLE_RECOVERY_GATE_ENABLED="false";
steady.vars.STABLE_SHEETS_PACING_ENABLED="true";

test("manual-only, Owner-gated, no automated triggers", () => {
  assert.match(workflow,/^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow,/^\s+(?:push|pull_request|schedule|workflow_run):/m);
  assert.match(workflow,/group: malipang-release-control/);
  assert.match(workflow,/cancel-in-progress: false/);
  assert.match(workflow,/environment: production/);
  assert.match(workflow,/test "\$GITHUB_ACTOR" = 'Eak-dev'/);
  assert.match(workflow,/OWNER APPROVED PR247 G8 STEADY AFTER G7 PASS/);
});
test("only config delta is literal Gate OFF / Pacing ON", () => {
  assert.equal(validateSteadyConfig(base,steady),true);
  const x=structuredClone(steady); x.vars.STABLE_RECOVERY_GATE_ENABLED="true";
  assert.throws(()=>validateSteadyConfig(base,x),/NO_GO_STEADY_FLAGS/);
  x.vars.STABLE_RECOVERY_GATE_ENABLED="false";x.vars.STABLE_SHEETS_PACING_ENABLED="false";
  assert.throws(()=>validateSteadyConfig(base,x),/NO_GO_STEADY_FLAGS/);
  x.vars.STABLE_SHEETS_PACING_ENABLED="true";x.vars.STABLE_SHEETS_READ_BUDGET_PER_MINUTE="60";
  assert.throws(()=>validateSteadyConfig(base,x),/NO_GO_UNAPPROVED_PACING_BUDGET/);
  delete x.vars.STABLE_SHEETS_READ_BUDGET_PER_MINUTE;
  x.vars.UNAPPROVED_EXTRA="true";
  assert.throws(()=>validateSteadyConfig(base,x),/NO_GO_UNRELATED_CONFIG_DRIFT/);
});
test("source pin prevents unrelated runtime change",()=>{
  assert.match(workflow,/REVIEWED_SOURCE_SHA: c5941ea3f88456c1475f367fd5c650d75e24c05e/);
  assert.match(workflow,/CONFIG_BASELINE_SHA: 4bb84a4869920f70981477de0ef69607438e2c74/);
  assert.match(workflow,/git merge-base --is-ancestor "\$REVIEWED_SOURCE_SHA" HEAD/);
  assert.match(workflow,/git rev-parse refs\/review\/pr247\)" = "\$CONFIG_BASELINE_SHA"/);
  assert.match(workflow,/test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/);
  assert.match(workflow,/test "\$\(git ls-remote origin refs\/heads\/main \| cut -f1\)" = "\$EXPECTED_SHA"/);
  assert.match(workflow,/git diff --quiet "\$REVIEWED_SOURCE_SHA" HEAD -- src migrations package\.json package-lock\.json tsconfig\.json/);
});
test("runtime preflight must run after local CI but before any deploy",()=>{
  const arr=[idx("npm run check"),idx("wrangler deploy --dry-run"),idx("scripts/pr247-readonly-snapshot.sh B_PRE"),idx("npx wrangler deploy >"),idx("scripts/pr247-readonly-snapshot.sh B_POST")];
  assert.deepEqual([...arr].sort((a,b)=>a-b),arr);
  assert.match(workflow,/G7_RECEIPT_KEY/);
  assert.match(workflow,/G7_RECEIPT_SHA256/);
  assert.match(workflow,/G6A_WORKER/);
  assert.match(helper,/NO_GO_RECEIPT_SHA256/);
});
test("B_PRE and B_POST require exact private D1 epoch, not only aggregate counters",()=>{
  assert.match(helper,/epoch_id/);
  assert.match(helper,/SELECT count\(\*\) FROM target/);
  assert.match(helper,/source_version=e\.target_version/);
  assert.match(helper,/p\.projection='DETAIL'/);
  assert.match(guard,/epoch\.epoch_found === 1/);
  assert.match(guard,/e\.receipt\.expected_detail_count === epoch\.detail/);
  assert.match(guard,/gcp_quotas_checked === true/);
  assert.match(guard,/gcp_429_delta === 0/);
  assert.match(guard,/receipt\?\.g5_sha, params\.g5Sha/);
});
test("after deploy tests guard for 100% new Worker and steady modes",()=>{
  assert.match(workflow,/G8_PRIOR_WORKER_DRIFT/);
  assert.match(workflow,/G8_CRON_DRIFT/);
  assert.match(workflow,/G8_QUEUE_DRIFT/);
  assert.match(workflow,/prb-immediate-worker.json/);
  assert.match(workflow,/deployments\[0\]\.versions/);
  assert.match(workflow,/percentage == 100/);
  assert.match(workflow,/issue248-version-proof\.mjs/);
  assert.match(workflow,/sleep 360/);
  assert.match(workflow,/G8_NO_POSITIVE_PROGRESS_EVIDENCE/);
  assert.match(guard,/STALE_WRITER_AFTER_GATE_EXIT/);
  assert.match(guard,/STEADY_MODE_NOT_ACTIVE/);
  assert.match(guard,/STEADY_NEW_FAILURE/);
});
test('missing Queue pause field requires bounded evidence and scoped remediation',()=>{
 assert.match(workflow,/G8_QUEUE_FIELD_UNKNOWN: missing delivery_paused is NOT false/);
 assert.match(workflow,/no blind retry\/resume\/rollback/);
 assert.match(workflow,/scripts\/issue248-queue-remediation\.sh pre/);
 assert.match(workflow,/scripts\/issue248-queue-remediation\.sh post/);
 assert.ok(idx("issue248-queue-remediation.sh pre")<idx("npx wrangler deploy >"));
 assert.ok(idx("npx wrangler deploy >")<idx("issue248-queue-remediation.sh post"));
 assert.ok(idx("issue248-queue-remediation.sh post")<idx("scripts/pr247-readonly-snapshot.sh B_POST"));
 assert.match(workflow,/actions: read/);
 assert.match(workflow,/GH_TOKEN: \$\{\{ github\.token \}\}/);
 assert.match(workflow,/G8_DIAGNOSTIC_RECEIPT_MISMATCH/);
 assert.match(workflow,/42816833410-1-verified\.json/);
 for(const hash of ["a939610311f6d4c34f931bc4aabeca11bf81f5c4ecaee405bc2737aeec550b99","3c75b14b07c715ccea25e99ae5ebfc650c21fbf8a0d61013f6bacadb53f64735","b909bf631249aac620be8a538772f7b2826b45185b590f865c5d0c3e526e729c"])assert.ok(workflow.includes(hash));
 assert.match(guard,/cf\.queue\?\.settings\?\.delivery_paused === false/);
 assert.match(runbook,/Absence remains UNKNOWN/);
 assert.match(runbook,/no blind|blindly retry/);
 assert.match(workflow,/G8_PRE_COMPLETED=/);
 assert.match(workflow,/G8_PRE_OPEN_FAILED=/);
});
test("no automatic rollback, Queue replay, D1 migration, D1 writer or workbook mutation",()=>{
  const disallowed=[
    /queues pause-delivery/,/queues resume-delivery/,/queues purge/,
    /d1 migrations apply/,/d1 export/,/r2 object put/,
    /\/admin\/retry-sync/,/includeTerminalDlq:true/,
    /sheets\.googleapis\.com/,/wrangler rollback/,
    /UPDATE stable_workbook_claims/,/DELETE FROM stable_workbook_claims/
  ];
  for(const rx of disallowed) {
    assert.doesNotMatch(workflow,rx);
    assert.doesNotMatch(helper,rx);
  }
  assert.match(workflow,/Never blindly deploy the old Worker, replay terminal DLQ/);
});
test("runbook states that Provider metrics and Owner release gate are mandatory",()=>{
  for(const s of ["GCP","429","Owner","COMPLETE","IN_FLIGHT","readback","Terminal DLQ"]){
    assert.ok(runbook.includes(s),"runbook missing "+s);
  }
});

test('monitoring exception appears explicitly in workflow summary',()=>{assert.match(workflow,/MONITORING_PARTIAL_OWNER_RISK_ACCEPTED_NOT_429_ZERO/);assert.match(runbook,/gcp_429_delta=null/);assert.match(runbook,/not proof that no 429 occurred/)});
