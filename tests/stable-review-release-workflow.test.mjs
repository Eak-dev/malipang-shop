import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const workflow=fs.readFileSync(new URL("../.github/workflows/production-stable-review-diagnostics.yml",import.meta.url),"utf8");
const at=(text)=>{const index=workflow.indexOf(text);assert.notEqual(index,-1,`missing: ${text}`);return index;};

test("stable review release runs only on manual dispatch with an exact typed confirmation",()=>{
  assert.match(workflow,/^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow,/^\s+(push|pull_request|schedule):/m);
  assert.match(workflow,/test "\$CONFIRMATION" = 'RELEASE e3b7ab8 MIGRATION 0022 KEEP REVIEW CLAIM'/);
  assert.match(workflow,/environment: production/);
  assert.match(workflow,/group: malipang-release-control/);
});

test("stable review release deploys only the reviewed runtime source and migration",()=>{
  assert.match(workflow,/REVIEWED_SOURCE_SHA: e3b7ab88722387a67968631907ddf02abb8fc708/);
  assert.match(workflow,/git diff --quiet "\$REVIEWED_SOURCE_SHA" HEAD -- src migrations wrangler\.jsonc package\.json package-lock\.json tsconfig\.json/);
  assert.match(workflow,/MIGRATION: 0022_stable_claim_diagnostics\.sql/);
  assert.ok(fs.existsSync(new URL("../migrations/0022_stable_claim_diagnostics.sql",import.meta.url)));
});

test("stable review release backs up, pauses, migrates, deploys and resumes in order",()=>{
  const order=[at("npm run check"),at("npx wrangler d1 export malipang-v5-2 --remote"),at("test \"$(sha256sum"),at("PRAGMA integrity_check"),at("queues pause-delivery malipang-jobs"),at("npx wrangler d1 migrations apply malipang-v5-2 --remote"),at("touch \"$RUNNER_TEMP/deploy-started\"\n          npx wrangler deploy\n"),at("queues resume-delivery malipang-jobs\n          rm -f")];
  assert.deepEqual([...order].sort((a,b)=>a-b),order);
});

test("stable review release never changes a workbook claim or runs unrelated production operations",()=>{
  assert.doesNotMatch(workflow,/(DELETE FROM|UPDATE|INSERT INTO)\s+stable_workbook_claims/i);
  assert.doesNotMatch(workflow,/(DELETE FROM|UPDATE|INSERT INTO)\s+(sync_jobs|stable_projection_writes|expense_events|failed_jobs)/i);
  assert.doesNotMatch(workflow,/bootstrap-sheets|staff-import|shift-import|retry-sync|reconcile-sheets|resume-capacity/);
});

test("stable review release restores LINE intake when it fails before deployment",()=>{
  assert.match(workflow,/if: failure\(\)/);
  assert.match(workflow,/if \[ -f "\$RUNNER_TEMP\/delivery-paused" \] && \[ ! -f "\$RUNNER_TEMP\/deploy-started" \]; then\n\s+# [^\n]*\n\s+# [^\n]*\n\s+npx wrangler queues resume-delivery malipang-jobs/);
});
