# Stable sync: first delivery

Goal: newly admitted expense and personal-use records use a stable identifier
to locate their destination, and stop for review on duplicate identifiers,
unverified prior data, provider uncertainty, or conflicting writes. A full
month is held for a person to add capacity; automatic expansion is deferred.
Historical rows without independently established identity are held.

Base: canonical main `7005538efe9a34a12e60a8bf7d027d0f8585bec8`.
The previous experimental branch is retained separately.

Current implementation is **not connected to production**: the daily-row
planner can locate identifiers and identify capacity without storing a row;
the workbook claim records an unresolved attempt without an expiry. A
transactional cutover snapshot can distinguish source IDs already present
from later inserts, and refuses activation with an incomplete snapshot.
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
