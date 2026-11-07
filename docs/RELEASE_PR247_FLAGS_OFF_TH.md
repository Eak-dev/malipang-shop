# PR #247 / PR #250 — Production flags-OFF release

**Status: DEV tooling under review / Production NO-GO.** This document is planning evidence, not authorization to execute a workflow. Source: PR #247 exact head 4bb84a4869920f70981477de0ef69607438e2c74, PR #250, Issue #248.

## Release authority

- Owner must separately approve G3 Merge of PR #247; merge of PR #250 has its own permission. Neither merge authorizes workflow execution.
- Owner must separately approve G4 Production migration 0023 and G5 Production Worker deploy, including Queue Pause/Resume and emergency re-pause. This manual workflow combines G4+G5 and must **not** run with only one gate approved.
- Absolutely no change to B1/C1, REVIEW claim, recovery flags, ARM epoch, retry-sync, terminal DLQ, payroll rules, LINE bot or other PRs.
- The existing original high-risk Acceptance Criteria remain; synthetic tests and local rehearsals do not imply Live End-to-End PASS.

## Critical G0 prerequisite — independent Cron and external writer fence

Production Worker currently runs */5 * * * * Cron. Pausing Queue does **not** pause scheduled Cron or administrative HTTP requests. The Cron maintenance source updates inbound event leases, payroll/wages, failed-job recovery, LINE notifications and D1 metrics.

This workflow **DOES NOT disable Cron**. Before Queue Pause, its hard read-only guard requires Cloudflare Worker schedules = empty. CRON_FENCE_NOT_VERIFIED means **STOP BEFORE PAUSE**; no export or migration permitted. A real Production Cron pause, validation and restoration require a **separate Owner-approved Production Config action**. This cannot be inferred from DEV_OWNED, D-1 or G4/G5 by default.

Owner must also authorize and provide evidence for a bounded **external writer / external admin** freeze, including possibly active administrative calls, other-owner Apps Script triggers and already-running Cron. The Cron readback and two D1 zero snapshots are point-in-time checks, NOT mathematical proof that external writers cannot race. Unknown external writers remain a NO-GO blocker.

## Exact preconditions

- Exact main SHA with PR #247 unchanged, only additive migration 0023 after 0022, no P0 recovery/pacing flags in code-only release.
- Prior Production Worker Version ID remains 310192aa-8a04-4b61-8a72-4455231b3339; any drift stops the workflow.
- One REVIEW claim, zero HELD and zero IN_FLIGHT, correct Workbook/Notice identity verified privately. The aggregate count alone is insufficient proof of identity.
- Queue malipang-jobs must be active before the release claims ownership. A pre-paused Queue belongs to an unknown operator and MUST NOT be resumed automatically.
- Verify exact Cloudflare account/Worker/D1/Queue/R2, token scope, fresh private backup restore and planned rollback. Keep LINE retention and staffing/HR timing within separately signed Owner limits.

## Controlled sequence — only after all release gates are approved

