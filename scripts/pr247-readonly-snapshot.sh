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
 (SELECT count(*) FROM sync_jobs WHERE status='REVIEW') review_jobs,
 (SELECT count(*) FROM failed_jobs WHERE status='OPEN') open_failed,
 (SELECT count(*) FROM stable_workbook_claims c WHERE c.state='HELD' AND (
   c.updated_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ',julianday(c.updated_at)) IS NOT c.updated_at
   OR c.updated_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
   OR c.updated_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-15 minutes')
 )) stale_held,
 (SELECT count(*) FROM stable_projection_writes p WHERE p.state='IN_FLIGHT' AND NOT EXISTS (
   SELECT 1 FROM sync_jobs j WHERE j.entity_type=p.entity_type AND j.entity_version=p.source_version
     AND (j.entity_key=p.entity_id OR (p.projection='DETAIL' AND substr(p.entity_id,1,length(j.entity_key)+1)=j.entity_key||'|'))
     AND j.status='PROCESSING' AND typeof(j.lease_token)='text' AND length(j.lease_token)>0
     AND j.updated_at IS NOT NULL
     AND strftime('%Y-%m-%dT%H:%M:%fZ',julianday(j.updated_at))=j.updated_at
     AND j.updated_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     AND j.lease_until IS NOT NULL
     AND strftime('%Y-%m-%dT%H:%M:%fZ',julianday(j.lease_until))=j.lease_until
     AND j.lease_until>j.updated_at
     AND j.lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
 )) unleased_inflight,
 (SELECT count(*) FROM stable_recovery_epochs e JOIN sync_jobs j ON j.entity_type=e.target_type AND j.entity_key=e.target_key AND j.entity_version=e.target_version WHERE e.target_type='EXPENSE' AND e.state IN ('COMPLETE','CLOSED') AND j.status='COMPLETED') canary_jobs_completed,
 (SELECT count(*) FROM stable_recovery_epochs e JOIN stable_projection_writes p ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=e.target_key AND p.source_version=e.target_version WHERE e.target_type='EXPENSE' AND e.state IN ('COMPLETE','CLOSED') AND p.projection='DAILY' AND p.state='VERIFIED') canary_daily,
 (SELECT count(*) FROM stable_recovery_epochs e JOIN stable_projection_writes p ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=e.target_key AND p.source_version=e.target_version WHERE e.target_type='EXPENSE' AND e.state IN ('COMPLETE','CLOSED') AND p.projection='EXPENSE_RAW' AND p.state='VERIFIED') canary_raw,
 (SELECT count(*) FROM stable_recovery_epochs e JOIN stable_projection_writes p ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND substr(p.entity_id,1,length(e.target_key)+1)=e.target_key||'|' AND p.source_version=e.target_version WHERE e.target_type='EXPENSE' AND e.state IN ('COMPLETE','CLOSED') AND p.projection='DETAIL' AND p.state='VERIFIED') canary_detail"
