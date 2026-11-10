#!/usr/bin/env bash
# READ ONLY. Revalidates a specific already-deployed G6a version; this does not
# create/modify an R2 receipt, deploy a Worker, or alter Queue/Cron/D1/Sheets.
set -euo pipefail
set +x

for name in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN MALIPANG_ADMIN_TOKEN MALIPANG_WORKER_URL EXPECTED_MAIN_SHA; do
  test -n "${!name:-}" || { echo "NO_GO_REQUIRED_ENV_$name" >&2; exit 2; }
done
[[ "$EXPECTED_MAIN_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo NO_GO_MAIN_SHA >&2; exit 2; }

# Pin the historical G5 evidence and the *actual* G6a Worker. The two counts
# are from the failed G6a run's A_PRE GITHUB_ENV, not guessed current counts.
export G5_SHA=0d1dda77f3a0e5cfaec1872cb588b59dddfe5bdf
export G5_RUN_ID=42802512915 G5_RUN_ATTEMPT=1
export PRIOR_WORKER_VERSION=1ac8cdf0-3b4c-414b-a77e-5e1ecddbd597
export EXPECTED_WORKER_VERSION=e26b593e-7fa5-4492-a62f-5a0c68f3533f
export COMPLETED_BEFORE=3296 OPEN_FAILED_BEFORE=32
readonly previous_worker=310192aa-8a04-4b61-8a72-4455231b3339
readonly queue_id=b9b12fe82e6b402291b5d16d2ce61770
readonly receipt_key="malipang-private-backups/release-control/pr247/${G5_RUN_ID}-${G5_RUN_ATTEMPT}.json"

umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
read_receipt() {
  ./node_modules/.bin/wrangler r2 object get "$receipt_key" --file="$1" --remote >/dev/null
  jq -e --arg run "$G5_RUN_ID" --arg sha "$G5_SHA" --arg prior "$previous_worker" --arg queue "$queue_id" '
    type == "object" and .release == "PR247" and .state == "VERIFIED_COMPLETED"
    and .run_id == $run and .expected_sha == $sha and .prior_worker_version == $prior
    and .queue_was_active == true and .queue_id == $queue
  ' "$1" >/dev/null || { echo NO_GO_G5_RECEIPT_MISMATCH >&2; exit 1; }
}
verify_main() {
  test "$(git rev-parse HEAD)" = "$EXPECTED_MAIN_SHA" || { echo NO_GO_CHECKOUT_CHANGED >&2; exit 1; }
  test "$(git ls-remote origin refs/heads/main | cut -f1)" = "$EXPECTED_MAIN_SHA" || { echo NO_GO_MAIN_CHANGED >&2; exit 1; }
}

verify_main
read_receipt "$tmp/g5-before.json"
# A_POST validates the live Worker is exactly the pinned G6a version at 100%,
# Queue is explicitly unpaused, Cron is active, original REVIEW is retained,
# gate/pacing are UNARMED and counters match the real earlier A_PRE baseline.
bash scripts/pr247-readonly-snapshot.sh A_POST "$tmp/first.json" >/dev/null
sleep 360
verify_main
read_receipt "$tmp/g5-after.json"
cmp -s "$tmp/g5-before.json" "$tmp/g5-after.json" || { echo NO_GO_G5_RECEIPT_CHANGED >&2; exit 1; }
bash scripts/pr247-readonly-snapshot.sh A_POST "$tmp/second.json" >/dev/null
verify_main
echo 'G6A_INCIDENT_READONLY_REVALIDATION_OBSERVED: two A_POST checks 360 seconds apart'
echo 'The original failed workflow remains failed; no release receipt was created.'
