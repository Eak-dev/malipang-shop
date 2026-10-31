# Validation, UAT และ operations

## Evidence rules

Each acceptance row records requirement ID, test ID, exact head, environment, synthetic/approved data, expected/actual, pass/fail/skip, timestamp and sanitized evidence URL. UNKNOWN is not PASS. Full source-to-target reconciliation is separate from sampled usability tests

For runtime code: focused regression while editing → `npm run check` → `npx wrangler deploy --dry-run` and required CI. Schema adds clean/old-shape/migration-rerun/integrity/FK/compatibility checks. No live calls to unblock skipped fixtures. Docs-only work validates links/scope/evidence; does not claim runtime/UAT completion

## Mandatory UAT matrix

| ID | Scenario | Expected proof |
|---|---|---|
| T01 | unknown/pending/inactive member; wrong LINE channel | no business data/action, safe login state |
| T02 | employee/branch tamper in list/detail/export/evidence; missing scope | no fields/aggregate/existence leak or side effect |
| T03 | revoke role while browser open; logout then different account | next request denied, private cache/draft not visible |
| T04 | same operation double click; changed payload same key | one effect; same receipt or 409 |
| T05 | network lost before/after commit | recover exact result; no false success/duplicate |
| T06 | same attendance via LINE and web including resized image | duplicate business effect prevented or ambiguous review; valid separate events preserved |
| T07 | stale/out-of-radius/missing overlay image; client clock changed | approved evidence validation unchanged; no payable event |
| T08 | simultaneous IN/OUT, missing OUT, overnight shift | correct approved ordering/date; missing punch not payable automatically |
| T09 | blank/zero/negative/unit error; two people edit count | correct validation; 409 conflict; no silent overwrite |
| T10 | physical count differs from ledger | observation retained; adjustment explicit and auditable |
| T11 | recipe version changes between plan and batch | historical batch/cost keeps selected version; no retroactive change |
| T12 | partial/duplicate/over receipt, return, changed pack size | one movement per receipt-line; no payment inferred |
| T13 | expense draft/confirm/undo and concurrent period close | no unconfirmed ledger effect; CAS/period rules hold |
| T14 | bank identity missing in history, personal return | unknown preserved; personal ledger excluded from P&L |
| T15 | changed wage/attendance after payroll preview; duplicate apply | stale preview refused; no duplicate payable effect |
| T16 | LINE quota/delivery fails, Sheets or queue dispatch fails | business receipt preserved; retry side effect only |
| T17 | paginated report/import with concurrent changes, moved/missing source row | complete snapshot or explicit incomplete/conflict; no silent omission |
| T18 | import twice, mixed legacy IDs, old writer after cutover | same totals/identity; old writer fenced; no second ledger |
| T19 | backup restore + rollback with post-cutover transactions | checksums/integrity pass; every valid delta preserved |
| T20 | phone UX: iOS Safari/LINE, Android Chrome/LINE | login, upload, numeric keyboard, zoom, recovery script pass |
| T21 | announcements XSS/audience/expiry | sanitized rendering; correct audience and effective version |
| T22 | disabling module or dependency during operation | no half-committed effect; visible pending/recovery state |
| T23 | actual vs derived sales/revenue, incomplete inputs | no fabricated sales/cash; labels and provenance correct |
| T24 | final retirement | zero unresolved scoped readers/writers; historical access and recovery documented |

## Release checklist

Owner reviews exact candidate and business behavior; all critical/high issues fixed; required checks and independent review passed on exact head; approved TEST UAT completed; scope/backups/rollback private evidence ready; feature enable list and target IDs verified without publishing secrets; explicit GO for actual deploy/merge/change. No release permission is implied by creating an Issue or this plan

## Operations and recovery

| Signal | Response | Owner-facing result |
|---|---|---|
| Receipt pending beyond measured normal SLA | trace processing/queue/lease and failure reason | real pending status; no repeated submission |
| Business commit succeeds, notification fails | replay notification intent only | record remains saved |
| Missing mirror/report range | reconcile authoritative records within bounded scope | stale/incomplete report until verified |
| Identity/permission mismatch | contain affected session/route under incident authority, preserve audit | no broad role reset |
| Financial/stock delta | stop affected cutover, determine source/error/expected amount | no automatic balance correction |
| Provider cost spike | inspect retry/dedup/call profile, disable only approved optional path | no silent model or validation downgrade |

Alert thresholds are configured after TEST baseline, not by arbitrary timeout increases. Proposed initial monitored metrics: operation latency p50/p95, oldest pending, error rate by stage, auth denials, duplicate prevention, unexplained variance, upload storage, AI calls/accepted operation. UI freshness timestamps mandatory

Availability/RPO/RTO targets are proposed business decisions: RPO 0 for acknowledged writes as a product requirement and recovery target ≤4 operating hours for critical intake. These are **not guarantees from D1 backups**; W13 must validate platform restore limits, redundant operation evidence/receipt capture, reconciliation and an Owner-approved downtime procedure. If target cannot be met, document measured gap and revise design/budget before approval, never claim PASS

Downtime procedure: stop ambiguous repeated submissions, retain receipt/evidence, Owner uses existing approved exception/correction process; no backdated web acceptance invented from phone time. After recovery reconcile missed/accepted events before payroll. Support log uses trace IDs only; private evidence access audited

After any authorized TEST session: verify AI/pilot flags, in-flight operations, payroll/accounting effects, queue/DLQ and private evidence cleanup status under retention policy; attach handoff. Do not delete evidence merely to make test environment look clean
