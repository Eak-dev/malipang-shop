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

## P0 — Explicit DEV-only stable recovery / Sheets pacing (migration 0023)

**Authority:** Owner approved DEV_OWNED P0-a/P0-b/P0-c on 2026-11-06. This
section is a design and future operator runbook, not permission to execute a
Production change. Migration 0023 exists **only in source** until a separately
approved Production Change Issue, full verified backup, tests/UAT and release
gates are completed. Do not infer an approved Production configuration from
this document. The existing 2026-11-05 Incident B REVIEW claim is untouched.

### Flags and compatibility

- `STABLE_RECOVERY_GATE_ENABLED`: **absent** or `"false"` = disabled/default;
  `"true"` = exact-target canary only, fail closed without migration 0023
  and an active ARMED epoch. Unexpected values like `""`, `"TRUE"` or
  `"1"` block workbook writes, with `INVALID_CONFIG` in authenticated status.
- `STABLE_SHEETS_PACING_ENABLED`: **absent** or `"false"` = original behavior;
  `"true"` = D1-serialized projected-read reservation and Sheets-only
  throughput control, fail closed without migration 0023.
- `STABLE_SHEETS_READ_BUDGET_PER_MINUTE`: optional integer **52–60**,
  default **55**. Each workbook stage reserves **52 estimated Google read units**
  and must be spaced at least **75 seconds** from the previous admission.
  Excess pacing capacity means no notice or business write; the message is
  delayed using bounded exponential BUSY backoff with jitter.
  Invalid values block writes rather than silently disabling checks.

These are **conservative per-stage admission estimates**, not an exact count
of provider HTTP reads. The 52-unit budget does **not** prove a real stage will
never exceed provider quota or that other service-account users cannot consume
quota. Google API quota metrics and Cloudflare Workers plan remain necessary
before Production activation. With pacing on, idempotent GET 429/5xx does not
wait/retry inside the held workbook claim. A retryable notice GET failure
**provably before any provider mutation was authorized** can release only its
untouched HELD claim by guarded CAS and defer the job with backoff. A 429 after
any notice/business mutation may have started retains REVIEW for operator
verification; ambiguous mutations never receive blind retries.

### State and immutable history

Migration 0023 creates `stable_recovery_epochs` (append-only identity with
allowed forward state transitions), `stable_recovery_operations` (one ADMITTED
operation per epoch until verified), `stable_sheet_pacing` and an operational
busy-backoff counter. Epoch is exact workbook / entity type / entity ID / source
version; a different target cannot consume admission. The claim's
`spreadsheet_id` and unique operation token remain the global write fence.

An EXPENSE can run multiple *independently admitted* DAILY, RAW, DETAIL and
FINAL stages under the **same epoch**. Each stage first reserves D1 pacing,
then verifies a READY named-range pre-image under its own HELD claim; **only
inside that pre-POST mutation guard** does it atomically admit the exact
target. A GET 429/5xx before the guard returns safely with no ADMITTED stage.
After admission, the pause POST, projection and READY readback must complete
before the operation is marked VERIFIED. Any post-POST uncertain write retains
REVIEW and its ADMITTED operation. Only when the same
target reaches durable COMPLETED is the epoch marked COMPLETE; historical
operations/epoch identities remain retained. No automatic re-arm, no
timeout-based re-use, and no replacement of old epoch evidence. Unknown D1
acknowledgement or unknown Google mutation result retains the claim/review
boundary. A crashed or unverified ADMITTED stage requires *separate reviewed*
operator recovery, even if the original D1 lease expires.

### Future approved recovery sequence (NOT executed by this PR)

1. **READ-ONLY / No Production authorization required:** verify current
   deployed SHA, D1 migrations, the exact REVIEW claim token/stamp/identity,
   in-flight journals, active leases, stable IDs in every Sheet, QUEUE/DLQ
   state, outbox and LINE latency. Validate that the Nov 4 WAITING_CONFIRM
   THB 1,019 is excluded. Compare CONFIRMED D1 records against Daily/RAW and
   avoid broad `/admin/retry-sync`.
2. **OWNER DECISION GATE:** decide a low-impact recovery window, the exact
   canary Expense ID/version and a verified **full D1 backup** with checksum,
   local restore, integrity and FK checks. D1 SQL export has previously
   coincided with `D1_ERROR: Currently processing a long-running export` on
   active work; schedule backup carefully and monitor LINE/D1 effects.
3. **PRODUCTION-WRITE — SEPARATE OWNER APPROVAL:** deploy ONLY an approved
   commit/migration/config. Keep recovery gate fail-closed and pacing enabled
   before releasing a claim. An empty or malformed gate must not permit writes.
4. **PRODUCTION-WRITE — SEPARATE OWNER APPROVAL:** under an exclusive reviewed
   workbook handoff, record an audit intent, inspect B1/C1 named-range identity
   and structure, restore both to a verified READY pre-image in one Google
   batch operation, **read back**, then CAS-delete only the exact Incident B
   REVIEW claim using spreadsheet ID, token, old notice stamp/identity,
   recorded timestamp, zero IN_FLIGHT and zero active writers. Require
   exactly one affected claim. If provider acknowledgement is uncertain,
   stop; do not blindly write again or delete the claim. Reset B1/C1
   **before** removing the old REVIEW claim because the next
   `beginStableNotice` requires READY pre-image.
