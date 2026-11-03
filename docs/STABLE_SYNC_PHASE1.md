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
