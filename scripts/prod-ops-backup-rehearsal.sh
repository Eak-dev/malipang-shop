#!/usr/bin/env bash
# Exports Production D1 (read), restores it on the runner and rehearses the
# pending migrations on that copy. A private R2 backup object is written ONLY
# when BACKUP_TO_R2=true; its key is d1/ops-rehearsal/<run id>-<attempt>.sql.gz.
# WARNING: per Cloudflare's D1 docs a running export blocks other database
# requests, so run this only in an approved quiet window.
# The repository is public. Output is limited to PASS/FAIL/SKIPPED per step and
# migration file names: no sizes, checksums, table or row counts, row data or
# raw tool output. Error text is reduced to letters before printing.
set -euo pipefail
test -n "$CLOUDFLARE_ACCOUNT_ID" && test -n "$CLOUDFLARE_API_TOKEN"
umask 077
T="$RUNNER_TEMP"; sql="$T/before.sql"; gz="$T/before.sql.gz"; dl="$T/downloaded.sql.gz"; db="$T/restored.sqlite"
# Remove every dump and scratch file on any exit, including a failure midway.
cleanup(){ rm -f "$sql" "$gz" "$dl" "$db" "$db-journal" "$T/retry.sqlite" "$T/retry.sqlite-journal" "$T/counts-before.txt" "$T/counts-after.txt" "$T/err.txt"; }
trap cleanup EXIT
key="d1/ops-rehearsal/${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.sql.gz"
backup="${BACKUP_TO_R2:-false}"
case "$backup" in true|false) ;; *) echo "- backup_flag: INVALID"; exit 1;; esac
q(){ sqlite3 "$db" "$1"; }
pf(){ if [ "$1" = 1 ]; then echo PASS; else echo FAIL; fi; }
echo "## Backup and migration rehearsal"
npx wrangler d1 export malipang-v5-2 --remote --output="$sql" >/dev/null 2>&1 || { echo "- export: FAIL"; exit 1; }
gzip -c "$sql" > "$gz"; gzip -t "$gz"
echo "- export: PASS"
sum="$(sha256sum "$gz" | cut -d' ' -f1)"
if [ "$backup" = true ]; then
  npx wrangler r2 object put "malipang-private-backups/$key" --file="$gz" --remote >/dev/null 2>&1 || { echo "- backup_upload: FAIL"; exit 1; }
  npx wrangler r2 object get "malipang-private-backups/$key" --file="$dl" --remote >/dev/null 2>&1 || { echo "- backup_download: FAIL"; exit 1; }
  gzip -t "$dl"
  test "$sum" = "$(sha256sum "$dl" | cut -d' ' -f1)" || { echo "- backup_checksum: FAIL"; exit 1; }
  echo "- backup_upload: PASS (key from this run id)"
  echo "- backup_checksum: PASS"
else
  cp "$gz" "$dl"
  echo "- backup_upload: SKIPPED"
