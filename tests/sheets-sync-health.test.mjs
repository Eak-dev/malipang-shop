import test from "node:test";
import assert from "node:assert/strict";
import { ownerOrderFixture } from "./helpers/owner-order-review.mjs";
import { sheetsSyncHealth } from "../dist/operations/sheets-sync-health.js";
import { operationsSummary } from "../dist/operations/summary.js";
import { handleAdmin } from "../dist/admin/handler.js";

const now = Date.parse("2026-11-07T03:00:00.000Z");
const sheet = "SYNTHETIC_WORKBOOK_FIXED";
const secret = "SYNTHETIC_ENTITY_KEY_NEVER_DISCLOSE";

function fixture() {
  const h = ownerOrderFixture();
  h.env.GOOGLE_SPREADSHEET_ID = sheet;
  h.env.SHEETS_SYNC_ENABLED = "true";
  return h;
}

let nextJob = 0;
function addJob(h, type, status, minutesAgo = 5, at = null) {
  const date = at ?? new Date(now - minutesAgo * 60_000).toISOString();
  h.sqlite.prepare(
    "INSERT INTO sync_jobs(job_id,entity_type,entity_key,entity_version,trace_id,status,attempt_count,updated_at) VALUES(?,?,?,?,?,?,?,?)",
  ).run("synthetic_job_" + (++nextJob),type,secret + nextJob,1,secret,status,0,date);
}

function holdReview(h) {
  const at = new Date(now - 80 * 60_000).toISOString();
  h.sqlite.prepare(
    "INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,notice_stamp,notice_identity,created_at,updated_at) VALUES(?,?,'REVIEW',?,?,?,?)",
  ).run(sheet,secret,"SYNTHETIC_STAMP",secret,at,at);
}

test("REVIEW claim overrides recent completions and reports D1-only blocked status", async () => {
  const h = fixture();
  try {
    addJob(h,"EXPENSE","COMPLETED",2);
    addJob(h,"ATTENDANCE_EVENT","PENDING",6);
    holdReview(h);
    const before = h.sqlite.prepare("SELECT total_changes() AS n").get().n;
    const result = await sheetsSyncHealth(h.env,now);
    assert.equal(result.status,"REVIEW_BLOCKED");
    assert.equal(result.reason,"WORKBOOK_REVIEW_CLAIM");
    assert.equal(result.reviewClaimCount,1);
    assert.equal(result.unfinishedJobs,1);
    assert.equal(result.oldestUnfinishedLastUpdateMinutes,6);
    assert.equal(result.providerReadbackVerified,false);
    assert.equal(h.sqlite.prepare("SELECT total_changes() AS n").get().n,before);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
  } finally {h.close();}
});

test("HELD workbook claim never reports healthy even if D1 recently completed an outbox", async () => {
  const h = fixture();
  try {
    addJob(h,"EXPENSE","COMPLETED",1);
    const at = new Date(now).toISOString();
    h.sqlite.prepare(
      "INSERT INTO stable_workbook_claims(spreadsheet_id,operation_token,state,created_at,updated_at) VALUES(?,?,'HELD',?,?)",
    ).run(sheet,secret,at,at);
    const result = await sheetsSyncHealth(h.env,now);
    assert.equal(result.status,"UNKNOWN");
    assert.equal(result.reason,"WORKBOOK_HELD_UNVERIFIED");
    assert.equal(result.heldClaimCount,1);
    assert.equal(result.providerReadbackVerified,false);
  } finally {h.close();}
});

test("outstanding last update older than ten minutes is delayed, no retry", async () => {
  const h = fixture();
  try {
    addJob(h,"EXPENSE","PENDING",17);
    addJob(h,"DAILY_PAYROLL","PROCESSING",12);
    const result = await sheetsSyncHealth(h.env,now);
    assert.equal(result.status,"DELAYED");
    assert.equal(result.reason,"UNFINISHED_OVER_10_MINUTES_SINCE_UPDATE");
    assert.equal(result.unfinishedJobs,2);
    assert.equal(result.oldestUnfinishedLastUpdateMinutes,17);
    assert.equal(h.queue.length,0);
    assert.equal(result.byType.find(x=>x.entityType==="EXPENSE").pending,1);
    assert.equal(result.byType.find(x=>x.entityType==="DAILY_PAYROLL").processing,1);
  } finally {h.close();}
});

test("recent COMPLETED outbox job allows D1-only healthy signal, not Sheets verification", async () => {
  const h = fixture();
  try {
    addJob(h,"EXPENSE","COMPLETED",1);
    const result = await sheetsSyncHealth(h.env,now);
    assert.equal(result.status,"HEALTHY");
    assert.equal(result.lastCompletedAgeMinutes,1);
    assert.equal(result.unfinishedJobs,0);
    assert.equal(result.providerReadbackVerified,false);
    assert.match(result.note,/D1_ONLY/);
  } finally {h.close();}
});

test("no new jobs or recent completions is UNKNOWN instead of claiming healthy", async () => {
  const h = fixture();
  try {
    const result = await sheetsSyncHealth(h.env,now);
    assert.equal(result.status,"UNKNOWN");
    assert.equal(result.reason,"NO_RECENT_SYNC_EVIDENCE");
    addJob(h,"EXPENSE","COMPLETED",60);
    const after = await sheetsSyncHealth(h.env,now);
    assert.equal(after.status,"UNKNOWN");
  } finally {h.close();}
});

