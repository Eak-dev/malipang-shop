#!/usr/bin/env bash
# Read-only authenticated diagnostic. This is NOT an original-claim preimage,
# provider write/readback, CAS authorization, or replacement for G6b control.
set -euo pipefail
set +x
mode="${1:-}"
case "$mode" in PRE|POST) ;; *) echo NO_GO_MODE >&2; exit 2;; esac
test -n "${MALIPANG_ADMIN_TOKEN:-}" && test -n "${MALIPANG_WORKER_URL:-}" || { echo NO_GO_REQUIRED_ENV >&2; exit 2; }
[[ "$MALIPANG_WORKER_URL" =~ ^https://[^/[:space:]]+/?$ ]] || { echo NO_GO_WORKER_URL >&2; exit 2; }
[[ "$MALIPANG_ADMIN_TOKEN" != *$'\n'* && "$MALIPANG_ADMIN_TOKEN" != *$'\r'* ]] || { echo NO_GO_TOKEN_FORMAT >&2; exit 2; }
umask 077
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'Authorization: Bearer %s\n' "$MALIPANG_ADMIN_TOKEN" > "$tmp/auth-header"
url="${MALIPANG_WORKER_URL%/}/admin/stable-sync/notice-readiness"
# -f would discard 503, which intentionally represents ready=false OR error.
if ! http="$(curl --silent --show-error --retry 0 --connect-timeout 10 --max-time 20 --request GET --header "@$tmp/auth-header" --output "$tmp/body.json" --write-out '%{http_code}' "$url")"; then
  echo NO_GO_NOTICE_NETWORK_UNKNOWN >&2; exit 1
fi
# Only a single JSON object with exactly one boolean key is accepted.
if [[ "$http" == 200 ]] && jq -s -e 'length == 1 and (.[0] | type == "object" and keys == ["ok"] and .ok == true)' "$tmp/body.json" >/dev/null; then
  if [[ "$mode" == POST ]]; then
    echo NOTICE_READINESS_TRUE_POINT_IN_TIME_NOT_CAS_AUTHORIZATION
    exit 0
  fi
  echo NO_GO_PRE_NOTICE_ALREADY_READY >&2; exit 1
fi
if [[ "$http" == 503 ]] && jq -s -e 'length == 1 and (.[0] | type == "object" and keys == ["ok"] and .ok == false)' "$tmp/body.json" >/dev/null; then
  if [[ "$mode" == PRE ]]; then
    echo NOTICE_NOT_READY_OR_PROVIDER_UNAVAILABLE_NOT_PREIMAGE_PROOF
    exit 0
  fi
  echo NO_GO_POST_NOTICE_NOT_READY_OR_UNAVAILABLE >&2; exit 1
fi
echo NO_GO_NOTICE_RESPONSE_UNKNOWN >&2; exit 1
