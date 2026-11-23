import type { Env } from "../types";

type Row = Record<string, unknown>;

export type SheetsSyncHealthStatus =
  | "REVIEW_BLOCKED"
  | "DELAYED"
  | "HEALTHY"
  | "UNKNOWN";

const allowedTypes = [
  "EXPENSE", "PERSONAL_USE", "ATTENDANCE_EVENT",
  "DAILY_PAYROLL", "WEEKLY_PAYROLL", "SHIFT_SCHEDULE",
  "WAGE_HISTORY", "STAFF_CONFIG_SYNC", "OT_REQUEST", "SYSTEM_LOG",
] as const;

type Counters = { pending: number; failed: number; processing: number; review: number };
const emptyCounters = (): Counters => ({ pending: 0, failed: 0, processing: 0, review: 0 });
const count = (v: unknown): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;

function validTimestamp(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT/.test(v)) return null;
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === v ? v : null;
}

function ageMinutes(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const age = nowMs - Date.parse(value);
  return Number.isFinite(age) && age >= 0 ? Math.floor(age / 60_000) : null;
}

/** Authenticated, D1-only operational snapshot.
 * updated_at is the outbox's LAST update, not original event creation.
 * HEALTHY never proves a Google Sheets provider write was verified.
 */
export async function sheetsSyncHealth(env: Env, nowMs = Date.now()) {
  const workbook =
    typeof env.GOOGLE_SPREADSHEET_ID === "string" && env.GOOGLE_SPREADSHEET_ID.trim()
      ? env.GOOGLE_SPREADSHEET_ID
      : null;

  const query = [
    "SELECT",
    "COALESCE(SUM(CASE WHEN status IN ('PENDING','FAILED','PROCESSING') THEN 1 ELSE 0 END),0) unfinished,",
    "COALESCE(SUM(CASE WHEN status='REVIEW' THEN 1 ELSE 0 END),0) review_jobs,",
    "MIN(CASE WHEN status IN ('PENDING','FAILED','PROCESSING') THEN updated_at END) oldest_unfinished_updated_at,",
    "MAX(CASE WHEN status='COMPLETED' THEN updated_at END) last_completed_at,",
    "(SELECT COUNT(*) FROM stable_workbook_claims WHERE spreadsheet_id=? AND state='REVIEW') review_claims,",
    "(SELECT COUNT(*) FROM stable_workbook_claims WHERE spreadsheet_id=? AND state='HELD') held_claims",
    "FROM sync_jobs",
  ].join(" ");
  const groupingQuery = [
    "SELECT entity_type,status,COUNT(*) n FROM sync_jobs",
    "WHERE status IN ('PENDING','FAILED','PROCESSING','REVIEW')",
    "GROUP BY entity_type,status",
  ].join(" ");

  const [row, grouped] = await Promise.all([
    env.DB.prepare(query).bind(workbook ?? "",workbook ?? "").first<Row>(),
    env.DB.prepare(groupingQuery).all<Row>(),
  ]);

  const unfinished = count(row?.unfinished);
  const reviewJobs = count(row?.review_jobs);
  const reviewClaims = count(row?.review_claims);
  const heldClaims = count(row?.held_claims);
  const oldestUnfinishedLastUpdateAt = validTimestamp(row?.oldest_unfinished_updated_at);
  const lastCompletedAt = validTimestamp(row?.last_completed_at);
  const oldestUnfinishedLastUpdateMinutes = ageMinutes(oldestUnfinishedLastUpdateAt, nowMs);
  const lastCompletedAgeMinutes = ageMinutes(lastCompletedAt, nowMs);

  let status: SheetsSyncHealthStatus = "UNKNOWN";
  let reason = "NO_RECENT_SYNC_EVIDENCE";
  if (reviewClaims > 0) {
    status = "REVIEW_BLOCKED";
    reason = "WORKBOOK_REVIEW_CLAIM";
  } else if (!workbook) {
    reason = "WORKBOOK_NOT_CONFIGURED";
  } else if (env.SHEETS_SYNC_ENABLED !== "true") {
    reason = "SYNC_DISABLED";
  } else if (heldClaims > 0) {
    reason = "WORKBOOK_HELD_UNVERIFIED";
  } else if (reviewJobs > 0) {
    status = "DELAYED";
    reason = "SYNC_JOB_REVIEW_PENDING";
  } else if (unfinished > 0 && oldestUnfinishedLastUpdateMinutes === null) {
    reason = "UNFINISHED_CLOCK_UNVERIFIED";
  } else if (unfinished > 0 && oldestUnfinishedLastUpdateMinutes !== null
    && oldestUnfinishedLastUpdateMinutes > 10) {
    status = "DELAYED";
    reason = "UNFINISHED_OVER_10_MINUTES_SINCE_UPDATE";
  } else if (lastCompletedAgeMinutes !== null && lastCompletedAgeMinutes <= 15) {
    status = "HEALTHY";
    reason = "RECENT_D1_COMPLETION";
  } else if (unfinished > 0) {
    reason = "NEW_PENDING_WITHOUT_RECENT_COMPLETION";
  }

  const totals: Map<string, Counters> = new Map(
    allowedTypes.map(type => [type, emptyCounters()]),
  );
  const other = emptyCounters();
  for (const item of grouped.results ?? []) {
    const type = String(item.entity_type || "");
    const bucket = totals.get(type) ?? other;
    const field =
      item.status === "PENDING" ? "pending" :
      item.status === "FAILED" ? "failed" :
      item.status === "PROCESSING" ? "processing" :
      item.status === "REVIEW" ? "review" : null;
    if (field) bucket[field] += count(item.n);
  }

  return {
    status,
    reason,
    checkedAt: new Date(nowMs).toISOString(),
    workbookConfigured: workbook !== null,
    reviewClaimCount: reviewClaims,
    heldClaimCount: heldClaims,
    reviewJobCount: reviewJobs,
    unfinishedJobs: unfinished,
    oldestUnfinishedLastUpdateAt,
    oldestUnfinishedLastUpdateMinutes,
    lastCompletedAt,
    lastCompletedAgeMinutes,
    byType: [...totals.entries()].map(([entityType, counters]) => ({ entityType, ...counters }))
      .concat([{ entityType: "OTHER", ...other }]),
    providerReadbackVerified: false,
    note: "D1_ONLY_OUTBOX_LAST_UPDATE_NOT_GOOGLE_SHEETS_FRESHNESS",
  };
}
