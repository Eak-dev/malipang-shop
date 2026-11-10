# Issue #248 — G6a Local preparation (NOT Production authorization)

Status: LOCAL_ONLY / DEV PREP / DO NOT MERGE BEFORE VERIFIED G5.
Baseline: Eak-dev/malipang-shop main at `0d1dda77f3a0e5cfaec1872cb588b59dddfe5bdf`.
Authority: Owner approved local work only (steps 1–4); PR-A does not authorize Push, Merge, migration, deploy, claim release or Queue/Cron changes.

## Why this PR must be staged after G5
`.github/workflows/production-pr247-flags-off-release.yml` checks that wrangler.jsonc is identical to the reviewed #247 source and that no P0 gate or pacing flags are present. Merging PR-A prematurely makes G4/G5 refuse to run. Hold PR #252 and any other runtime PR until G5 VERIFIED_COMPLETED.

## Exact config-as-code change
- `STABLE_RECOVERY_GATE_ENABLED: "true"`
- `STABLE_SHEETS_PACING_ENABLED: "true"`
- No explicit `STABLE_SHEETS_READ_BUDGET_PER_MINUTE` while D-2 remains unapproved. The current source default is 55 estimated read units/minute with at least 75 seconds between workbook operations; this is an unverified estimate, not measured GCP quota.
- Existing LINE bot model, accounting rules, migration, Cron, Queue and all other config remain unchanged.

## G6a manual workflow: intended future release
1. Owner separately approves G6a only after G4/G5 R2 receipt shows VERIFIED_COMPLETED, Worker deployed and Queue/Cron restored.
2. Workflow requires exact current main SHA, G5 SHA, run ID/attempt, exact G5 Worker version and a typed Owner confirmation. It verifies R2 G5 receipt, migration 0023 with all four tables, one original REVIEW, no HELD/IN_FLIGHT or epoch, Gate/Pacing DISABLED, exact 100% Worker, active Queue and canonical Cron.
3. It performs a code deploy of the reviewed flags ON (no migration, B1/C1 write or Queue replay). After deployment it requires Gate UNARMED, Pacing UNARMED, original REVIEW retained, no new financial job COMPLETED or OPEN failed job, and same Queue/Cron.
4. On lost deploy ACK or uncertain outcome: STOP, read back exact Worker, D1, REVIEW, Cron/Queue and release evidence; no automatic rollback. Rollback to exact G5 Worker is allowed only while original REVIEW remains and only with separate Owner authorization.
5. G6b still requires approved single Google RAW batch, independent provider readback and exact original-token/stamp/identity CAS. G7 still requires one approved private canary, no broad replay.

## Scope and tests
- Only wrangler.jsonc (two flags), this manual workflow, one read-only snapshot helper, a pure validation helper, focused synthetic regression tests, and this document.
- No new UAT infrastructure or live integration test.
- For LOCAL validation: `npm ci`, `node --test tests/pr247-stage-guard.test.mjs`, `npm run check`, `npx wrangler deploy --dry-run`, syntax/negative tests and independent Claude source review.
- The read-only snapshot helper is present for future authorized GitHub workflow use. It is not run against Production while preparing this PR.

## Limitations and future approvals
- G0 external Admin/D1 writer exclusion remains NO-GO until owner inventory and evidence; G5 can only run after this is resolved.
- Mac Cron Guard is UNARMED; it cannot restore a paused Queue if the Runner dies.
- Cloudflare 429 root cause and actual GCP quota remain UNKNOWN. G7 must establish real provider write parity before PR-B is considered.
- Confirm actual G6a prior Worker version and G5 R2 receipt at release; do not pin a guessed future Worker version.