5. **PRODUCTION-WRITE — SEPARATE OWNER APPROVAL:** append a new ARMED epoch
   for ONE approved target and use a targeted, already-durable job delivery.
   While the exact-target gate is enabled, **only that ARMED target** may be
   re-enqueued by recovery cron (at most one eligible target per recovery tick,
   excluding terminal DLQ); unrelated Sheets and HR jobs stay in their durable
   outboxes. In a mixed LINE+canary queue batch, the target is re-sent after a
   short delay while LINE is prioritized; a canary later in a Sheets-only
   batch is selected ahead of unrelated writers. No arbitrary job should
   advance the canary. Staged expenses require separate verified operations
   with pacing gaps. If any new REVIEW, IN_FLIGHT, identity mismatch or
   unknown outcome occurs, stop and retain evidence.
6. **READ-ONLY:** confirm every stage journal VERIFIED, FINAL job COMPLETED,
   epoch COMPLETE, no duplicates or unexpected workbook writers, status READY,
   LINE intake/notifications healthy and HR outboxes durable.
7. **PRODUCTION-WRITE — SEPARATE OWNER APPROVAL:** retire canary gate only
   after reconciliation and **keep `STABLE_SHEETS_PACING_ENABLED="true"`**
   during the controlled drain. Cron then sends at most four recoverable Sheets
   jobs per five-minute tick, staggered by 90 seconds; staff config recovery
   admits at most one per tick. Under pacing, queue batch processing favors
   LINE; excess or mixed-batch Sheets deliveries are acknowledged **only**
   after their durable outbox is verified, to be recovered by cron.
8. **PRODUCTION-WRITE — SEPARATE OWNER APPROVAL:** selectively reconcile
   terminal DLQ / failed jobs by stable IDs and source status. The generic
   admin `/admin/retry-sync` excludes terminal DLQ **by default**; explicit
   `includeTerminalDlq:true` preserves the legacy ability to re-drive eligible
   Terminal DLQ jobs, subject to unchanged workbook REVIEW/Gate safeguards.
   This explicit option is **not an exact-ID tool** and may enqueue multiple
   terminal jobs; reconcile each candidate and obtain separate Owner approval
   before any Production use. Do not replay completed jobs or WAITING_CONFIRM
   transactions. Compare D1 = Daily = RAW
   counts/amounts/IDs and independent HR/payroll projections before
   declaring incident resolved.

**Stop/rollback triggers:** another REVIEW, any unresolved IN_FLIGHT, live
lease conflict, duplicate stable ID, provider mutation ack unknown, 429 after
notice write, elevated LINE reply latency, evidence that legacy Apps Script or
human editors bypass the lock, or an inability to verify the full backup.
Rollback of Worker code is **not** rollback of Google Sheets mutations;
forward-reconcile post-deploy transactions rather than restoring a stale whole
D1 snapshot. Production work requires a new explicit Owner Decision/Issue.

### Known trade-offs / follow-up

A single shared queue remains responsible for LINE and Sheets. Under the P0
pacing flag a mixed LINE+Sheets queue batch prioritizes LINE and leaves Sheets
in the durable outbox; this is safer for intake but can delay HR and accounting
projections. Full independence and strict per-request API quota accounting
require a P1 queue or separate consumer architecture. Monitoring must show
queue lag, Sheets admission timing, Google API 429, open DLQ, and time-to-final.

No auto-claim-release endpoint, remote migration command or secret is provided
by this implementation. A separate reviewed one-shot recovery tool/workflow
must be authorized before any actual Production repair.

### Pending Owner policy decisions before Production (not authorized in DEV_OWNED)

- **NM-1 — transient 5xx/429 during OPERATION or END_NOTICE:** the current
  P0 implementation intentionally retains the global claim in REVIEW after a
  PAUSED notice or business mutation might have been sent, even if a single
  Sheets GET fails transiently. Alternatives require separately reviewed
  safe-cleanup CAS/readback or a bounded 5xx-only GET retry. Neither policy
  change was approved for Production; do not weaken fail-closed semantics to
  make a test pass.
- **NM-3 — throughput/priority:** conservative minimum 75 seconds per
  workbook stage caps this component near **48 starts/hour** shared by
  Expense, Attendance, Payroll, Shift and StaffConfig projections. This is a
  safety-biased proposal and may increase HR/reporting lag. The Owner must
  explicitly approve acceptable time-to-final and priority/service targets,
  or authorize a separate queue/failure-domain design and TEST/UAT first.
- **Unresolved Production context:** the Google Sheets 429 root trigger,
  full service-account quota across other clients, Workers Free/Paid budget,
  and safe off-peak backup impact must be verified. This DEV-only PR is not
  evidence of Production readiness.
