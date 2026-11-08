import test from "node:test";
import assert from "node:assert/strict";
import { verifyStage, REVIEW_STAMP, G5_PREVIOUS_WORKER, MIGRATION } from "../scripts/pr247-stage-guard.mjs";

const G5_SHA = "0d1dda77f3a0e5cfaec1872cb588b59dddfe5bdf";
const G5_WORKER = "reviewed-g5-version-placeholder"; // synthetic fixture only
const NEW_WORKER = "synthetic-new-version";

function fixture(mode) {
  const post = mode.endsWith("_POST");
  const isA = mode.startsWith("A_");
  const worker = post ? NEW_WORKER : G5_WORKER;
  const base = {
    g5: {
      release: "PR247",
      state: "VERIFIED_COMPLETED",
      expected_sha: G5_SHA,
      prior_worker_version: G5_PREVIOUS_WORKER,
      queue_was_active: true,
      queue_id: "synthetic-queue-id"
    },
    params: {
      g5Sha: G5_SHA,
      expectedWorkerVersion: worker,
      priorWorkerVersion: G5_WORKER,
      completedBefore: 3296,
      openFailedBefore: 32
    },
    cloudflare: {
      cron: [{ cron: "*/5 * * * *" }],
      versions: [{ version_id: worker, percentage: 100 }],
      queue: { queue_name: "malipang-jobs", queue_id: "synthetic-queue-id", settings: { delivery_paused: false } }
    },
    d1: {
      migration: MIGRATION, recovery_tables: 4,
      review: isA ? 1 : 0, review_all: isA ? 1 : 0, held: 0, inflight: 0,
      epoch_total: isA ? 0 : 1, epoch_active: 0, epoch_complete: isA ? 0 : 1,
      unverified_ops: 0, verified_ops: isA ? 0 : 3,
      completed: 3296, open_failed: 32,
      canary_jobs_completed: isA ? 0 : 1, canary_daily: isA ? 0 : 1,
      canary_raw: isA ? 0 : 1, canary_detail: isA ? 0 : 1
    },
    status: {
      ok: true,
      inFlightProjections: 0,
      claim: isA ? { state: "REVIEW", notice_stamp: REVIEW_STAMP } : null,
      recoveryGate: { mode: isA ? (post ? "UNARMED" : "DISABLED") : (post ? "DISABLED" : "OPT_IN"),
        ...(!isA && !post ? { state: "COMPLETE" } : {}) },
      sheetPacing: { mode: isA ? (post ? "UNARMED" : "DISABLED") : "OPT_IN" }
    },
    receipt: isA ? null : {
      state: "OWNER_VERIFIED", g7_canary_verified: true,
      provider_readback_verified: true, no_duplicate_stable_ids: true,
      no_new_429_observed: true, owner_approved_g8: true
    }
  };
  return structuredClone(base);
}
for (const mode of ["A_PRE", "A_POST", "B_PRE", "B_POST"]) {
  test("positive synthetic " + mode, () => assert.deepEqual(verifyStage(mode, fixture(mode)), {ok:true,mode}));
}
const cases = [
  ["A_PRE", "G5 receipt is not verified", e => { e.g5.state = "PAUSE_INTENT"; }, "G5_RECEIPT"],
  ["A_PRE", "G5 SHA mismatch", e => { e.params.g5Sha = "drift"; }, "G5_PROVENANCE"],
  ["A_PRE", "unexpected original Worker", e => { e.g5.prior_worker_version = "wrong"; }, "G5_PREVIOUS_WORKER"],
  ["A_PRE", "Queue ownership mismatch", e => { e.g5.queue_id = "other"; }, "QUEUE_OWNERSHIP"],
  ["A_PRE", "Queue paused", e => { e.cloudflare.queue.settings.delivery_paused = true; }, "QUEUE_ACTIVE"],
  ["A_PRE", "Cron disabled", e => { e.cloudflare.cron = []; }, "CRON"],
  ["A_PRE", "mixed Worker versions", e => { e.cloudflare.versions.push({version_id:"other",percentage:0}); }, "WORKER_ONE_AT_100"],
  ["A_PRE", "Worker version drift", e => { e.cloudflare.versions[0].version_id = "other"; }, "WORKER_VERSION"],
  ["A_PRE", "Migration 0022 not 0023", e => { e.d1.migration = "0022_stable_claim_diagnostics.sql"; }, "MIGRATION_0023"],
  ["A_PRE", "missing a recovery table", e => { e.d1.recovery_tables = 3; }, "MIGRATION_0023"],
  ["A_PRE", "missing REVIEW", e => { e.d1.review=0; e.d1.review_all=0; }, "REVIEW_IDENTITY"],
  ["A_PRE", "wrong incident stamp", e => { e.status.claim.notice_stamp = "changed"; }, "REVIEW_IDENTITY"],
  ["A_PRE", "extra REVIEW", e => { e.d1.review_all=2; }, "REVIEW_STAMP_DRIFT"],
  ["A_PRE", "active HELD", e => { e.d1.held=1; }, "UNSAFE_WRITER"],
  ["A_PRE", "active IN_FLIGHT", e => { e.d1.inflight=1; }, "UNSAFE_WRITER"],
  ["A_PRE", "unexpected ARMED epoch", e => { e.d1.epoch_total=1; e.d1.epoch_active=1; }, "UNEXPECTED_EPOCH"],
  ["A_PRE", "recovery gate prematurely ON", e => { e.status.recoveryGate.mode = "OPT_IN"; }, "G5_FLAGS_NOT_OFF"],
  ["A_POST", "gate deploy not confirmed", e => { e.status.recoveryGate.mode="UNAVAILABLE"; }, "G6A_FLAGS_NOT_ACTIVE"],
  ["A_POST", "same Worker after deploy", e => { e.params.priorWorkerVersion=NEW_WORKER; }, "G6A_WORKER_NOT_CHANGED"],
  ["A_POST", "unexpected finance completion", e => { e.d1.completed=3297; }, "G6A_UNEXPECTED_COMPLETION"],
  ["A_POST", "new failed job", e => { e.d1.open_failed=33; }, "G6A_NEW_FAILURE"],
  ["B_PRE", "no owner provider receipt", e => { e.receipt=null; }, "G7_OWNER_RECEIPT"],
  ["B_PRE", "owner has not authorized G8", e => { e.receipt.owner_approved_g8=false; }, "G7_OWNER_RECEIPT"],
  ["B_PRE", "unclosed ARMED epoch", e => { e.d1.epoch_active=1; }, "CANARY_EPOCH_INCOMPLETE"],
  ["B_PRE", "uncertain recovery operation", e => { e.d1.unverified_ops=1; }, "CANARY_EPOCH_INCOMPLETE"],
  ["B_PRE", "canary job incomplete", e => { e.d1.canary_jobs_completed=0; }, "CANARY_JOURNAL"],
  ["B_PRE", "missing DAILY journal", e => { e.d1.canary_daily=0; }, "CANARY_JOURNAL"],
  ["B_PRE", "missing RAW journal", e => { e.d1.canary_raw=0; }, "CANARY_JOURNAL"],
  ["B_PRE", "missing DETAIL journal", e => { e.d1.canary_detail=0; }, "CANARY_JOURNAL"],
  ["B_PRE", "new REVIEW still present", e => { e.d1.review=1; e.d1.review_all=1; }, "REVIEW_NOT_RELEASED"],
  ["B_PRE", "gate was already OFF", e => { e.status.recoveryGate.mode="DISABLED"; }, "G6A_GATE_STATE"],
  ["B_POST", "gate still ON", e => { e.status.recoveryGate.mode="OPT_IN"; }, "STEADY_MODE_NOT_ACTIVE"],
  ["B_POST", "new failure after gate exit", e => { e.d1.open_failed=33; }, "STEADY_NEW_FAILURE"],
];
for (const [mode, label, mutate, code] of cases) {
  test("reject " + label, () => {
    const e=fixture(mode);
    mutate(e);
    assert.throws(() => verifyStage(mode, e), new RegExp("NO_GO_" + code));
  });
}
test("reject malformed/untrusted numeric values", () => {
  const e=fixture("A_PRE");
  e.d1.completed="3296";
  assert.throws(() => verifyStage("A_PRE", e), /NO_GO_D1_NUMERIC_COMPLETED/);
});
test("reject unknown mode", () => {
  assert.throws(() => verifyStage("ABORT", fixture("A_PRE")), /NO_GO_UNKNOWN_MODE/);
});
