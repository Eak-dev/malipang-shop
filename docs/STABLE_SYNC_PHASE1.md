# Stable sync: phase 1 (not deployed)

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

Do not activate merely because local tests pass. Release requires: current
canonical main and exact merged SHA; CI and dry-run; private D1 backup verified
by checksum, local restore, integrity and foreign-key checks; migration on a
restored production-shaped database with retry; a visible and structurally
verified notice and named ranges in the live workbook; pause queue delivery,
drain old in-flight writers and provider requests; apply migration, atomically
snapshot all existing source IDs and activate; deploy the approved flag-enabled
version; verify configuration, health and queue/claim status, then resume delivery.
Verify the first naturally occurring transaction without creating fake records.
No production business record should be created or edited for testing.

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