test("recent pending with no provider completion stays UNKNOWN, never falsely healthy", async () => {
  const h = fixture();
  try {
    addJob(h,"EXPENSE","PENDING",1);
    const result = await sheetsSyncHealth(h.env,now);
    assert.equal(result.status,"UNKNOWN");
    assert.equal(result.reason,"NEW_PENDING_WITHOUT_RECENT_COMPLETION");
  } finally {h.close();}
});

test("future or malformed outbox clocks cannot result in HEALTHY", async () => {
  const h = fixture();
  try {
    addJob(h,"EXPENSE","PROCESSING",0,new Date(now + 60_000).toISOString());
    const future = await sheetsSyncHealth(h.env,now);
    assert.equal(future.status,"UNKNOWN");
    assert.equal(future.reason,"UNFINISHED_CLOCK_UNVERIFIED");
  } finally {h.close();}
  const bad = fixture();
  try {
    addJob(bad,"EXPENSE","PENDING",0,"bad_timestamp");
    const result = await sheetsSyncHealth(bad.env,now);
    assert.equal(result.status,"UNKNOWN");
    assert.equal(result.oldestUnfinishedLastUpdateAt,null);
  } finally {bad.close();}
});

test("disabled Sheets sync and missing workbook identity are UNKNOWN", async () => {
  const h = fixture();
  try {
    addJob(h,"EXPENSE","COMPLETED",1);
    h.env.SHEETS_SYNC_ENABLED = "false";
    assert.equal((await sheetsSyncHealth(h.env,now)).reason,"SYNC_DISABLED");
    h.env.SHEETS_SYNC_ENABLED = "true";
    h.env.GOOGLE_SPREADSHEET_ID = "";
    assert.equal((await sheetsSyncHealth(h.env,now)).reason,"WORKBOOK_NOT_CONFIGURED");
  } finally {h.close();}
});

test("per-entity counts have fixed nonidentifying labels and unknown types aggregate to OTHER", async () => {
  const h = fixture();
  try {
    addJob(h,"EXPENSE","PENDING",7);
    addJob(h,"EXPENSE","FAILED",4);
    addJob(h,"SYNTHETIC_UNKNOWN_KEY_TYPE","REVIEW",1);
    const result = await sheetsSyncHealth(h.env,now);
    assert.equal(result.status,"DELAYED");
    assert.equal(result.byType.find(x=>x.entityType==="EXPENSE").pending,1);
    assert.equal(result.byType.find(x=>x.entityType==="EXPENSE").failed,1);
    assert.equal(result.byType.find(x=>x.entityType==="OTHER").review,1);
    assert.doesNotMatch(JSON.stringify(result),/SYNTHETIC_UNKNOWN_KEY_TYPE/);
    assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
  } finally {h.close();}
});

test("existing operations summary includes read-only health without changing previous fields", async () => {
  const h = fixture();
  try {
    addJob(h,"EXPENSE","PENDING",25);
    holdReview(h);
    const before = h.sqlite.prepare("SELECT total_changes() AS n").get().n;
    const result = await operationsSummary(h.env,now);
    assert.equal(result.ok,true);
    assert.equal(result.status,"ATTENTION");
    assert.equal(result.sideEffects.pendingSyncJobs,1);
    assert.equal(result.sideEffects.sheetsSync.status,"REVIEW_BLOCKED");
    assert.ok(result.actions.includes("INSPECT_SHEETS_REVIEW_BEFORE_RECOVERY"));
    assert.equal(h.sqlite.prepare("SELECT total_changes() AS n").get().n,before);
  } finally {h.close();}
});

test("admin authentication blocks unauthorized health access; authorized call does not send Queue or network writes", async (t) => {
  const h = fixture();
  t.mock.method(Date,"now",()=>now);
  t.mock.method(globalThis,"fetch",()=>{throw new Error("Network calls forbidden");});
  try {
    h.env.ADMIN_TOKEN = "synthetic-admin-token-with-32-characters";
    addJob(h,"EXPENSE","PENDING",18);
    holdReview(h);
    const prior = h.sqlite.prepare("SELECT total_changes() AS n").get().n;
    const denied = await handleAdmin(new Request("https://local.invalid/admin/operations/summary"),h.env,{});
    assert.equal(denied.status,401);
    const allowed = await handleAdmin(
      new Request("https://local.invalid/admin/operations/summary",{
        headers:{authorization:"Bearer " + h.env.ADMIN_TOKEN},
      }),h.env,{},
    );
    assert.equal(allowed.status,200);
    const json = await allowed.json();
    assert.equal(json.sideEffects.sheetsSync.status,"REVIEW_BLOCKED");
    assert.equal(json.sideEffects.sheetsSync.providerReadbackVerified,false);
    assert.equal(h.sqlite.prepare("SELECT total_changes() AS n").get().n,prior);
    assert.equal(h.queue.length,0);
    assert.doesNotMatch(JSON.stringify(json),new RegExp(secret));
  } finally {h.close();}
});
