# Daily stable-identity cutover: draft, not a release procedure

The legacy writer gate is an opt-in stop control for code that contains it. It is not a Sheets lock, does not terminate previously dispatched requests, and does not apply to older deployments, Apps Script, other integrations or human editors. The stable writer is still synthetic-UAT-only. Do not use this document as authority to enable it in production.

## Preconditions for an eventual release

- Pass isolated end-to-end UAT with the production-equivalent Google API transport and a separate D1 binding, including full-month insertion, subtotal formulas, next-month preservation, duplicates, changed rows, timeouts, ambiguous responses and recovery. A unit/mock pass does not establish this.
- Independently inventory all writers and versions: queue and DLQ consumers, cron, admin endpoints, repair scripts, Apps Script, service-account credentials, integrations and human editors. Disable or technically exclude all non-participating writers. An editor attestation is not itself enforcement.
- Ship and verify an interim version that implements the gate, with the additive migration and a correctly scoped OPEN row. Confirm every active Worker version serving queue, cron and HTTP is that version; keep the stable writer and admission activation disabled. The migration, bindings and runtime checks must be verified in isolation before rollout.
- Establish a reviewable per-record plan for historic rows using independent identity evidence. An index, matching amount, date or description is insufficient. Unverified rows and ambiguous requests stay in REVIEW. The current draft does not implement production enrollment or a recovery UI.
- Complete stable identity and controlled transport for RAW, purchase detail and any other affected projections. This draft only exercises daily synthetic UAT and cannot replace the whole expense workflow.

## Controlled transition, after prerequisites are satisfied

1. Back up and independently verify the workbook and database; record deployment, spreadsheet and database identities, versions, permissions and ownership of the cutover.
2. Deploy the interim gate-capable code and verify every relevant runtime uses it. Enable the gate feature with an OPEN row for the exact workbook and sheet. An absent row, invalid flag value or unavailable gate read fails closed in gate-capable code. Older code does not honor this control.
3. Set that row to HOLD and verify it from the same production D1 binding. New expense queue messages are durably held as REVIEW before acknowledgement; already PROCESSING jobs are not reclaimed, and the direct daily and expense-reconciliation paths refuse new work. Re-read and monitor the outbox and open failure alerts throughout the transition.
4. Stop old code, disabled triggers, external writers and human edits with enforceable permissions and operational controls. Drain queue/DLQ, reconcile every PROCESSING or uncertain request and the sheet-wide fence, and independently prove no request dispatched before HOLD can still arrive. A lease expiry, empty queue, zero current traffic, or a single gate read is not by itself proof of quiescence.
5. Snapshot and reconcile each affected sheet against D1 and source evidence, including existing duplicates, metadata, formulas and monthly totals. Keep every unknown in REVIEW. Only after quiescence and reconciliation may an explicitly designed cutover transaction record the source watermark. The current `activateStableShadowCutover` is deliberately limited to synthetic UAT and cannot authorize production.
6. Exercise the approved production writer on a controlled transaction, verify the complete projection and reports, then release eligible held jobs using a separately reviewed, auditable recovery workflow. Resume authorized editing only under a protocol that prevents partial-range sorts and concurrent overwrite. The recovery workflow and production route do not exist in this draft.

If any observation is uncertain, retain HOLD and preserve outbox and intent records. Disabling the feature flag would bypass this gate; it is not a safe rollback while a transition is in progress. Restoring an older deployment also restores writers that do not honor the gate. Resolve in-flight outcomes and reconcile before any rollback or resume.