fi
gzip -dc "$dl" | sqlite3 -cmd "PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;" "$db" >/dev/null 2>&1 || { echo "- restore: FAIL"; exit 1; }
echo "- restore: PASS"
echo "- integrity_before: $(pf "$( [ "$(q 'PRAGMA integrity_check' | head -1)" = ok ] && echo 1 )")"
echo "- foreign_keys_before: $(pf "$( [ "$(q 'SELECT count(*) FROM pragma_foreign_key_check')" = 0 ] && echo 1 )")"
echo "- ledger_head: $(q 'SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1' | grep -E '^[0-9]{4}_[a-z0-9_]+\.sql$' || echo UNKNOWN)"
tables="$(q "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name")"
counts(){ for t in $tables; do echo "$t=$(q "SELECT count(*) FROM \"$t\"")"; done; }
counts > "$T/counts-before.txt"
failed=""; applied_names=""
for f in $(ls migrations/*.sql | sort); do
  name="$(basename "$f")"
  if [ "$(q "SELECT count(*) FROM d1_migrations WHERE name='$name'")" != 0 ]; then continue; fi
  if sqlite3 -bail "$db" "BEGIN;" ".read $f" "INSERT INTO d1_migrations(name) VALUES('$name');" "COMMIT;" >/dev/null 2>"$T/err.txt"; then applied_names="$applied_names $name"; else failed="$name"; break; fi
done
echo "- migrations_applied_on_copy:${applied_names:- none}"
if [ -n "$failed" ]; then echo "- migration_failed: $failed"; echo "- error_class: $(head -c 400 "$T/err.txt" | tr -c 'A-Za-z_ .:\n' ' ' | tr -s ' ' | head -2 | tr '\n' ' ')"; exit 1; fi
counts > "$T/counts-after.txt"
# counts() reuses the pre-migration table list, so both files list the same
# tables in the same order. Rows must not change; d1_migrations gains ledger rows.
unchanged="$( [ "$(grep -v '^d1_migrations=' "$T/counts-before.txt")" = "$(grep -v '^d1_migrations=' "$T/counts-after.txt")" ] && echo 1 || true )"
echo "- preexisting_rows_unchanged: $(pf "$unchanged")"
echo "- integrity_after: $(pf "$( [ "$(q 'PRAGMA integrity_check' | head -1)" = ok ] && echo 1 )")"
echo "- foreign_keys_after: $(pf "$( [ "$(q 'SELECT count(*) FROM pragma_foreign_key_check')" = 0 ] && echo 1 )")"
echo "- no_activation_rows: $(pf "$( [ "$(q "SELECT (SELECT count(*) FROM continuous_daily_cutovers)+(SELECT count(*) FROM continuous_undo_serialization_activation)+(SELECT count(*) FROM continuous_cancel_financial_activation)")" = 0 ] && echo 1 )")"
# Second application of each pending file on a throwaway copy: informational.
cp "$db" "$T/retry.sqlite"; nonidem=""
for name in $applied_names; do
  sqlite3 -bail "$T/retry.sqlite" "BEGIN;" ".read migrations/$name" "COMMIT;" >/dev/null 2>&1 || nonidem="$nonidem $name"; done
echo "- not_reapplicable_without_ledger:${nonidem:- none}"
# Statements shaped like the currently deployed Worker's writes, rolled back.
smoke(){ if sqlite3 -bail "$db" "PRAGMA foreign_keys=ON;" "BEGIN;" "$2" "ROLLBACK;" >/dev/null 2>"$T/err.txt"; then echo "- smoke_$1: PASS"; else echo "- smoke_$1: FAIL $(head -c 200 "$T/err.txt" | tr -c 'A-Za-z_ .:\n' ' ' | tr -s ' ' | head -1)"; smoke_failed=1; fi; }
smoke_failed=0
clone(){ echo "CREATE TEMP TABLE t AS SELECT * FROM $1 $3 LIMIT 1; UPDATE t SET $2; INSERT INTO $1 SELECT * FROM t; SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('x','\$') END; DROP TABLE t;"; }
smoke expense_insert "$(clone expense_events "expense_id='smoke-exp',message_id='smoke-msg',status='WAITING_CONFIRM'" "")"
smoke expense_confirm_cancel "UPDATE expense_events SET status='CANCELLED',version=version+1,updated_at='now' WHERE expense_id=(SELECT expense_id FROM expense_events WHERE status='CONFIRMED' ORDER BY created_at DESC LIMIT 1); SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('x','\$') END;"
smoke document_insert "$(clone expense_documents "document_id='smoke-doc',message_id='smoke-docmsg'" "")"
smoke document_update "UPDATE expense_documents SET status=status,updated_at='now' WHERE document_id=(SELECT document_id FROM expense_documents ORDER BY created_at DESC LIMIT 1); SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('x','\$') END;"
smoke sync_job_insert "$(clone sync_jobs "job_id='smoke-job',entity_key='smoke-key',status='PENDING'" "")"
for s in FAILED REVIEW COMPLETED; do smoke "sync_job_to_$s" "UPDATE sync_jobs SET status='$s',last_error='SMOKE' WHERE job_id=(SELECT job_id FROM sync_jobs WHERE status='PENDING' LIMIT 1); SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('x','\$') END;"; done
# Change every column of UNIQUE(queue_name,trace_id,job_key) target so the
# cloned row cannot collide with an existing failure.
smoke failed_job_insert "$(clone failed_jobs "id='smoke-failed',trace_id='smoke-trace',job_key='SMOKE:smoke:1',status='OPEN',error='DEAD_LETTER_MAX_RETRIES'" "")"
smoke failed_job_resolve "UPDATE failed_jobs SET status='RESOLVED' WHERE id=(SELECT id FROM failed_jobs WHERE status='OPEN' LIMIT 1); SELECT CASE WHEN changes()=1 THEN 1 ELSE json_extract('x','\$') END;"
smoke claim_touch "UPDATE stable_workbook_claims SET updated_at=updated_at; SELECT CASE WHEN changes()>=1 THEN 1 ELSE json_extract('x','\$') END;"
smoke projection_insert "$(clone stable_projection_writes "entity_id='smoke-exp'" "WHERE entity_type='EXPENSE'")"
echo "- smoke_all: $(pf "$( [ "$smoke_failed" = 0 ] && echo 1 )")"
test "$smoke_failed" = 0
