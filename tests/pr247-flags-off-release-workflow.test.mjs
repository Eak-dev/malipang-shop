import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow=fs.readFileSync(new URL("../.github/workflows/production-pr247-flags-off-release.yml",import.meta.url),"utf8");
const at=(text)=>{const index=workflow.indexOf(text);assert.notEqual(index,-1,`missing: ${text}`);return index;};

test("PR247 release runs only on manual dispatch with an exact typed confirmation",()=>{
  assert.match(workflow,/^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow,/^\s+(push|pull_request|schedule|workflow_run):/m);
  assert.match(workflow,/test "\$CONFIRMATION" = 'RELEASE PR247 4bb84a4 MIGRATION 0023 FLAGS OFF KEEP REVIEW'/);
  assert.match(workflow,/environment: production/);
  assert.match(workflow,/group: malipang-release-control/);
});

test("PR247 release binds the merged main input to the independently reviewed source tree",()=>{
  assert.match(workflow,/REVIEWED_SOURCE_SHA: 4bb84a4869920f70981477de0ef69607438e2c74/);
  assert.match(workflow,/test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/);
  assert.match(workflow,/test "\$\(git ls-remote origin refs\/heads\/main \| cut -f1\)" = "\$EXPECTED_SHA"/);
  assert.match(workflow,/test "\$\(git rev-parse refs\/review\/pr247\)" = "\$REVIEWED_SOURCE_SHA"/);
  assert.match(workflow,/git diff --quiet "\$REVIEWED_SOURCE_SHA" HEAD -- src migrations wrangler\.jsonc package\.json package-lock\.json tsconfig\.json/);
  // No merged SHA is invented in advance; it is a run input.
  assert.doesNotMatch(workflow,/EXPECTED_SHA: [0-9a-f]{40}/);
});

test("PR247 release can apply only migration 0023 after 0022 and keeps P0 flags absent",()=>{
  assert.match(workflow,/PRIOR_MIGRATION: 0022_stable_claim_diagnostics\.sql/);
  assert.match(workflow,/MIGRATION: 0023_stable_recovery_admission\.sql/);
  assert.match(workflow,/test "\$\(ls migrations \| awk -v p="\$PRIOR_MIGRATION" '\$0>p'\)" = "\$MIGRATION"/);
  assert.ok(fs.existsSync(new URL("../migrations/0022_stable_claim_diagnostics.sql",import.meta.url)));
  assert.match(workflow,/P0 flag must stay absent/);
  assert.doesNotMatch(workflow,/--var\b|--vars\b|wrangler secret|STABLE_RECOVERY_GATE_ENABLED[=:]\s*["']?true/);
});

test("PR247 release pauses delivery before the D1 export, then migrates, deploys and resumes",()=>{
  const order=[at("npm run check"),at("queues pause-delivery malipang-jobs"),at("npx wrangler d1 export malipang-v5-2 --remote"),at("test \"$(sha256sum"),at("PRAGMA integrity_check"),at("npx wrangler d1 migrations apply malipang-v5-2 --remote"),at("touch \"$RUNNER_TEMP/deploy-started\"\n          npx wrangler deploy\n"),at("queues resume-delivery malipang-jobs\n          rm -f")];
  assert.deepEqual([...order].sort((a,b)=>a-b),order);
});

test("PR247 release keeps the REVIEW claim and proves no Sheets write or new failure happened",()=>{
  assert.match(workflow,/\.results\[0\]\.review == 1 and \.\[0\]\.results\[0\]\.held == 0 and \.\[0\]\.results\[0\]\.in_flight == 0'/);
  assert.match(workflow,/\.claim\.state == "REVIEW" and \.recoveryGate\.mode == "DISABLED" and \.sheetPacing\.mode == "DISABLED"/);
  assert.match(workflow,/\.completed == \$c and \.\[0\]\.results\[0\]\.open_failed <= \$f/);
});

test("PR247 release never changes a claim, epoch, business row, queue message or Sheet",()=>{
  assert.doesNotMatch(workflow,/(DELETE FROM|UPDATE|INSERT INTO)\s+(stable_workbook_claims|stable_recovery_epochs|stable_recovery_operations|sync_jobs|stable_projection_writes|expense_events|failed_jobs|staff_config_sync_outbox)/i);
  assert.doesNotMatch(workflow,/retry-sync|bootstrap-sheets|staff-import|shift-import|reconcile-sheets|resume-capacity|includeTerminalDlq|queues purge|sheets\.googleapis/);
});

test("PR247 release restores delivery when it fails before deployment",()=>{
  assert.match(workflow,/if: failure\(\)/);
  assert.match(workflow,/if \[ -f "\$RUNNER_TEMP\/delivery-paused" \] && \[ ! -f "\$RUNNER_TEMP\/deploy-started" \]; then\n\s+# [^\n]*\n\s+# [^\n]*\n\s+npx wrangler queues resume-delivery malipang-jobs/);
});
