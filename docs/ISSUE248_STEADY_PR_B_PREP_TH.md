# Issue #248 — PR-B (Steady-State) LOCAL PREPARATION ONLY

Status: **LOCAL RELEASE WORKFLOW IMPLEMENTED; AWAITING INDEPENDENT REVIEW / NO-GO FOR MERGE UNTIL APPROVAL**.
Source: reviewed post-caller main `c5941ea3f88456c1475f367fd5c650d75e24c05e`; diagnostic deploy receipt still binds its earlier exact source `c4b4ab96e2f2cb08a8633c003294375a0f458095`; the unchanged configuration baseline is PR #247 `4bb84a4869920f70981477de0ef69607438e2c74`. This draft needs independent review and exact-head validation.
Owner approval for this turn covers LOCAL preparation only. It does not authorize Push, PR creation, Merge, Deploy, Cron/Queue, D1, B1/C1, REVIEW claim release, or replay.

## Purpose and exact proposed diff
- `STABLE_RECOVERY_GATE_ENABLED` from `"true"` to `"false"`.
- Keep `STABLE_SHEETS_PACING_ENABLED: "true"` (do not delete, do not disable).
- Do not add `STABLE_SHEETS_READ_BUDGET_PER_MINUTE` without D-2 approval. Code default 55 reserved units/min and minimum spacing 75 sec are **unverified assumptions**, not Google quota evidence.
- No other runtime, financial, HR/payroll, LINE bot or Apps Script changes.

**Critical:** The manual-only fail-closed workflow is now drafted locally and requires independent Claude review and explicit Owner approval before any remote Push/Merge/Deploy. The prior G6a workflow must reject PR-B's gate-OFF config, and therefore is not an alternate release mechanism.

## Order — no merge before G7 passes
1. G0 external Writer Fence positive evidence and Owner presence.
2. G4/G5 `VERIFIED_COMPLETED` from original flags-OFF release with fresh verified private D1 backup.
3. PR-A merged and G6a ON/UNARMED, no new unrelated writers.
4. Owner-authorized G6b single RAW batch READY write/readback and exact D1 original-claim CAS changes=1.
5. One privately approved CONFIRMED Expense canary G7, real provider readback to DAILY/EXPENSE_RAW/DETAIL/FINAL, journal VERIFIED, job COMPLETED and epoch COMPLETE/CLOSED.
6. Only after distinct Owner G8 authorization, merge/rebase PR-B against actual post-G6a main and deploy gate OFF/pacing ON with manual workflow; no automatic merge.

## Required PR-B manual workflow preconditions (DoD before L1/G3)
- Exact main/branch, no runtime diff compared to pinned post-caller source `c5941ea3f88456c1475f367fd5c650d75e24c05e`; no concurrent Production workflow.
- Actual deployed 100% G6a Worker Version ID must equal exact Owner-reviewed input; do not assume the GitHub commit equals deployed Worker.
- R2 G5 durable release evidence: `VERIFIED_COMPLETED` with correct queue_id/source/old Worker, independently read back.
- Private G7 Owner-signed evidence with SHA-256 and exact provider readback; receipt must indicate no duplicate stable IDs, no 429 observed, expense source/version and payroll/LINE unaffected, and explicit permission to start paced G8 drain. Do **not** publish raw expense IDs, amount or token.
- D1 latest migration is precisely 0023 with all four tables. Exactly one finished Expense epoch COMPLETE/CLOSED, no ARMED/REVIEW epochs, no unverified admission, no HELD, no IN_FLIGHT, no workbook REVIEW; one matching COMPLETED sync job and verified DAILY, EXPENSE_RAW and all expected DETAIL projections.
- Read-only Google provider readback must prove stage-unique row identity against the approved canary. D1 counters alone are **not enough**.
- Active Queue with previous G5 queue ID; Cron canonical `*/5 * * * *`; current recovery gate OPT_IN and epoch COMPLETE/CLOSED; sheet pacing OPT_IN/valid.
- GCP Sheets API metrics must be observable. If missing, explicitly record UNKNOWN and block G8 unless Owner makes a separate risk decision under Issue #248.
- Manual confirmation and independent Claude review before Production workflow execution; no auto-release based only on checks.

## Post-deploy acceptance and STOP
- Before gate exit (B_PRE), require no REVIEW/HELD/IN_FLIGHT. **After gate exit (B_POST), permit at most one transient HELD claim and one IN_FLIGHT projection only if their source has an unexpired PROCESSING lease; never permit a REVIEW.** The claim table has no lease column: older-than-15min HELD is a conservative stale sentinel, not proof of an exact lease.
- Worker exactly one new 100% version, Gate DISABLED (literal `"false"`), Pacing OPT_IN/valid, Queue/Cron unchanged; no stale HELD, no unleased IN_FLIGHT or REVIEW.
- **Do not roll back blindly** after Gate exit: normal new jobs can start writing immediately. Owner must approve evidence-backed incident containment.
- During G7 and G8 STOP on the first provider 429, ambiguous write, new REVIEW, duplicate stable ID or unexpected OPEN failed job. Workers may internally retry one 429; check GCP API Metrics/Quotas, D1 errors/backoffs and Wrangler Tail.
- Observe a real new LINE/BackOffice transaction to D1 and Google Sheets without a manual Sync. Reconcile stable IDs, amounts, dates, HR/payroll and unattended job recovery. Do not assume that HTTP 200 or D1 COMPLETED alone is provider parity.
- Measure actual time-to-FINAL and backlog throughput before setting a speed target. DLQ 22 OPEN items remain HOLD per source and Owner decision (do not blanket replay).
- Soak for 7 days then request Owner final signoff; Issue #248 remains open until DoD.

