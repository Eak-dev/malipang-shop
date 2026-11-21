# Scoped G7 owner receipt writer — LOCAL CANDIDATE

This candidate can write one strictly scoped, owner-attested V3 zero-item
receipt to `release-control/pr247/g7/receipt_<random nonce>.json`, after
validating the stored G7 ARM intent/outcome and hashes, and confirming the
destination is absent. It performs one PUT and one exact provider readback.
Lost or unclear acknowledgement is UNKNOWN and must never trigger blind retry.

The workflow only runs the writer for explicit `workflow_dispatch` on main.
The push-triggered registry job prints a message and does not write. The
dispatch pins reviewed main and uses the production release concurrency group.
The registration push is main-only and uses a separate concurrency group.
Neither workflow nor script observes Google Sheets, creates owner approval,
or establishes complete Google 429 monitoring. Its V3 boolean fields are
owner/risk attestations and must only be populated from actual evidence and
authorization. `limited_observed_429:false` requires evidence for the stated
partial GCP UI and Worker logs; UNKNOWN is not false.

R2 GET-before-PUT is not an atomic create against outside writers. The script
rejects concurrent or repeated use of a nonce within a process; a separately
reviewed persistent one-shot dispatcher, durable run-id recording, ACK-loss
reconciliation and controlled external-writer freeze remain required across
processes and GitHub runs. Do not dispatch this workflow until those controls and independent review are
completed. Merge remains subject to independent review and authorization. No
receipt was created during local development.

Only the new writer, workflow and tests are proposed. The adjacent copy of the
already merged `issue248-g7-audit.mjs` exists solely to run local tests and
must match the version used by the target branch.