$wrangler d1 execute malipang-v5-2 --remote --json --command "$sql" > "$tmp/d1.json"
jq -e 'type == "array" and length == 1 and (.[0] | type) == "object" and .[0].success == true and (.[0].results | type) == "array" and (.[0].results | length) == 1 and (.[0].results[0] | type) == "object"' "$tmp/d1.json" >/dev/null
curl -fsS --retry 0 --max-time 20 --header "Authorization: Bearer $MALIPANG_ADMIN_TOKEN" "$MALIPANG_WORKER_URL/admin/stable-sync/status" > "$tmp/status.json"
jq -e '.ok == true' "$tmp/status.json" >/dev/null
if [[ "$mode" == B_* ]]; then
  test -n "${G7_RECEIPT_KEY:-}" && test -n "${G7_RECEIPT_SHA256:-}" || { echo NO_GO_OWNER_RECEIPT_REQUIRED >&2; exit 2; }
  [[ "$G7_RECEIPT_KEY" =~ ^release-control/pr247/g7/[a-zA-Z0-9_-]+\.json$ && "$G7_RECEIPT_SHA256" =~ ^[a-f0-9]{64}$ ]] || { echo NO_GO_RECEIPT_INPUT >&2; exit 2; }
  $wrangler r2 object get "malipang-private-backups/$G7_RECEIPT_KEY" --file="$tmp/owner-receipt.json" --remote >/dev/null
  actual="$(sha256sum "$tmp/owner-receipt.json" | cut -d' ' -f1)"
  test "$actual" = "$G7_RECEIPT_SHA256" || { echo NO_GO_RECEIPT_SHA256 >&2; exit 2; }
  epoch_id="$(jq -er '.epoch_id | select(type == "string" and test("^[A-Za-z0-9_-]{8,128}$"))' "$tmp/owner-receipt.json")" || { echo NO_GO_G7_EPOCH_ID >&2; exit 2; }
  # Exact, private, read-only check; epoch ID stays in runner memory and is never echoed.
  epoch_sql="WITH target AS (SELECT * FROM stable_recovery_epochs WHERE epoch_id='$epoch_id' AND target_type='EXPENSE')
   SELECT (SELECT count(*) FROM target) AS epoch_found,
     (SELECT state FROM target LIMIT 1) AS epoch_state,
     (SELECT created_at FROM target LIMIT 1) AS epoch_created_at,
     (SELECT updated_at FROM target LIMIT 1) AS epoch_updated_at,
     (SELECT count(*) FROM stable_recovery_operations o JOIN target e ON o.epoch_id=e.epoch_id WHERE o.state='ADMITTED') AS unverified_ops,
     (SELECT count(*) FROM stable_recovery_operations o JOIN target e ON o.epoch_id=e.epoch_id WHERE o.state='VERIFIED') AS verified_ops,
     (SELECT count(*) FROM sync_jobs j JOIN target e ON j.entity_type=e.target_type AND j.entity_key=e.target_key AND j.entity_version=e.target_version WHERE j.status='COMPLETED') AS job_completed,
     (SELECT count(*) FROM stable_projection_writes p JOIN target e ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=e.target_key AND p.source_version=e.target_version WHERE p.projection='DAILY' AND p.state='VERIFIED') AS daily,
     (SELECT count(*) FROM stable_projection_writes p JOIN target e ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=e.target_key AND p.source_version=e.target_version WHERE p.projection='EXPENSE_RAW' AND p.state='VERIFIED') AS raw,
     (SELECT count(*) FROM stable_projection_writes p JOIN target e ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND substr(p.entity_id,1,length(e.target_key)+1)=e.target_key||'|' AND p.source_version=e.target_version WHERE p.projection='DETAIL' AND p.state='VERIFIED') AS detail"
  if jq -e '.schema == "MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED"' "$tmp/owner-receipt.json" >/dev/null; then
    expected_digest="$(jq -er '.source_snapshot_digest | select(type == "string" and length == 64 and test("^[a-f0-9]{64}$"))' "$tmp/owner-receipt.json")" || { echo NO_GO_G7_SOURCE_DIGEST >&2; exit 2; }
    epoch_sql="WITH target AS (SELECT * FROM stable_recovery_epochs WHERE epoch_id='$epoch_id' AND target_type='EXPENSE')
     SELECT (SELECT count(*) FROM target) AS epoch_found,
       (SELECT state FROM target LIMIT 1) AS epoch_state,
       (SELECT target_key FROM target LIMIT 1) AS target_key,
       (SELECT target_version FROM target LIMIT 1) AS target_version,
       (SELECT j.trace_id FROM sync_jobs j JOIN target e ON j.entity_type=e.target_type AND j.entity_key=e.target_key AND j.entity_version=e.target_version WHERE j.status='COMPLETED' LIMIT 1) AS target_trace,
       (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN ('stable_recovery_epoch_no_delete','stable_recovery_epoch_transition')) AS epoch_immutability_triggers,
       (SELECT count(*) FROM pragma_index_list('stable_recovery_epochs') WHERE name='stable_recovery_one_active_epoch' AND [unique]=1 AND partial=1) AS epoch_active_unique,
       (SELECT created_at FROM target LIMIT 1) AS epoch_created_at,
       (SELECT updated_at FROM target LIMIT 1) AS epoch_updated_at,
       (SELECT count(*) FROM stable_recovery_operations o JOIN target e ON o.epoch_id=e.epoch_id WHERE o.state='ADMITTED') AS unverified_ops,
       (SELECT count(*) FROM stable_recovery_operations o JOIN target e ON o.epoch_id=e.epoch_id WHERE o.state='VERIFIED') AS verified_ops,
       (SELECT count(*) FROM sync_jobs j JOIN target e ON j.entity_type=e.target_type AND j.entity_key=e.target_key AND j.entity_version=e.target_version WHERE j.status='COMPLETED') AS job_completed,
       (SELECT count(*) FROM expense_events x JOIN target e ON x.expense_id=e.target_key AND x.version=e.target_version WHERE x.status='CONFIRMED' AND x.amount_satang=500) AS source_matches,
       (SELECT revision FROM stable_source_revision WHERE singleton=1) AS source_revision,
       (SELECT count(*) FROM stable_sync_cutover WHERE singleton=1 AND state='ACTIVE') AS cutover_active,
       (SELECT count(*) FROM stable_pre_cutover_sources s JOIN target e ON s.entity_type='EXPENSE' AND s.entity_id=e.target_key) AS pre_cutover_count,
       (SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (
         'stable_source_revision_expense_events_insert','stable_source_revision_expense_events_update','stable_source_revision_expense_events_delete',
         'stable_source_revision_expense_documents_insert','stable_source_revision_expense_documents_update','stable_source_revision_expense_documents_delete',
         'stable_source_revision_expense_document_links_insert','stable_source_revision_expense_document_links_update','stable_source_revision_expense_document_links_delete',
         'stable_source_revision_expense_document_items_insert','stable_source_revision_expense_document_items_update','stable_source_revision_expense_document_items_delete',
         'stable_source_revision_owner_personal_transactions_insert','stable_source_revision_owner_personal_transactions_update','stable_source_revision_owner_personal_transactions_delete',
         'stable_source_revision_no_delete','stable_source_revision_no_replace','stable_source_revision_monotonic','stable_pre_cutover_no_delete','stable_pre_cutover_no_update','stable_pre_cutover_no_replace',
         'stable_cutover_no_delete','stable_cutover_no_replace','stable_cutover_transition','stable_projection_no_delete','stable_projection_no_replace','stable_projection_transition')) AS integrity_triggers,
       (SELECT count(*) FROM expense_document_items i JOIN target e ON i.expense_id=e.target_key) AS source_item_count,
       (SELECT count(*) FROM expense_documents d JOIN target e ON d.expense_id=e.target_key) AS source_document_count,
       (SELECT count(*) FROM expense_document_links l JOIN target e ON l.expense_id=e.target_key) AS source_link_count,
       (SELECT count(*) FROM stable_projection_writes p JOIN target e ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND (p.entity_id=e.target_key OR substr(p.entity_id,1,length(e.target_key)+1)=e.target_key||'|')) AS journal_total,
       (SELECT count(*) FROM stable_projection_writes p JOIN target e ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND substr(p.entity_id,1,length(e.target_key)+1)=e.target_key||'|' WHERE p.projection='DETAIL') AS detail_any,
       (SELECT count(*) FROM stable_projection_writes p JOIN target e ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=e.target_key AND p.source_version=e.target_version AND p.source_digest='$expected_digest' WHERE p.projection='DAILY' AND p.sheet_id=1815870717 AND p.sheet_name='รายวัน' AND p.state='VERIFIED') AS daily,
       (SELECT count(*) FROM stable_projection_writes p JOIN target e ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND p.entity_id=e.target_key AND p.source_version=e.target_version AND p.source_digest='$expected_digest' WHERE p.projection='EXPENSE_RAW' AND p.sheet_id=247227172 AND p.sheet_name='V52_EXPENSE_RAW' AND p.state='VERIFIED') AS raw,
       (SELECT count(*) FROM stable_projection_writes p JOIN target e ON p.spreadsheet_id=e.spreadsheet_id AND p.entity_type='EXPENSE' AND substr(p.entity_id,1,length(e.target_key)+1)=e.target_key||'|' WHERE p.projection='DETAIL' AND p.state='VERIFIED') AS detail"
  fi
  $wrangler d1 execute malipang-v5-2 --remote --json --command "$epoch_sql" > "$tmp/epoch.json"
  jq -e 'type == "array" and length == 1 and (.[0] | type) == "object" and .[0].success == true and (.[0].results | type) == "array" and (.[0].results | length) == 1 and (.[0].results[0] | type) == "object"' "$tmp/epoch.json" >/dev/null || { echo NO_GO_G7_EPOCH_PROVIDER >&2; exit 2; }
  if jq -e '.schema == "MP248_G7_RECEIPT_V3_ZERO_ITEM_RISK_ACCEPTED"' "$tmp/owner-receipt.json" >/dev/null; then
    nonce="$(jq -er '.arm_audit_nonce | select(type == "string" and length == 48 and test("^[a-f0-9]{48}$"))' "$tmp/owner-receipt.json")" || { echo NO_GO_G7_AUDIT_NONCE >&2; exit 2; }
    $wrangler r2 object get "malipang-private-backups/release-control/pr247/g7/arm-audit/$nonce-intent.json" --file="$tmp/g7-intent.json" --remote >/dev/null
    $wrangler r2 object get "malipang-private-backups/release-control/pr247/g7/arm-audit/$nonce-outcome.json" --file="$tmp/g7-outcome.json" --remote >/dev/null
    node scripts/pr247-g7-zero-proof.mjs "$tmp/owner-receipt.json" "$tmp/g7-intent.json" "$tmp/g7-outcome.json" "$tmp/epoch.json"
    jq '.[0].results[0] |= del(.target_key,.target_trace)' "$tmp/epoch.json" > "$tmp/epoch-sanitized.json"
    mv "$tmp/epoch-sanitized.json" "$tmp/epoch.json"
  fi
else
  printf 'null\n' > "$tmp/owner-receipt.json"
  printf '[{"results":[null],"success":true}]\n' > "$tmp/epoch.json"
fi
jq -n --slurpfile g5 "$tmp/g5.json" --slurpfile cron "$tmp/cron.json" --slurpfile queues "$tmp/queues.json" --slurpfile deploy "$tmp/deploy.json" --slurpfile d1 "$tmp/d1.json" --slurpfile status "$tmp/status.json" --slurpfile receipt "$tmp/owner-receipt.json" --slurpfile epoch "$tmp/epoch.json" --arg g5sha "$G5_SHA" --arg worker "$EXPECTED_WORKER_VERSION" --arg prior "$PRIOR_WORKER_VERSION" --argjson done "$COMPLETED_BEFORE" --argjson failures "$OPEN_FAILED_BEFORE" '
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
  receipt: $receipt[0],
  epoch: $epoch[0][0].results[0]
}' > "$out"
node scripts/pr247-stage-guard.mjs "$mode" "$out"
# Only safe PASS/FAIL is emitted. Snapshot may contain operational metadata and is runner-private.
