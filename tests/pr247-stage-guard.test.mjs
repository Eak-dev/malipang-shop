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
      completed: 3296, open_failed: 32, stale_held: 0, unleased_inflight: 0,
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
    epoch: isA ? null : {epoch_found: 1, epoch_state: "COMPLETE", unverified_ops: 0, verified_ops: 3, job_completed: 1, daily: 1, raw: 1, detail: 1},
    receipt: isA ? null : {
      state: "OWNER_VERIFIED", g7_canary_verified: true,
      provider_readback_verified: true, no_duplicate_stable_ids: true,
      no_new_429_observed: true, owner_approved_g8: true,
      schema: "MP248_G7_RECEIPT_V1", epoch_id: "syntheticEpoch01",
      expected_detail_count: 1, gcp_quotas_checked: true, gcp_429_delta: 0,
      g5_sha: G5_SHA, g6a_worker_version: G5_WORKER
    }
  };
  return structuredClone(base);
}
for (const mode of ["A_PRE", "A_POST", "B_PRE", "B_POST"]) {
  test("positive synthetic " + mode, () => assert.deepEqual(verifyStage(mode, fixture(mode)), {ok:true,mode}));
}
for(const mode of ['B_PRE','B_POST'])test(mode+' rejects missing queue delivery_paused, never treats it as false',()=>{
 const e=fixture(mode);delete e.cloudflare.queue.settings.delivery_paused;
 assert.throws(()=>verifyStage(mode,e),/NO_GO_QUEUE_ACTIVE/);
});
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
  ["B_PRE", "foreign canary epoch", e => { e.epoch.epoch_found=0; }, "CANARY_JOURNAL"],
  ["B_PRE", "canary epoch still ARMED", e => { e.epoch.epoch_state="ARMED"; }, "CANARY_JOURNAL"],
  ["B_PRE", "unverified exact canary op", e => { e.epoch.unverified_ops=1; }, "CANARY_JOURNAL"],
  ["B_PRE", "missing exact provider journal stages", e => { e.epoch.verified_ops=1; }, "G7_OWNER_RECEIPT"],
  ["B_PRE", "no owner provider receipt", e => { e.receipt=null; }, "G7_OWNER_RECEIPT"],
  ["B_PRE", "owner has not authorized G8", e => { e.receipt.owner_approved_g8=false; }, "G7_OWNER_RECEIPT"],
  ["B_PRE", "GCP metrics missing", e => { e.receipt.gcp_quotas_checked=false; }, "G7_OWNER_RECEIPT"],
  ["B_PRE", "GCP 429 observed", e => { e.receipt.gcp_429_delta=1; }, "G7_OWNER_RECEIPT"],
  ["B_PRE", "G7 SHA provenance mismatch", e => { e.receipt.g5_sha="other"; }, "G7_OWNER_RECEIPT"],
  ["B_PRE", "G6a Worker provenance mismatch", e => { e.receipt.g6a_worker_version="other"; }, "G7_OWNER_RECEIPT"],
  ["B_PRE", "G7 detail count mismatch", e => { e.receipt.expected_detail_count=3; }, "G7_OWNER_RECEIPT"],
  ["B_PRE", "G7 receipt epoch malformed", e => { e.receipt.epoch_id="'; DROP"; }, "G7_OWNER_RECEIPT"],
  ["B_PRE", "unclosed ARMED epoch", e => { e.d1.epoch_active=1; }, "CANARY_EPOCH_INCOMPLETE"],
  ["B_PRE", "uncertain recovery operation", e => { e.d1.unverified_ops=1; }, "CANARY_EPOCH_INCOMPLETE"],
  ["B_PRE", "canary job incomplete", e => { e.epoch.job_completed=0; }, "CANARY_JOURNAL"],
  ["B_PRE", "missing DAILY journal", e => { e.epoch.daily=0; }, "CANARY_JOURNAL"],
  ["B_PRE", "missing RAW journal", e => { e.epoch.raw=0; }, "CANARY_JOURNAL"],
  ["B_PRE", "missing DETAIL journal", e => { e.epoch.detail=0; }, "CANARY_JOURNAL"],
  ["B_PRE", "new REVIEW still present", e => { e.d1.review=1; e.d1.review_all=1; }, "REVIEW_NOT_RELEASED"],
  ["B_PRE", "gate was already OFF", e => { e.status.recoveryGate.mode="DISABLED"; }, "G6A_GATE_STATE"],
  ["B_POST", "stale HELD claim", e => { e.d1.held=1; e.d1.stale_held=1; e.status.claim={state:"HELD"}; }, "STALE_WRITER_AFTER_GATE_EXIT"],
  ["B_POST", "IN_FLIGHT not backed by an unexpired job lease", e => { e.d1.inflight=1; e.d1.unleased_inflight=1; e.status.inFlightProjections=1; }, "STALE_WRITER_AFTER_GATE_EXIT"],
  ["B_POST", "too many overlapping claims", e => { e.d1.held=2; }, "STALE_WRITER_AFTER_GATE_EXIT"],
  ["B_POST", "unexpected REVIEW claim", e => { e.status.claim={state:"REVIEW"}; }, "REVIEW_NOT_RELEASED"],
  ["B_POST", "admin state and journal mismatch", e => { e.status.inFlightProjections=2; }, "STATUS_INFLIGHT_DRIFT"],
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

