# Issue #296 — VIEWS incident recovery (20 November 2026)

## Root cause and verified evidence

The original VIEWS request did write all four sheets, but the Worker failed its exact formula readback. Google Sheets canonicalizes six quoted references to the ASCII-only legacy tab name, removing optional single quotes around V52_EXPENSE_RAW. The resulting RAW view formula is otherwise byte-identical and evaluates to Expense_ID, with no calculation error. The detail view formula matches exactly.

Read-only provider inspection proved both new 1,000-row ledgers contain the expected headers, every RAW (999 × 17) and DETAIL (999 × 20) formula, valid unique row-number-bound Z markers (999 per ledger), no unintended inputs or populated formula outputs, and the two combined spill headers.

Actual provider markers reconstructed the **exact original batchUpdate requests**. All four archived D1 request digests and the complete manifest SHA-256 matched. This is full source/intent integrity evidence, not only sample cells.

Production D1 retains VIEWS=IN_FLIGHT, operator REVIEW and workbook claim REVIEW/CONTINUOUS_CUTOVER_REVIEW. Never replay VIEWS.

## Narrow forward fix, no destructive repair

Migration 0062_views_incident_recovery.sql adds an immutable attestation table and extends the existing operator-update trigger with one narrow REVIEW -> HELD transition. It is allowed only with the pinned historical VIEWS manifest digest, an immutable provider attestation, the same operation token, a VERIFIED VIEWS attempt and a HELD claim. All other operator transitions and history-retention triggers are unchanged.

Temporary flag CONTINUOUS_VIEWS_INCIDENT_RECOVERY_ENABLED=true enables a separately owner-triggered RECONCILE_VIEWS action through the existing authenticated, version-pinned Cutover endpoint. That action:

1. Verifies the exact one-time operator/claim/VIEWS IN_FLIGHT state, no processing work and no unknown financial writes.
2. Re-reads the actual paused Google Sheets notice, all 1,000 rows of each helper, marker uniqueness, all template formulas and both view headers/formulas.
3. Reconstructs the original Google requests from provider Z markers, then checks every archived request and manifest SHA-256.
4. Re-reads provider metadata/notice and performs one atomic D1 batch recording an immutable attestation, setting only VIEWS to VERIFIED, claim to HELD and operator to HELD.
5. Independently reads D1 status back. On any uncertain outcome, STOP without automatic retry.

The action creates no Google tabs and does not rerun START_REVIEW. Subsequent calls are rejected by the one-time preimage and append-only evidence.

## Controlled production sequence

- Keep every external/manual/Apps Script writer fenced. Retain the pre-VIEWS and post-VIEWS private Google backups.
- Review this narrow incident change and CI. Take a fresh D1 backup with checksum and restore-test.
- Merge PR only after acceptance. Apply migration 0062 through the guarded release workflow after exact ledger-head preflight, before deploying Worker; do not retry an uncertain migration.
- Deploy exact merged SHA with the one new temporary recovery flag. Read back single 100% Worker version and matching hash.
- Run protected, manual RECONCILE_VIEWS with true owner, provider and external-writer attestations, then read D1 and Google state independently.
- Resume DAILY_J only after VIEWS VERIFIED and claim/operator HELD, followed by REPORTS, ACTIVATE and RELEASE, each with its own guarded approval/readback.
- Validate the two privately stored CANCELLED expense IDs again before ACTIVATE.
- After RELEASE, stage6 Canary must disable the cutover operator, prewrite-review and this temporary incident recovery flag before enabling Continuous Daily. The original unmodified PR304 flags remain unsafe.

## Non-negotiable guards

Never drop triggers in a live ad-hoc query, edit D1 statuses by hand, delete/recreate the four carrier/view sheets, or replay the failed VIEWS request. The recovery applies only to the pinned historical manifest and claim token.

GitHub Issue #296 is the public audit; private expense IDs, claim tokens and source-account credentials are never posted there.
