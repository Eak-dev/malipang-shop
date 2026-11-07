import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const workflow = fs.readFileSync(
  new URL("../.github/workflows/production-pr247-flags-off-release.yml", import.meta.url),
  "utf8",
);
const docs = fs.readFileSync(
  new URL("../docs/RELEASE_PR247_FLAGS_OFF_TH.md", import.meta.url),
  "utf8",
);

const at = (text) => {
  const index = workflow.indexOf(text);
  assert.notEqual(index, -1, "missing: " + text);
  return index;
};
const section = (start, end) => workflow.slice(at(start), at(end));

test("manual-only release and explicit confirmation", () => {
  assert.match(workflow, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request|schedule|workflow_run):/m);
  assert.match(workflow, /test "\$CONFIRMATION" = 'RELEASE PR247 4bb84a4 MIGRATION 0023 FLAGS OFF KEEP REVIEW'/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /group: malipang-release-control/);
});

test("reviewed exact runtime source and exact main SHA are enforced", () => {
  assert.match(workflow, /REVIEWED_SOURCE_SHA: 4bb84a4869920f70981477de0ef69607438e2c74/);
  assert.match(workflow, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/);
  assert.match(workflow, /test "\$\(git ls-remote origin refs\/heads\/main \| cut -f1\)" = "\$EXPECTED_SHA"/);
  assert.match(workflow, /test "\$\(git rev-parse refs\/review\/pr247\)" = "\$REVIEWED_SOURCE_SHA"/);
  assert.match(workflow, /git diff --quiet "\$REVIEWED_SOURCE_SHA" HEAD -- src migrations wrangler\.jsonc package\.json package-lock\.json tsconfig\.json/);
  assert.doesNotMatch(workflow, /EXPECTED_SHA: [0-9a-f]{40}/);
});

