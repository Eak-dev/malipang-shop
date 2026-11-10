#!/usr/bin/env bash
# Scoped diagnostic deploy recovery. No retries and no claim of universal writer fence.
set -euo pipefail
umask 077
: "${RUNNER_TEMP:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}" "${GITHUB_REPOSITORY:?}" "${CLOUDFLARE_ACCOUNT_ID:?}" "${CLOUDFLARE_API_TOKEN:?}" "${EXPECTED_SHA:?}"
header="$RUNNER_TEMP/queue-cf-header"
printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN" > "$header"
get_queue(){ curl -fsS --retry 0 --max-time 20 --header "@$header" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues/$1"; }
# Evidence of no competing *known GitHub release workflow*; external/manual
# actors are not fenced. Failure or unclassifiable API response stops the run.
known_markers(){
  for state in queued in_progress; do
    gh api --paginate --slurp "/repos/$GITHUB_REPOSITORY/actions/runs?status=$state&per_page=100" > "$RUNNER_TEMP/known-runs-$state.json"
    jq -e --arg run "$GITHUB_RUN_ID" 'type=="array" and all(.[]; (.workflow_runs|type)=="array" and all(.workflow_runs[]; ((.id|tostring)==$run) or ((.path|type)=="string" and (.path|test("(^|/)(production-pr247|issue248-.*(release|deploy|recheck))")|not))))' "$RUNNER_TEMP/known-runs-$state.json" >/dev/null || { echo 'COMPETING_KNOWN_RELEASE_OR_UNKNOWN' >&2; exit 1; }
  done
}
case "${1:-}" in
pre)
  known_markers
  curl -fsS --retry 0 --max-time 20 --header "@$header" "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues" > "$RUNNER_TEMP/queue-list.json"
  jq -e '.success==true and ([.result[]|select(.queue_name=="malipang-jobs")]|length)==1' "$RUNNER_TEMP/queue-list.json" >/dev/null
  id="$(jq -r '[.result[]|select(.queue_name=="malipang-jobs")][0].queue_id' "$RUNNER_TEMP/queue-list.json")"
  [[ "$id" =~ ^[a-f0-9]{32}$ ]]
  get_queue "$id" > "$RUNNER_TEMP/queue-diagnostic-before.json"
  actual="$(node scripts/issue248-queue-proof.mjs pre "$RUNNER_TEMP/queue-diagnostic-before.json")"
  test "$id" = "$actual"
  echo "DIAGNOSTIC_QUEUE_ID=$id" >> "$GITHUB_ENV"
  echo 'QUEUE_PRE_EXPLICIT_ACTIVE; external/manual actor risk accepted but not fenced' >> "$GITHUB_STEP_SUMMARY"
  ;;
post)
  : "${DIAGNOSTIC_QUEUE_ID:?}"
  known_markers
  get_queue "$DIAGNOSTIC_QUEUE_ID" > "$RUNNER_TEMP/queue-diagnostic-after.json"
  action="$(node scripts/issue248-queue-proof.mjs compare "$RUNNER_TEMP/queue-diagnostic-before.json" "$RUNNER_TEMP/queue-diagnostic-after.json")"
  if [ "$action" = PATCH_ONCE ]; then
    key="release-control/pr247/g6b-diagnostic/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT-queue-patch-intent.json"
    pre_hash="$(shasum -a 256 "$RUNNER_TEMP/queue-diagnostic-before.json" | cut -d' ' -f1)"
    jq -n --arg sha "$EXPECTED_SHA" --arg id "$DIAGNOSTIC_QUEUE_ID" --arg hash "$pre_hash" --arg run "$GITHUB_RUN_ID" --arg attempt "$GITHUB_RUN_ATTEMPT" '{schema:"MP248_DIAGNOSTIC_QUEUE_V1",state:"PATCH_INTENT",sha:$sha,queue_id:$id,preimage_sha256:$hash,run_id:$run,run_attempt:$attempt,external_writer_risk:"ACCEPTED_UNKNOWN"}' > "$RUNNER_TEMP/queue-patch-intent.json"
    npx wrangler r2 object put "malipang-private-backups/$key" --file="$RUNNER_TEMP/queue-patch-intent.json" --remote
    npx wrangler r2 object get "malipang-private-backups/$key" --file="$RUNNER_TEMP/queue-patch-intent-readback.json" --remote
    cmp -s "$RUNNER_TEMP/queue-patch-intent.json" "$RUNNER_TEMP/queue-patch-intent-readback.json" || { echo 'QUEUE_PATCH_INTENT_UNKNOWN' >&2; exit 1; }
    known_markers
    get_queue "$DIAGNOSTIC_QUEUE_ID" > "$RUNNER_TEMP/queue-diagnostic-recheck.json"
    test "$(node scripts/issue248-queue-proof.mjs compare "$RUNNER_TEMP/queue-diagnostic-before.json" "$RUNNER_TEMP/queue-diagnostic-recheck.json")" = PATCH_ONCE || { echo 'QUEUE_PRE_PATCH_DRIFT' >&2; exit 1; }
    # Exactly one PATCH; any transport or provider failure is ambiguous.
    if ! curl -fsS --retry 0 --max-time 20 -X PATCH --header "@$header" -H 'Content-Type: application/json' --data '{"settings":{"delivery_paused":false}}' "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/queues/$DIAGNOSTIC_QUEUE_ID" > "$RUNNER_TEMP/queue-patch-response.json"; then
      echo 'QUEUE_PATCH_ACK_UNKNOWN: STOP; do not retry' >&2; exit 1
    fi
    jq -e '.success==true' "$RUNNER_TEMP/queue-patch-response.json" >/dev/null || { echo 'QUEUE_PATCH_ACK_UNKNOWN: STOP; do not retry' >&2; exit 1; }
  elif [ "$action" != ACTIVE ]; then
    echo 'QUEUE_STATE_UNCLASSIFIED' >&2; exit 1
  fi
  get_queue "$DIAGNOSTIC_QUEUE_ID" > "$RUNNER_TEMP/queue-diagnostic-verified.json"
  node scripts/issue248-queue-proof.mjs verify "$RUNNER_TEMP/queue-diagnostic-before.json" "$RUNNER_TEMP/queue-diagnostic-verified.json" >/dev/null
  echo 'QUEUE_EXPLICIT_ACTIVE_AND_CONFIG_READBACK; external/manual actor risk accepted but not fenced' >> "$GITHUB_STEP_SUMMARY"
  ;;
*) echo 'INVALID_QUEUE_PHASE' >&2; exit 1 ;;
esac
