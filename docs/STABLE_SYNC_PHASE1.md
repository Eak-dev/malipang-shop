# Stable sync: first delivery

Goal: newly admitted expense and personal-use records use a stable identifier
to locate their destination, and stop for review on duplicate identifiers,
unverified prior data, provider uncertainty, or conflicting writes. A full
month is held for a person to add capacity; automatic expansion is deferred.
Historical rows without independently established identity are held.

Base: canonical main `7005538efe9a34a12e60a8bf7d027d0f8585bec8`.
The previous experimental branch is retained separately.

Current implementation is **not connected to production**: the daily-row
and ledger planners locate identifiers without storing a row, and the daily
planner holds a full month;
the workbook claim records an unresolved attempt without an expiry. A
transactional cutover snapshot can distinguish source IDs already present
from later inserts, and refuses activation with an incomplete snapshot.
An unrouted personal-use writer now checks the source and current sheet,
records a durable intent, writes once and verifies readback. Its local tests
mock Google; an uncertain result retains the claim. Removing an ID after a
verified write causes a review rather than a second append.
These components do not by themselves authorize a Google write. In particular, every
relevant writer must honor the claim, existing workers must be drained, and
the cooperative editor pause is still required.

Remaining for this delivery:

1. Admit only records proven new after the cutover, with a durable identity.
2. Wire expense, personal-use and purchase-detail paths to the shared claim,
   use identity-based reads and writes, and retain ambiguous outcomes.
3. Verify provider readback and totals before releasing the claim; implement
   an explicit review path for a retained claim.
4. Run the focused conflict, duplicate and uncertain-outcome checks; prepare
   backup and a rollback; drain the old deployment before the authorized
   production cutover. Verify a naturally occurring transaction afterward.

The local helpers and local tests are evidence of isolated behaviour only.