test("only additive migration 0023 after 0022; P0 flags remain absent", () => {
  assert.match(workflow, /PRIOR_MIGRATION: 0022_stable_claim_diagnostics\.sql/);
  assert.match(workflow, /MIGRATION: 0023_stable_recovery_admission\.sql/);
  assert.match(workflow, /test "\$\(ls migrations \| awk -v p="\$PRIOR_MIGRATION" '\$0>p'\)" = "\$MIGRATION"/);
  assert.ok(fs.existsSync(new URL("../migrations/0022_stable_claim_diagnostics.sql", import.meta.url)));
  assert.match(workflow, /P0 flag must stay absent/);
  assert.doesNotMatch(workflow, /--var\b|--vars\b|wrangler secret|STABLE_RECOVERY_GATE_ENABLED[=:]\s*["']?true/);
});

test("order remains pause → drain → private backup → 0023 → deploy → verify → resume", () => {
  const order = [
    at("npm run check"),
    at("queues pause-delivery malipang-jobs"),
    at("npx wrangler d1 export malipang-v5-2 --remote"),
    at("test \"$(sha256sum"),
    at("PRAGMA integrity_check"),
    at("npx wrangler d1 migrations apply malipang-v5-2 --remote"),
    at("npx wrangler deploy\n"),
    at("queues resume-delivery malipang-jobs"),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test("retains existing REVIEW and verifies financial outbox was not released", () => {
  assert.match(workflow, /\.results\[0\]\.review == 1 and \.\[0\]\.results\[0\]\.held == 0 and \.\[0\]\.results\[0\]\.in_flight == 0/);
  assert.match(workflow, /\.claim\.state == "REVIEW" and \.recoveryGate\.mode == "DISABLED" and \.sheetPacing\.mode == "DISABLED"/);
  assert.match(workflow, /\.completed == \$c and \.\[0\]\.results\[0\]\.open_failed <= \$f/);
});

test("cannot edit REVIEW/epochs/business rows or replay DLQ from this workflow", () => {
  assert.doesNotMatch(workflow, /(DELETE FROM|UPDATE|INSERT INTO)\s+(stable_workbook_claims|stable_recovery_epochs|stable_recovery_operations|sync_jobs|stable_projection_writes|expense_events|failed_jobs|staff_config_sync_outbox)/i);
  assert.doesNotMatch(workflow, /retry-sync|bootstrap-sheets|staff-import|shift-import|reconcile-sheets|resume-capacity|includeTerminalDlq|queues purge|sheets\.googleapis/);
});

test("hard-fails BEFORE pause unless Cron triggers are externally fenced by separate Owner approval", () => {
  const prior = workflow.slice(0, at("queues pause-delivery malipang-jobs"));
  assert.match(prior, /workers\/scripts\/malipang-backend-v5-2\/schedules/);
  assert.match(prior, /schedules \| length/);
  assert.match(prior, /CRON_FENCE_NOT_VERIFIED/);
  assert.match(docs, /แยกต่างหาก|separate Owner/);
  assert.match(docs, /Cron/);
});

test("must prove queue was active before taking ownership, and retain durable pause intent", () => {
  const prior = workflow.slice(0, at("queues pause-delivery malipang-jobs"));
  assert.match(prior, /cf_get "\/accounts\/\$CLOUDFLARE_ACCOUNT_ID\/queues"/);
  assert.match(prior, /delivery_paused == false/);
  assert.match(prior, /release-control\/pr247/);
  assert.match(prior, /PAUSE_INTENT/);
  assert.match(prior, /r2 object put/);
  assert.match(workflow, /PAUSE_CONFIRMED/);
});

test("drain explicitly checks in-flight LINE events and other known D1 writers", () => {
  const step = section("Pause delivery and wait for active writers", "Fresh private backup and restored migration validation");
  assert.match(step, /inbound_events/);
  assert.match(step, /stable_workbook_claims/);
  assert.match(step, /staff_config_sync_outbox/);
  assert.match(step, /CONSECUTIVE_QUIET_CHECKS/);
});

test("export revalidates both paused queue and disabled Cron immediately before D1 export", () => {
  const step = section("Fresh private backup and restored migration validation", "Apply only additive migration 0023");
  assert.match(step, /CRON_FENCE_LOST/);
  assert.match(step, /QUEUE_FENCE_LOST/);
  assert.ok(step.indexOf("CRON_FENCE_LOST") < step.indexOf("npx wrangler d1 export malipang-v5-2 --remote"));
});

test("records pinned old Worker and verifies new deployment version", () => {
  assert.match(workflow, /PRIOR_WORKER_VERSION/);
  assert.match(workflow, /WORKER_VERSION_UNVERIFIED/);
  assert.match(workflow, /workers\/scripts\/malipang-backend-v5-2\/deployments/);
  assert.match(docs, /310192aa|Worker Version/);
});

test("does not clear durable intent before post-resume verification", () => {
  const step = section("Resume delivery and prove the release is inert", "Failure handling");
  assert.match(step, /RESUME_REQUESTED/);
  assert.match(step, /RESUMED_VERIFIED/);
  assert.match(step, /POSTCHECK_FAILED/);
  assert.ok(step.indexOf("RESUME_REQUESTED") < step.indexOf("POSTCHECK_FAILED"));
  assert.doesNotMatch(step, /rm -f "\$RUNNER_TEMP\/delivery-paused"/);
});

test("failure and cancellation handler is invoked but does NOT claim guaranteed cleanup after runner death", () => {
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /MANUAL_CONTAINMENT_REQUIRED/);
  assert.match(docs, /Timeout|timeout/i);
  assert.match(docs, /Cancel|cancel/i);
  assert.match(docs, /runner|Runner/i);
  assert.doesNotMatch(docs, /ยืนยัน.*100%.*resume/i);
});


test("a failing health/readback after confirmed resume triggers bounded re-pause rather than a silent log", () => {
  const cleanup = workflow.slice(at("Failure handling"));
  assert.match(cleanup, /if \[ "\$state" = RESUMED_VERIFIED \]/);
  assert.match(cleanup, /queues pause-delivery malipang-jobs/);
  assert.match(cleanup, /\.state="POSTCHECK_FAILED"/);
  assert.match(cleanup, /queue-final-containment\.json/);
  assert.match(cleanup, /MANUAL_CONTAINMENT_REQUIRED/);
});

test("all embedded workflow shell steps pass Bash syntax validation", () => {
  const lines = workflow.split(/\r?\n/);
  const scripts = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "        run: |") continue;
    const block = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.startsWith("          ") && line.trim() !== "") break;
      block.push(line.startsWith("          ") ? line.slice(10) : "");
    }
    scripts.push(block.join("\n") + "\n");
  }
  assert.ok(scripts.length >= 9, "workflow must retain all guarded stages");
  for (const [i, script] of scripts.entries()) {
    const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert.equal(result.status, 0, "Bash syntax invalid in stage " + (i + 1) + ": " + result.stderr);
  }
});

test("negative scenarios documented instead of assumed PASS", () => {
  assert.match(docs, /lost ACK|ACK loss/i);
  assert.match(docs, /external writer|external admin/i);
  assert.match(docs, /post-resume/i);
  assert.match(docs, /NO-GO/);
});
