# Stable sync: phase 1

Authority: owner-approved production release after the essential data-safety
checks. Base: canonical main `7005538efe9a34a12e60a8bf7d027d0f8585bec8`.
Scope: new expense and personal-use projections; stable IDs rather than
remembered row positions; stop on duplicates, conflicting content or uncertain
provider response. Existing sources at cutover are held for manual review.
Month capacity exhaustion is held for manual insertion before the subtotal and
manual formula/total checks. Automatic expansion and general historical
reconciliation remain out of scope.

Implementation connects new financial jobs and legacy sheet/staff jobs to a
shared durable claim. The claim is retained on uncertainty. Before a write the
system displays a visible cooperative edit pause and waits 15 seconds; Google
Sheets does not provide a compare-and-swap lock and editors must respect the
notice. Expense projections are journaled and read back; monthly formulas and
totals are verified before claim release. Personal-use projections are also
journaled and verified. The capacity resume endpoint is restricted to the
specific safe, no-write capacity state. Automatic release of uncertain claims
is intentionally absent: investigate them before any controlled recovery.

Production release on 2026-11-03: merged source
`b0a0f3182924bec6a8d3b39f96a5d5c315d91713`, Worker version
`d60a28aa-acc1-4017-b6f2-fba554711933`, migration 0021, cutover ACTIVE.
The private D1 backup was checksum-verified, restored and validated before
migration; the Owner Master was copied before setting up the two status ranges
on the frozen first row of `รายวัน`. Delivery was drained, paused, and resumed.
The release health and notice-readiness checks passed. Immediately afterward,
no workbook claim, pending/review sync job, or open failed job was present.
No naturally occurring new financial transaction was available at release, so
end-to-end D1-to-Sheets verification of the first such transaction remains open.
The first release attempt stopped before migration due to an unsupported
Wrangler option; the old deployment and DB were confirmed and delivery resumed
before the command was corrected and the release repeated.

## Day-to-day operation

Keep `รายวัน` open with the frozen first row visible. When the status reads
`พักแก้ไฟล์`, wait until it returns to `พร้อมแก้ไข` before editing the workbook.
Refresh a stale or offline browser view. This is a cooperative notice, not an
atomic Google Sheets lock; concurrent edits or external uncoordinated writers
can still cause conflicts. If the notice stays paused or indicates review,
inspect the protected admin status endpoint and contact the operator. Do not
clear the workbook claim or manually replay a possibly dispatched write.

For a capacity-only hold, an operator adds blank rows before the correct month's
subtotal, preserves/copies needed formulas, and verifies subtotal ranges include
them. After checking the exact expense ID and version, and only for a
`STABLE_DAILY_CAPACITY` hold, the operator may use the authenticated
`POST /admin/stable-sync/resume-capacity` with `expenseId` and `version`. The
endpoint rejects ambiguous claims and previous write intents. The next attempt
rechecks the sheet; it may hold again if formulas or structure are unsafe.
Existing source IDs captured at cutover are not automatically reconciled.

New expenses are synchronized in short stages: daily, expense RAW, each
purchase-detail item, then a final read-only verification of every projection.
Each stage releases the workbook and requeues the existing job; no new business
transaction is created. Source fingerprints and verified journals carry
forward between stages. If an editor changes an earlier projection, a source
changes, an identifier is duplicated, or a write acknowledgement is uncertain,
the operation stops for review instead of replaying a possible write. A brief
ready period between stages means the final verification is required before a
job is complete. Large itemized receipts can take several minutes to finish.
The staging keeps each invocation within the Cloudflare free-plan 50 external
subrequest limit; it does not add month rows automatically.

## Review claim diagnostics and blocking (migration 0022)

A claim moved to `REVIEW` records `phase` (`BEGIN_NOTICE`, `OPERATION`,
`END_NOTICE` or `RELEASE`) and a short sanitized `review_reason`, for example
`STABLE_NOTICE_READ:HTTP_429` or `SHEETS_MUTATION_OUTCOME_UNKNOWN:TIMEOUT`.
Provider bodies, identifiers and free-form messages are never stored. The
Worker also logs `stable-workbook-review` with the same phase and reason.
`GET /admin/stable-sync/status` returns both fields and the count of
`IN_FLIGHT` projection intents. A phase of `END_NOTICE` with no `IN_FLIGHT`
intent means every business projection of that operation was already verified
and only the notice reset failed; it still requires the reviewed recovery
below, because automatic release is not part of this change.

While a claim is in `REVIEW`, workbook deliveries are acknowledged without a
re-send and without taking a job lease or spending an attempt; the durable
`sync_jobs` and staff outbox rows are kept unchanged. Scheduled recovery and
`/admin/retry-sync` re-send nothing until the claim is resolved, then the first
recovery run re-sends the waiting jobs. A held (non-review) claim still causes
the existing 30-second busy re-send.

Idempotent Sheets reads (GET only) are retried once after a 429 or 5xx,
honouring `Retry-After` up to 30 seconds (20 seconds without it; 2 seconds for
5xx). Mutations are never retried. The notice pre-image is read inside the
dispatch fence, so a pause uses 6 reads and a ready reset 4 reads instead of 8
and 6.

Release order: apply migration 0022 before deploying the Worker. Older Worker
versions never use the new columns; if the Worker runs first it still moves a
failed claim to `REVIEW`, just without diagnostics.

The release runs only through the manual workflow
`production-stable-review-diagnostics.yml`, after owner approval in a
Production Change issue. It verifies that the runtime source equals reviewed
commit `e3b7ab8`, takes and restores a checksum-verified private backup, pauses
delivery until no active lease or held claim remains, applies 0022, deploys,
checks the new status fields, and resumes delivery. If it fails before the
deploy starts, it resumes delivery on the unchanged Worker. It never changes a
workbook claim; an existing `REVIEW` claim needs the separate reviewed recovery.

Forward-fix / rollback: pause delivery and preserve queue messages, inspect
claim, journals, source revisions and Sheets for every uncertain operation.
Never automatically clear a claim or retry an uncertain provider write. Rolling
back the Worker cannot undo Sheet writes; reconcile each unresolved item first.
The cutover snapshot and journal are immutable and are not cleared to enable a
retry. Restore backup only under a separately verified incident procedure to
avoid discarding post-backup business events.

Follow-up: automatic row expansion and adjustment of formulas/references;
identity reconciliation of pre-cutover records; more granular revision tracking
(the global source revision can safely hold a sync if an unrelated source
changes concurrently); operator tooling for reviewed ambiguous operations.
