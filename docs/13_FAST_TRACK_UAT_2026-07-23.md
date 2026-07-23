# MaliPang Fast-track UAT — 2026-07-23

## Scope and safety

- Current Worker only; `RUNTIME_MODE=shadow`
- Existing OpenAI credential was used without displaying, exporting, rotating, or replacing it
- LINE webhook and legacy Apps Script were not changed
- No Production deployment was performed
- Test records use `UAT` identifiers and LINE output is disabled inside the admin-only UAT harness
- UAT endpoints require both the Admin bearer token and `APP_ENV=uat` plus `RUNTIME_MODE=shadow`

## Attendance — 12 cases

| Case | Expected | Actual | Pass-Fail | D1 result | Sheets result | Note |
|---|---|---|---|---|---|---|
| UAT-A01 | iPhone-style valid IN | IN, 04:26 | PASS | New IN event | Raw/Daily/Weekly synced | Timestamp+GPS authoritative |
| UAT-A02 | iPhone-style valid OUT | OUT, 07:03 | PASS | New OUT event, daily v2 | Raw/Daily/Weekly synced | Same employee/work date |
| UAT-A03 | Android-style valid IN | IN, 17:33 | PASS | New IN event | Raw/Daily/Weekly synced | English month-first overlay |
| UAT-A04 | Duplicate message rejected | Existing message found | PASS | No new event | No new business row | Same message ID |
| UAT-A05 | Duplicate image rejected | Existing image hash found | PASS | No new event | No new business row | Different message ID |
| UAT-A06 | GPS missing rejected | `GPS_MISSING` | PASS | No event | No row | Android-style overlay |
| UAT-A07 | GPS missing rejected | `GPS_MISSING` | PASS | No event | No row | Android-style overlay |
| UAT-A08 | Stale iPhone timestamp rejected | `PHOTO_TIME_TOO_OLD` | PASS | No event | No row | Controlled received-time offset |
| UAT-A09 | Stale Android timestamp rejected | `PHOTO_TIME_TOO_OLD` | PASS | No event | No row | Controlled received-time offset |
| UAT-A10 | Outside-radius rejected | `OUTSIDE_STORE_RADIUS` | PASS | No event | No row | Controlled UAT radius boundary 10 m |
| UAT-A11 | Outside-radius rejected | `OUTSIDE_STORE_RADIUS` | PASS | No event | No row | Controlled UAT radius boundary 1 m |
| UAT-A12 | Missing punch retained for review | IN / `REVIEW` | PASS | IN only; no OUT | Daily/Weekly synced | Confirmed wage 0 |

Attendance result: 12/12 PASS. Valid cases accepted 100%; invalid cases rejected 100%.

## Expense — 10 cases

| Case | Expected | Actual | Pass-Fail | D1 result | Sheets result | Note |
|---|---|---|---|---|---|---|
| UAT-E01 | Cash quick save | `CONFIRMED`, cash | PASS | Confirmed then Undo → `CANCELLED` | Raw updated; daily cells cleared | Audit row retained |
| UAT-E02 | English cash quick save | `CONFIRMED`, cash | PASS | Confirmed | Raw + daily synced | `change` quick-save keyword |
| UAT-E03 | Transfer quick save | `CONFIRMED`, `SHOP_BANK` | PASS | Confirmed | Raw + daily synced | Thai `โอน` |
| UAT-E04 | Transfer waits for confirm | `WAITING_CONFIRM` | PASS | Draft only | No Sheet row | Not saved |
| UAT-E05 | Edit before save | category/date changed then `CONFIRMED` | PASS | Confirmed with edited values | Raw + daily synced | `equipment`, 2026-07-20 |
| UAT-E06 | Edit then cancel | `CANCELLED` | PASS | Audit row retained | No Sheet row | Never saved |
| UAT-E07 | Existing KBank slip rejected as duplicate | Reference matched prior record | PASS | No duplicate document/expense | No duplicate row | Visible amount 200 baht |
| UAT-E08 | Existing SCB slip rejected as duplicate | Reference matched prior record | PASS | No duplicate document/expense | No duplicate row | Visible amount 50 baht |
| UAT-E09 | Paotang/G-Wallet confirm | `SUCCESS`, gross 40, subsidy 24, paid 16 | PASS | `CONFIRMED`, 1,600 satang | Raw + daily synced | Actual paid amount is authoritative |
| UAT-E10 | Undo | `CANCELLED` | PASS | Original audit row retained | Raw status updated; daily cells cleared | Sync version 2 |

Expense result: 10/10 PASS after accepting `channel=G_WALLET` as the canonical Paotang signal. A normalization regression test now gives G-Wallet receipts a stable institution label.

## D1, Sheets, and payroll audit

- Attendance events created: 4 expected; invalid and duplicate cases created 0 extra events
- UAT payroll rows are unique by employee/work date
- Manual payroll example:
  - Daily wage: 500 baht
  - Late deduction: 20 baht
  - Early-out deduction: 30 baht
  - Expected: 450 baht
  - D1: 450 baht
  - `V52_DAILY_PAYROLL`: 450 baht
  - `V52_WEEKLY_PAYROLL`: 450 baht
- `WAITING_CONFIRM` and pre-save `CANCELLED` expenses did not appear in `V52_EXPENSE_RAW` or `รายวัน`
- Confirmed expense rows matched D1 in `V52_EXPENSE_RAW` and `รายวัน`
- Undo retained D1/Raw audit state and removed the live daily-sheet mapping

## Reconcile finding and fix

One reconcile request covered 2026-07-11 through 2026-07-23 and enqueued 59 idempotent jobs. The first run exposed Google Sheets per-user write quota exhaustion (`HTTP 429`) because jobs were released too quickly.

Fixes applied in Shadow Mode:

- Forced reconcile and recovery jobs are spread into groups of 5 per minute
- Google Sheets 429 errors retry after 60 seconds instead of consuming all retries immediately
- 5xx/timeout errors retry after 30 seconds
- Unit coverage verifies rate-limited scheduling and retry delay behavior

Recovery result:

- Sync jobs: 80 `COMPLETED`; 0 pending/processing/failed
- Failed-job audit: 25 `RESOLVED`; 0 open
- No D1 business event was lost

## Automated checks

- TypeScript typecheck: PASS
- Node tests: 103 passed, 3 live-only tests skipped in the standard CI command
- Wrangler dry run: PASS
- Live attendance image contract: 7/7 PASS
- `/admin/readiness` at 2026-07-23T12:45:06Z: D1, LINE, Google Sheets, R2, and attendance configuration PASS

## Final gates

- Valid attendance correct: 100% (Fast-track sample)
- Invalid attendance rejected: 100% (Fast-track sample)
- Lost UAT business event: 0
- Duplicate attendance message/image groups: 0
- Duplicate payroll keys: 0
- Duplicate finalized expense reference groups: 0
- Payroll manual calculation: PASS
- Unsaved expense absent from Sheets: PASS
- Undo audit trail and daily-sheet cleanup: PASS
- Reconcile recovery and readiness: PASS

## Production status

Not deployed to Production. Worker remains in Shadow Mode. LINE webhook and Apps Script remain unchanged.
