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

// Explicit V2 risk exception: unknown is recorded as null, never as measured zero.
// Attested limited observations are NOT full Google provider coverage.
function receiptMonitoring(r,epoch,nowMs=Date.now()) {
  if(r?.schema === "MP248_G7_RECEIPT_V1") return r.no_new_429_observed === true && r.gcp_quotas_checked === true && r.gcp_429_delta === 0;
  if(!["MP248_G7_RECEIPT_V2_RISK_ACCEPTED", "MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED"].includes(r?.schema) ||
     r.monitoring_coverage !== "PARTIAL_PROJECT_UNBOUND" ||
     r.monitoring_project !== "malipang-backend" ||
     r.gcp_quotas_checked !== false || r.gcp_429_delta !== null ||
     r.gcp_ingestion_lag_ms !== null || r.no_new_429_observed !== undefined ||
     r.owner_accepted_429_observability_risk !== true ||
     r.limited_observed_429 !== false ||
     r.observation_source !== "GCP_UI_UNBOUND_AND_WORKER_LOGS_PARTIAL") return false;
  const fields=[r.monitoring_window_start,r.canary_started_at,r.canary_completed_at,r.monitoring_window_end,r.observed_at];
  const times=fields.map(x=>{if(typeof x!=="string"||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x))return NaN;const n=Date.parse(x);return Number.isFinite(n)&&new Date(n).toISOString()===x?n:NaN});
  const utc=x=>typeof x==="string"&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString()===x?Date.parse(x):NaN;
  const epochStart=utc(epoch?.epoch_created_at),epochEnd=utc(epoch?.epoch_updated_at);
  return times.every(Number.isFinite) && times.every((x,i)=>i===0||x>=times[i-1]) && times[0]<times[3] && times[4]<=nowMs && Number.isFinite(epochStart) && Number.isFinite(epochEnd) && times[1]<=epochStart && epochStart<=epochEnd && epochEnd<=times[2];
}