## Remaining Local implementation before PR-B is Merge-ready
1. Obtain independent Claude review and correct findings in the newly drafted manual-only workflow, using the pure fail-closed `scripts/pr247-stage-guard.mjs` B_PRE/B_POST and read-only `scripts/pr247-readonly-snapshot.sh` already prepared in PR-A.
2. Add negative tests for source SHA drift, missing G7 private receipt, missing provider proof, wrong Worker/version, unclosed epoch, IN_FLIGHT, REVIEW/HELD, 429, duplicate stable-ID evidence and lost deploy ACK.
3. Run `npm run check`, `wrangler deploy --dry-run` and independent Claude exact-source review. No real provider writes in tests.
4. Await separate Owner L1/G3/G8 approvals, current Source of Truth/Control reconciliation, and proven operational Writer freeze.

**Current disposition: local workflow written, NOT RELEASE APPROVED. No PR-B Push/Merge/Deploy authorized.**

## Exact private G7 receipt required by the code-only G8 gate
The G8 operator must create and verify this record **only after a real G7 Canary** from the Owner-controlled, privately read-backed record. Never synthesize PASS evidence. Store under an Owner-approved private `release-control/pr247/g7/<safe-id>.json` key in R2 and independently verify its SHA-256; do not paste underlying IDs, employee/expense amounts or tokens into GitHub.

Mandatory fields are: `schema="MP248_G7_RECEIPT_V1"`, `state="OWNER_VERIFIED"`, `epoch_id` (exact completed D1 epoch), `g5_sha`, `g6a_worker_version`, `expected_detail_count>=1`, `g7_canary_verified=true`, `provider_readback_verified=true`, `no_duplicate_stable_ids=true`, `no_new_429_observed=true`, `gcp_quotas_checked=true`, `gcp_429_delta=0`, and `owner_approved_g8=true`.

The workflow verifies the receipt hash, D1 exact epoch identifier, complete/closed epoch state, matching COMPLETED job, verified DAILY+EXPENSE_RAW+all expected DETAIL journals, zero unverified epoch operations, unchanged release provenance, active Queue/Cron, no open REVIEW/HELD/IN_FLIGHT, and Gate ON/Pacing ON. The GCP measurements and provider readback are Owner-attested evidence and **cannot be proven solely by GitHub/D1**. Without independent provider access and an Owner-approved receipt, G8 remains NO-GO.

All Terminal DLQ jobs remain HOLD, not automatically replayed by this transition. If a first 429 or an ambiguous provider write appears, the workflow must report NO-GO and the Owner must perform separately approved incident containment; never blindly rollback an old Worker once Gate OFF has admitted new jobs.


## P2 hardening from independent Claude review
- B_POST accepts one in-progress HELD/IN_FLIGHT operation only when related PROCESSING lease is live and claim age is below 15 minutes; D1 and /admin status may be from different instants, therefore their inflight counts must each be within the single-writer bound but need not equal.
- Immediately before G8 deploy the reviewed workflow rereads exact 100% G6a Worker version, canonical Cron and active Queue. This reduces TOCTOU risk but is not proof of exclusive access.
- The GitHub environment presently has no required reviewer; Owner should configure a Required reviewer before Production releases, separately from local preparation and without relaxing any acceptance gate.

## G8 Queue delivery field after Wrangler deploy — bounded recovery and incident path

In the G6a deployment, Queue `settings.delivery_paused` was explicitly false before deploy and absent on list/detail readback afterwards; retention and consumer configuration were unchanged. Its provider semantics when omitted were not established. Wrangler 4.28.1's producer update sends a Queue PUT that omits that field. **Absence remains UNKNOWN**, not equivalent to false; the G8 pre/post guards continue requiring explicit false. The reviewed bounded remediation can perform one scoped PATCH only after its full preconditions; it never blindly resumes or replays Queue.

If bounded remediation stops, or the Queue field is still absent or explicitly true after its postcheck:
1. Stop the workflow and automatic recovery. Do not blindly retry the deploy, unpause or roll back a Worker after gate exit; a write may already be in flight.
2. Read exact Queue ID/name and settings via independent provider readbacks, actual 100% Worker version, Cron, recovery gate and current claim/journals; inspect current incident state and any other operator's pause or competing action. Obtain `G8_PRE_COMPLETED` and `G8_PRE_OPEN_FAILED` from the summary of the exact G8 run; preserve time, state and ACK evidence without credentials, financial values or PII. If the exact run and its baseline cannot be established, the missing baseline remains UNKNOWN.
3. Distinguish an actual explicit `true` pause from an omitted field; explicit `true` always stops the automated script. An omitted field authorizes its one scoped PATCH only if every scripted precondition holds. Only if the operator has independently established the purpose and ownership of any pause and determined scoped recovery is appropriate, make the separately controlled setting change with body limited to `settings.delivery_paused=false`, once; do not reset retention, consumers, DLQ, messages or replay. An ambiguous ACK is UNKNOWN and must not be retried blindly.
4. Independently verify Queue ID and explicit false, unchanged retention/consumer/DLQ, Worker, Cron and D1; then re-establish the full B_POST and observation evidence through a reviewed recovery path. This incident path is not a blanket authorization to relaunch G8, and count-only evidence is not provider parity.

The pre-deploy checks reduce drift and do not constitute exclusive control over all external operators. Even the manual read/patch sequence has a race without an actual fence; document any Owner-accepted residual risk honestly rather than labelling it a positive fence proof.