test("B_POST permits a single live HELD claim and leased journal during healthy backlog drain", () => {
  const e=fixture("B_POST");
  e.d1.held=1; e.d1.inflight=1;
  e.d1.stale_held=0; e.d1.unleased_inflight=0;
  e.status.claim={state:"HELD"};
  e.status.inFlightProjections=1;
  assert.deepEqual(verifyStage("B_POST",e),{ok:true,mode:"B_POST"});
});
test("B_PRE still refuses even an otherwise healthy HELD claim",()=>{
 const e=fixture("B_PRE");
 e.d1.held=1; e.status.claim={state:"HELD"};
 assert.throws(()=>verifyStage("B_PRE",e),/NO_GO_UNSAFE_WRITER/);
});

test("B_POST accepts D1 and admin snapshots sampled seconds apart",()=>{
 const one=fixture("B_POST");
 one.d1.inflight=1; one.d1.unleased_inflight=0;
 one.status.inFlightProjections=0;
 assert.deepEqual(verifyStage("B_POST",one),{ok:true,mode:"B_POST"});
 const two=fixture("B_POST");
 two.d1.inflight=0; two.status.inFlightProjections=1;
 assert.deepEqual(verifyStage("B_POST",two),{ok:true,mode:"B_POST"});
});

function riskFixture(){const e=fixture('B_PRE');e.epoch.epoch_created_at='2020-01-01T00:01:10.000Z';e.epoch.epoch_updated_at='2020-01-01T00:01:50.000Z';Object.assign(e.receipt,{schema:'MP248_G7_RECEIPT_V2_RISK_ACCEPTED',monitoring_coverage:'PARTIAL_PROJECT_UNBOUND',monitoring_project:'malipang-backend',gcp_quotas_checked:false,gcp_429_delta:null,gcp_ingestion_lag_ms:null,owner_accepted_429_observability_risk:true,limited_observed_429:false,observation_source:'GCP_UI_UNBOUND_AND_WORKER_LOGS_PARTIAL',monitoring_window_start:'2020-01-01T00:00:00.000Z',canary_started_at:'2020-01-01T00:01:00.000Z',canary_completed_at:'2020-01-01T00:02:00.000Z',monitoring_window_end:'2020-01-01T00:03:00.000Z',observed_at:'2020-01-01T00:05:00.000Z'});delete e.receipt.no_new_429_observed;return e}
test('explicit owner accepted partial monitoring keeps provider metric unknown',()=>{const e=riskFixture();assert.equal(verifyStage('B_PRE',e).ok,true);assert.equal(e.receipt.gcp_429_delta,null);assert.equal(e.receipt.gcp_quotas_checked,false)});
for(const [label,mutate] of [
 ['lag falsely reported known',r=>r.gcp_ingestion_lag_ms=0],
 ['global no-429 falsely claimed',r=>r.no_new_429_observed=true],
 ['owner decision missing',r=>delete r.owner_accepted_429_observability_risk],
 ['unknown delta mislabeled zero',r=>r.gcp_429_delta=0],
 ['unbound quota falsely reported true',r=>r.gcp_quotas_checked=true],
 ['limited observed 429',r=>r.limited_observed_429=true],
 ['coverage not explicit',r=>r.monitoring_coverage='COMPLETE'],
 ['wrong project',r=>r.monitoring_project='other'],
 ['source missing',r=>delete r.observation_source],
 ['window excludes canary',r=>r.monitoring_window_end='2020-01-01T00:01:30.000Z'],
 ['future observation',r=>r.observed_at='2999-01-01T00:05:00.000Z'],
 ['noncanonical timestamp',r=>r.canary_started_at='2020-01-01T00:01:00Z'],
 ['provider readback missing',r=>r.provider_readback_verified=false],
 ['duplicate present',r=>r.no_duplicate_stable_ids=false]
])test('risk exception rejects '+label,()=>{const e=riskFixture();mutate(e.receipt);assert.throws(()=>verifyStage('B_PRE',e),/NO_GO_G7_OWNER_RECEIPT/)});

test('risk exception requires D1 epoch timestamps inside the canary window',()=>{const e=riskFixture();delete e.epoch.epoch_created_at;assert.throws(()=>verifyStage('B_PRE',e),/NO_GO_G7_OWNER_RECEIPT/);e.epoch.epoch_created_at='2020-01-01T00:01:10.000Z';e.epoch.epoch_updated_at='2020-01-01T00:02:30.000Z';assert.throws(()=>verifyStage('B_PRE',e),/NO_GO_G7_OWNER_RECEIPT/)});
