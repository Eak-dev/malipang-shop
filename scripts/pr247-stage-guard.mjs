// Issue #248 / local preparation only. Pure snapshot validator: no network or mutations.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const REVIEW_STAMP = "2026-11-05 21:26:00";
export const G5_PREVIOUS_WORKER = "310192aa-8a04-4b61-8a72-4455231b3339";
export const MIGRATION = "0023_stable_recovery_admission.sql";
const activeStates = ["ARMED", "REVIEW"];
const completedStates = ["COMPLETE", "CLOSED"];

function guard(condition, name) {
  if (!condition) throw new Error("NO_GO_" + name);
}
function integer(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function val(x, key) { return x && typeof x === "object" ? x[key] : undefined; }
function same(a, b) { return typeof a === "string" && a.length > 0 && a === b; }

export function verifyStage(mode, evidence) {
  guard(["A_PRE", "A_POST", "B_PRE", "B_POST"].includes(mode), "UNKNOWN_MODE");
  const e = evidence ?? {};
  const release = e.g5;
  const cf = e.cloudflare ?? {};
  const d1 = e.d1 ?? {};
  const status = e.status ?? {};
  const params = e.params ?? {};
  const isA = mode.startsWith("A_");
  const isPost = mode.endsWith("_POST");

  guard(release?.release === "PR247" && release.state === "VERIFIED_COMPLETED", "G5_RECEIPT");
  guard(/^[0-9a-f]{40}$/.test(release?.expected_sha ?? ""), "G5_SHA");
  guard(release?.queue_was_active === true && !!release?.queue_id, "G5_QUEUE");
  guard(same(release?.prior_worker_version, G5_PREVIOUS_WORKER), "G5_PREVIOUS_WORKER");
  guard(same(release?.expected_sha, params?.g5Sha), "G5_PROVENANCE");

  guard(Array.isArray(cf.cron) && cf.cron.length === 1 &&
    cf.cron[0]?.cron === "*/5 * * * *", "CRON");
  guard(cf.queue?.queue_name === "malipang-jobs" &&
    cf.queue?.settings?.delivery_paused === false, "QUEUE_ACTIVE");
  guard(same(cf.queue?.queue_id, release?.queue_id), "QUEUE_OWNERSHIP");
  guard(Array.isArray(cf.versions) && cf.versions.length === 1 &&
    cf.versions[0]?.percentage === 100, "WORKER_ONE_AT_100");
  guard(same(cf.versions[0].version_id, params?.expectedWorkerVersion), "WORKER_VERSION");

  guard(d1.migration === MIGRATION && d1.recovery_tables === 4, "MIGRATION_0023");
  for (const name of ["review", "review_all", "held", "inflight", "epoch_total",
    "epoch_active", "epoch_complete", "unverified_ops", "verified_ops",
    "completed", "open_failed", "canary_jobs_completed",
    "canary_daily", "canary_raw", "canary_detail"]) {
    guard(integer(d1[name]), "D1_NUMERIC_" + name.toUpperCase());
  }
  guard(d1.review_all === d1.review, "REVIEW_STAMP_DRIFT");
  guard(d1.held === 0 && d1.inflight === 0, "UNSAFE_WRITER");
  guard(status?.ok === true, "ADMIN_DIAGNOSTIC_UNAVAILABLE");
  guard(integer(status.inFlightProjections) && status.inFlightProjections === 0, "STATUS_INFLIGHT");

  if (isA) {
    guard(d1.review === 1 && status?.claim?.state === "REVIEW" &&
      status?.claim?.notice_stamp === REVIEW_STAMP, "REVIEW_IDENTITY");
    guard(d1.epoch_total === 0 && d1.epoch_active === 0 &&
      d1.epoch_complete === 0 && d1.unverified_ops === 0 &&
      d1.verified_ops === 0, "UNEXPECTED_EPOCH");
    if (!isPost) {
      guard(status?.recoveryGate?.mode === "DISABLED" &&
        status?.sheetPacing?.mode === "DISABLED", "G5_FLAGS_NOT_OFF");
    } else {
      guard(status?.recoveryGate?.mode === "UNARMED" &&
        status?.sheetPacing?.mode === "UNARMED", "G6A_FLAGS_NOT_ACTIVE");
      guard(cf.versions[0].version_id !== params?.priorWorkerVersion, "G6A_WORKER_NOT_CHANGED");
      guard(d1.completed === params?.completedBefore, "G6A_UNEXPECTED_COMPLETION");
      guard(d1.open_failed <= params?.openFailedBefore, "G6A_NEW_FAILURE");
    }
  } else {
    guard(d1.review === 0 && status?.claim == null, "REVIEW_NOT_RELEASED");
    guard(d1.epoch_total === 1 && d1.epoch_active === 0 &&
      d1.epoch_complete === 1 && d1.unverified_ops === 0 &&
      d1.verified_ops >= 2, "CANARY_EPOCH_INCOMPLETE");
    guard(d1.canary_jobs_completed === 1 && d1.canary_daily === 1 &&
      d1.canary_raw === 1 && d1.canary_detail >= 1, "CANARY_JOURNAL");
    guard(e.receipt?.state === "OWNER_VERIFIED" &&
      e.receipt?.g7_canary_verified === true &&
      e.receipt?.provider_readback_verified === true &&
      e.receipt?.no_duplicate_stable_ids === true &&
      e.receipt?.no_new_429_observed === true &&
      e.receipt?.owner_approved_g8 === true, "G7_OWNER_RECEIPT");
    if (!isPost) {
      guard(status?.recoveryGate?.mode === "OPT_IN" &&
        completedStates.includes(status?.recoveryGate?.state) &&
        ["OPT_IN", "UNARMED"].includes(status?.sheetPacing?.mode),
        "G6A_GATE_STATE");
    } else {
      guard(status?.recoveryGate?.mode === "DISABLED" &&
        ["OPT_IN", "UNARMED"].includes(status?.sheetPacing?.mode),
        "STEADY_MODE_NOT_ACTIVE");
      guard(cf.versions[0].version_id !== params?.priorWorkerVersion, "STEADY_WORKER_NOT_CHANGED");
      guard(d1.open_failed <= params?.openFailedBefore, "STEADY_NEW_FAILURE");
    }
  }
  return { ok: true, mode };
}

// CLI: node scripts/pr247-stage-guard.mjs A_PRE|A_POST|B_PRE|B_POST snapshot.json
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, file] = process.argv.slice(2);
  try {
    const evidence = JSON.parse(readFileSync(file, "utf8"));
    verifyStage(mode, evidence);
    console.log("STAGE_GUARD_" + mode + "_PASS");
  } catch (error) {
    console.error(error instanceof Error && error.message.startsWith("NO_GO_") ?
      error.message : "NO_GO_UNVERIFIED_EVIDENCE");
    process.exitCode = 1;
  }
}