1. Validate source SHA, CI, Production D1 and existing REVIEW (read-only).
2. Verify Cron already disabled under separate authorization, Queue active, prior Worker Version ID exact.
3. Write private R2 release-control/pr247/<run_id>-<attempt>.json **PAUSE_INTENT** before changing Queue. Read the intent back independently. No Secret or PII in intent.
4. Pause Queue once; read back delivery_paused=true. Only then mark **PAUSE_CONFIRMED** in private R2. A lost ACK must remain ambiguous, never treated as success.
5. Drain active writers including inbound_events, sync_jobs, staff_config_sync_outbox and HELD claim; require at least **two consecutive quiet checks**.
6. Immediately before D1 Export verify Cron schedules empty and Queue paused again. STOP on CRON_FENCE_LOST or QUEUE_FENCE_LOST.
7. Private D1 backup → R2 → independent SHA-256 and Gzip readback → local SQLite restore/integrity/FK/0023 rehearsal. No full Production restore.
8. Reconfirm Cron and Queue fences, then apply only Production migration 0023, after separate G4 approval.
9. Deploy reviewed Worker with P0 flags OFF, REVIEW intact; read back **actual new Worker Version ID** and expected restored canonical Cron schedule. If Cron restoration fails, do not Resume Queue until independently authorized recovery.
10. Validate authenticated diagnostics: claim REVIEW, recoveryGate DISABLED, sheetPacing DISABLED, migration 0023, LINE /health. Configuration-only health is not proof of Sheets parity.
11. Persist **RESUME_REQUESTED** privately, Resume Queue, read back active Queue, then mark **RESUMED_VERIFIED**. The state record is never removed before post-resume checks.
12. During post-resume observation, check no unexpected new financial job COMPLETED, new failed job, HELD/IN_FLIGHT, or missing REVIEW. On invariant failure mark **POSTCHECK_FAILED**, re-pause Queue as an emergency action **only if preapproved under G4+G5**; verify readback, stop and alert Owner. This temporarily stops LINE delivery.
13. Mark **VERIFIED_COMPLETED** only after bounded D1 checks. D1 counters do not by themselves prove there were no third-party Google Sheets writes. Live accounting parity needs separate evidence before G6b/G7.

## Durable intent, Cancel, Timeout, lost ACK and runner death

Private R2 intent states: PAUSE_INTENT → PAUSE_CONFIRMED → RESUME_REQUESTED → RESUMED_VERIFIED → VERIFIED_COMPLETED; POSTCHECK_FAILED if post-resume verification fails. The record remains available if a CLI command loses its ACK, the job cancels or the runner is forcibly terminated.

The final GitHub step uses **if: always()** as a **best-effort** read-only incident reporter, not a guaranteed cleanup mechanism after a hard Timeout/force Cancel/runner loss. An external Owner-controlled incident operator must inspect the private R2 record and current Queue/Cron/Worker/D1 states before acting. An independently monitored watchdog is not yet implemented: **release stays NO-GO** without an approved manual response covering that gap.

For an ambiguous Pause ACK, PAUSE_INTENT means Queue may be active or paused. Never blindly resume. If another operator deliberately paused the Queue, do not overwrite their containment. For a post-resume mismatch the workflow attempts a bounded re-pause and preserves the audit state, requiring Owner-authorized incident control. Manual break-glass must recheck active Writer leases, retention and LINE backlog first.

Rollback must target an exact verified Worker Version, not merely whichever version Wrangler considers previous. Before G6b, safe rollback is conditional on the one REVIEW claim still blocking all workbook writes and compatible additive 0023. **After G6b, never blindly roll back the old Worker**; it does not honor recovery gate flags. First establish a separately approved break-glass REVIEW / writer containment and perform selective forward reconciliation. Never overwrite new D1 transactions with a stale full backup.

## Negative scenarios required for independent review

- Cron active → STOP before Queue Pause.
- Queue already paused → reject ownership; no automatic Resume.
- Pause succeeded remotely but CLI lost ACK → private PAUSE_INTENT survives; manual decision.
- Inbound LINE in-flight, StaffConfig or HELD → block Export.
- Cron or Queue fence disappears before Export/Migration → STOP.
- Cancel, Timeout and runner kill → independent private intent remains; no false promise of automatic cleanup.
- Unexpected Worker Version or restored Cron mismatch → STOP.
- post-resume financial/HR invariant failure → POSTCHECK_FAILED, contingency re-pause only when approved.
- Runtime source drift or unapproved G3 → reject. No test/acceptance weakening.

## Remaining Owner Decisions

Release NO-GO until independently verified Cron/HTTP/legacy external-writer freeze, real identity, cancellation/runner recovery ownership and exact G4+G5 emergency re-pause scope are approved. D-2 pacing budget, D-3 STOP/SLA and canary, D-4 terminal DLQ policy, high-risk full-test equivalence and G6a–G9 remain separate decisions. The private G2 restored-copy rehearsal and live integration evidence remain outstanding.

**This DEV PR did not execute any Production change.**
