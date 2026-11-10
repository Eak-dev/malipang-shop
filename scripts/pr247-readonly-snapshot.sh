#!/usr/bin/env bash
# Issue #248 readback only. NEVER changes Production; rejects unknown readback.
set -euo pipefail
mode="$1"
out="$2"
case "$mode" in A_PRE|A_POST|B_PRE|B_POST) ;; *) echo NO_GO_MODE >&2; exit 2;; esac
for name in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN MALIPANG_ADMIN_TOKEN MALIPANG_WORKER_URL G5_RUN_ID G5_RUN_ATTEMPT G5_SHA EXPECTED_WORKER_VERSION PRIOR_WORKER_VERSION COMPLETED_BEFORE OPEN_FAILED_BEFORE; do
  test -n "${!name:-}" || { echo "NO_GO_REQUIRED_ENV_$name" >&2; exit 2; }
done
[[ "$G5_RUN_ID" =~ ^[0-9]+$ && "$G5_RUN_ATTEMPT" =~ ^[0-9]+$ ]] || { echo NO_GO_G5_RECEIPT_ID >&2; exit 2; }
[[ "$EXPECTED_WORKER_VERSION" =~ ^[a-f0-9-]{30,40}$ ]] || { echo NO_GO_WORKER_VERSION_FORMAT >&2; exit 2; }
[[ "$G5_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo NO_GO_G5_SHA_FORMAT >&2; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
umask 077
wrangler=./node_modules/.bin/wrangler
cfapi="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
get_cf() {
  local suffix="$1" target="$2"
  curl -fsS --retry 0 --max-time 20 --header "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$cfapi$suffix" > "$target"
  jq -e '.success == true' "$target" >/dev/null
}
$wrangler r2 object get "malipang-private-backups/release-control/pr247/$G5_RUN_ID-$G5_RUN_ATTEMPT.json" --file="$tmp/g5.json" --remote >/dev/null
get_cf "/workers/scripts/malipang-backend-v5-2/schedules" "$tmp/cron.json"
get_cf "/queues" "$tmp/queues.json"
get_cf "/workers/scripts/malipang-backend-v5-2/deployments" "$tmp/deploy.json"
jq -e '([.result[] | select(.queue_name == "malipang-jobs")] | length) == 1' "$tmp/queues.json" >/dev/null
sql="SELECT
 (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) migration,
 (SELECT count(*) FROM sqlite_master WHERE type='table' AND name IN ('stable_recovery_epochs','stable_recovery_operations','stable_sheet_pacing','stable_sheet_busy_backoffs')) recovery_tables,
 (SELECT count(*) FROM stable_workbook_claims WHERE state='REVIEW' AND notice_stamp='2026-11-05 21:26:00') review,
 (SELECT count(*) FROM stable_workbook_claims WHERE state='REVIEW') review_all,
 (SELECT count(*) FROM stable_workbook_claims WHERE state='HELD') held,
 (SELECT count(*) FROM stable_projection_writes WHERE state='IN_FLIGHT') inflight,
 (SELECT count(*) FROM stable_recovery_epochs) epoch_total,
 (SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('ARMED','REVIEW')) epoch_active,
 (SELECT count(*) FROM stable_recovery_epochs WHERE state IN ('COMPLETE','CLOSED') AND target_type='EXPENSE') epoch_complete,
 (SELECT count(*) FROM stable_recovery_operations WHERE state='ADMITTED') unverified_ops,
 (SELECT count(*) FROM stable_recovery_operations WHERE state='VERIFIED') verified_ops,
 (SELECT count(*) FROM sync_jobs WHERE status='COMPLETED') completed,
 (SELECT count(*) FROM failed_jobs WHERE status='OPEN') open_failed,
 (SELECT count(*) FROM stable_recovery_epochs e JOIN sync_jobs j ON j.entity_type=e.target_type AND j.entity_key=e.target_key AND j.entity_version=e.target_version WHERE e.target_type='EXPENSE' AND e.state IN ('COMPLETE','CLOSED') AND j.status='COMPLETED') canary_jobs_completed,
 (SELECT count(*) FROM stable_recovery_epochs e JOIN stable_projection_writes p ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=e.target_key AND p.source_version=e.target_version WHERE e.target_type='EXPENSE' AND e.state IN ('COMPLETE','CLOSED') AND p.projection='DAILY' AND p.state='VERIFIED') canary_daily,
 (SELECT count(*) FROM stable_recovery_epochs e JOIN stable_projection_writes p ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=e.target_key AND p.source_version=e.target_version WHERE e.target_type='EXPENSE' AND e.state IN ('COMPLETE','CLOSED') AND p.projection='EXPENSE_RAW' AND p.state='VERIFIED') canary_raw,
 (SELECT count(*) FROM stable_recovery_epochs e JOIN stable_projection_writes p ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND substr(p.entity_id,1,length(e.target_key)+1)=e.target_key||'|' AND p.source_version=e.target_version WHERE e.target_type='EXPENSE' AND e.state IN ('COMPLETE','CLOSED') AND p.projection='DETAIL' AND p.state='VERIFIED') canary_detail"
$wrangler d1 execute malipang-v5-2 --remote --json --command "$sql" > "$tmp/d1.json"
jq -e 'type == "array" and length == 1 and .[0].success == true and (.[0].results | type) == "array" and (.[0].results | length) == 1' "$tmp/d1.json" >/dev/null
curl -fsS --retry 0 --max-time 20 --header "Authorization: Bearer $MALIPANG_ADMIN_TOKEN" "$MALIPANG_WORKER_URL/admin/stable-sync/status" > "$tmp/status.json"
jq -e '.ok == true' "$tmp/status.json" >/dev/null
if [[ "$mode" == B_* ]]; then
  test -n "${G7_RECEIPT_KEY:-}" && test -n "${G7_RECEIPT_SHA256:-}" || { echo NO_GO_OWNER_RECEIPT_REQUIRED >&2; exit 2; }
  [[ "$G7_RECEIPT_KEY" =~ ^release-control/pr247/g7/[a-zA-Z0-9_-]+\.json$ && "$G7_RECEIPT_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo NO_GO_RECEIPT_INPUT >&2; exit 2; }
  $wrangler r2 object get "malipang-private-backups/$G7_RECEIPT_KEY" --file="$tmp/owner-receipt.json" --remote >/dev/null
  actual="$(sha256sum "$tmp/owner-receipt.json" | cut -d' ' -f1)"
  test "$actual" = "$G7_RECEIPT_SHA256" || { echo NO_GO_RECEIPT_SHA256 >&2; exit 2; }
else
  printf 'null\n' > "$tmp/owner-receipt.json"
fi
jq -n --slurpfile g5 "$tmp/g5.json" --slurpfile cron "$tmp/cron.json" --slurpfile queues "$tmp/queues.json" --slurpfile deploy "$tmp/deploy.json" --slurpfile d1 "$tmp/d1.json" --slurpfile status "$tmp/status.json" --slurpfile receipt "$tmp/owner-receipt.json" --arg g5sha "$G5_SHA" --arg worker "$EXPECTED_WORKER_VERSION" --arg prior "$PRIOR_WORKER_VERSION" --argjson done "$COMPLETED_BEFORE" --argjson failures "$OPEN_FAILED_BEFORE" '
{
  g5: $g5[0],
  params: {g5Sha:$g5sha, expectedWorkerVersion:$worker,priorWorkerVersion:$prior,completedBefore:$done,openFailedBefore:$failures},
  cloudflare: {
    cron: $cron[0].result.schedules,
    queue: ($queues[0].result | map(select(.queue_name == "malipang-jobs")) | .[0]),
    versions: $deploy[0].result.deployments[0].versions
  },
  d1: $d1[0][0].results[0],
  status: $status[0],
  receipt: $receipt[0]
}' > "$out"
node scripts/pr247-stage-guard.mjs "$mode" "$out"
# Only safe PASS/FAIL is emitted. Snapshot may contain operational metadata and is runner-private.