export function verifyStage(mode, evidence) {
  guard(["A_PRE", "A_POST", "B_PRE", "B_POST"].includes(mode), "UNKNOWN_MODE");
  const e = evidence ?? {};
  const release = e.g5;
  const cf = e.cloudflare ?? {};
  const d1 = e.d1 ?? {};
  const status = e.status ?? {};
  const epoch = e.epoch ?? {};
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
    "completed", "open_failed", "stale_held", "unleased_inflight", "canary_jobs_completed",
    "canary_daily", "canary_raw", "canary_detail"]) {
    guard(integer(d1[name]), "D1_NUMERIC_" + name.toUpperCase());
  }
  guard(d1.review_all === d1.review, "REVIEW_STAMP_DRIFT");
  guard(status?.ok === true, "ADMIN_DIAGNOSTIC_UNAVAILABLE");
  if (mode === "B_POST") {
    // A normal paced writer may temporarily hold exactly one claim and one journal.
    // There is NO claim lease column; stale_held uses a conservative age check.
    // A projection is only accepted as active if its source job has an unexpired lease.
    guard(d1.held <= 1 && d1.inflight <= 1 &&
      d1.stale_held === 0 && d1.unleased_inflight === 0, "STALE_WRITER_AFTER_GATE_EXIT");
    // The D1 query and admin GET are separate instants. A healthy new stage can
    // change IN_FLIGHT 0->1 or 1->0 between requests. Both must independently
    // respect the global single-writer bound, not have identical snapshots.
    guard(integer(status.inFlightProjections) &&
      status.inFlightProjections <= 1, "STATUS_INFLIGHT_DRIFT");
  } else {
    guard(d1.held === 0 && d1.inflight === 0, "UNSAFE_WRITER");
    guard(integer(status.inFlightProjections) &&
      status.inFlightProjections === 0, "STATUS_INFLIGHT");
  }

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
    // An ambiguous REVIEW sync job can exist without a workbook REVIEW claim.
    // Missing evidence is UNKNOWN and must stop both G8 admission and observation.
    guard(integer(d1.review_jobs) && d1.review_jobs === 0, "SYNC_JOBS_REVIEW");
    guard(d1.review === 0 && (mode === "B_POST"
      ? (status?.claim == null || status?.claim?.state === "HELD")
      : status?.claim == null), "REVIEW_NOT_RELEASED");
    guard(d1.epoch_total === 1 && d1.epoch_active === 0 &&
      d1.epoch_complete === 1 && d1.unverified_ops === 0 &&
      d1.verified_ops >= 2, "CANARY_EPOCH_INCOMPLETE");
    const zeroItem = e.receipt?.schema === "MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED";
    guard(epoch.epoch_found === 1 &&
      ["COMPLETE", "CLOSED"].includes(epoch.epoch_state) &&
      epoch.unverified_ops === 0 && integer(epoch.verified_ops) &&
      epoch.job_completed === 1 && epoch.daily === 1 && epoch.raw === 1 &&
      integer(epoch.detail) && (zeroItem ? epoch.detail === 0 &&
        epoch.source_matches === 1 && integer(epoch.source_revision) &&
        integer(e.receipt?.source_revision) && epoch.source_revision === e.receipt.source_revision &&
        typeof e.receipt?.source_snapshot_digest === "string" && e.receipt.source_snapshot_digest.length === 64 &&
        /^[a-f0-9]{64}$/.test(e.receipt.source_snapshot_digest) &&
        epoch.cutover_active === 1 && epoch.pre_cutover_count === 0 && epoch.integrity_triggers === 27 &&
        epoch.epoch_immutability_triggers === 2 && epoch.epoch_active_unique === 1 &&
        epoch.source_item_count === 0 && epoch.source_document_count === 0 && epoch.source_link_count === 0 &&
        epoch.journal_total === 2 && epoch.detail_any === 0 : epoch.detail >= 1), "CANARY_JOURNAL");
    guard(receiptMonitoring(e.receipt,epoch) &&
      e.receipt?.state === "OWNER_VERIFIED" &&
      e.receipt?.g7_canary_verified === true &&
      e.receipt?.provider_readback_verified === true &&
      e.receipt?.no_duplicate_stable_ids === true &&
      same(e.receipt?.g5_sha, params.g5Sha) &&
      same(e.receipt?.g6a_worker_version, params.priorWorkerVersion) &&
      typeof e.receipt?.epoch_id === "string" &&
      /^[A-Za-z0-9_-]{8,128}$/.test(e.receipt.epoch_id) &&
      integer(e.receipt?.expected_detail_count) &&
      (zeroItem ? e.receipt.expected_detail_count === 0 &&
        e.receipt.detail_coverage === "NOT_EXERCISED_ZERO_ITEMS" &&
        e.receipt.owner_accepted_detail_coverage_risk === true &&
        e.receipt.no_detail_rows_verified === true : e.receipt.expected_detail_count >= 1) &&
      e.receipt.expected_detail_count === epoch.detail &&
      epoch.verified_ops >= epoch.detail + 2 &&
      e.receipt?.owner_approved_g8 === true, "G7_OWNER_RECEIPT");
    if (!isPost) {
      guard(status?.recoveryGate?.mode === "OPT_IN" &&
        completedStates.includes(status?.recoveryGate?.state) &&
        status?.sheetPacing?.mode === "OPT_IN",
        "G6A_GATE_STATE");
    } else {
      guard(status?.recoveryGate?.mode === "DISABLED" &&
        status?.sheetPacing?.mode === "OPT_IN",
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
    if(mode.startsWith("B_") && ["MP248_G7_RECEIPT_V2_RISK_ACCEPTED", "MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED"].includes(evidence.receipt?.schema))
      console.log("MONITORING_PARTIAL_OWNER_RISK_ACCEPTED_NOT_429_ZERO");
    if(mode.startsWith("B_") && evidence.receipt?.schema === "MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED")
      console.log("ZERO_ITEM_OWNER_RISK_ACCEPTED_DETAIL_NOT_EXERCISED");
    console.log("STAGE_GUARD_" + mode + "_PASS");
  } catch (error) {
    console.error(error instanceof Error && error.message.startsWith("NO_GO_") ?
      error.message : "NO_GO_UNVERIFIED_EVIDENCE");
    process.exitCode = 1;
  }
}
