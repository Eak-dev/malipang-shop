# Legacy report source validation: coverage and release gaps

Status: experimental read-only components, **not connected to a release gate**.
There is no approved production formula policy, provenance manifest, complete
row reader, or monitor in this change. A successful comparison against supplied
inputs does not authenticate those inputs or prove the report is safe.

The formula/protection reader requests exactly `04_OWNER_MONTH_CLOSE!C24:C35`
and `97_EXPENSE_CLEAN!A2`, plus protected-range metadata for those two tabs and
`รายวัน`. It rejects malformed formula shapes, duplicate sheet IDs and changes
between two reads. Its ports match the existing Sheets formula and protection
readers; it has no default live bindings. The validation component compares a
separately supplied, reviewed formula digest and independently sourced row
provenance, and checks the proposed trusted source columns X:Y and those formula
cells have the required protection. Protection metadata alone is not a verdict.

Before any production use, all of the following need implementation and review:

1. Establish a versioned, independently approved formula policy. Confirm every
   report consumer and dependency, including legacy formulas that read daily
   category/description directly, `97_EXPENSE_CLEAN`, modern raw/clean sources,
   other reporting tabs, formulas outside the 12 category cells, and formulas
   or named ranges that could indirectly feed them. Pin exact reviewed formulas
   and trusted-source locations. The current production formulas do not meet
   the proposed X:Y source policy; no digest in this change approves them.
2. Build a complete bounded row reader using verified grid dimensions, reading
   all cells and formulas that influence each legacy report rather than assuming
   blank trailing API rows prove no data. Distinguish literal zero, blanks,
   formulas and errors. Detect dimension changes, missing ranges, truncation,
   duplicate metadata, insertion, deletion and unrecognized formulas; fail
   closed. Prove `hasFinancialData` covers every relevant historical row.
3. Reconcile each relevant row to D1 using a durable independently verified row
   identity, or to a specific owner attestation for manual legacy entries.
   Detect missing, duplicate, ambiguous and conflicting associations, including
   category and description disagreements. Do not treat the currently displayed
   values or a bulk snapshot of them as proof of prior approval.
4. Test the exact formula migration and protections on an isolated copy against
   all relevant months, category totals, overlapping historical keyword rules,
   transaction details, current reports and exception rows. Confirm that
   approved changes and all supported posting, cancellation, sync and cross-month
   operations maintain the trusted inputs without affecting unrelated records.
5. Verify protection metadata and access for every relevant source and formula,
   including groups, domain access, warning-only rules and unprotected holes.
   An owner can override protections; monitor formula, protection, identity and
   source drift and suspend the feature when a check fails. Recheck immediately
   before any use: two reads cannot create a lock or close a subsequent race.
6. Add mock and isolated-service tests for independent formula/permission drift,
   missing and incomplete reads, provenance omissions and conflicts, row inserts
   and concurrent edits. Perform operational review, backup, restore and rollback
   rehearsal before any decision to connect this component to production.

The existing isolated-sheet experiment preserved the compared report values for
seven historical months and all 1,255 clean rows when switching sources. It also
tested a direct category edit and one inserted row. That is useful feasibility
evidence, not proof of complete reconciliation, concurrency safety or release
readiness. The test copy's experimental changes were restored.
