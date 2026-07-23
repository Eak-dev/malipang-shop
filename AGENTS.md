# AGENTS.md — MaliPang Backend

## Project purpose

This repository contains MaliPang Backend V5.2, a Cloudflare Workers backend for:

- LINE OA webhook processing
- Employee attendance
- Daily and weekly payroll
- Expense capture and confirmation
- Image classification and structured extraction
- D1, Durable Objects, Queues, DLQ and R2
- Google Sheets reporting

This system affects real employee attendance, payroll, expenses and business records. Correctness, auditability and safe rollback are more important than cleverness or broad refactoring.

## Source of truth

- D1 is the operational source of truth for the V5.2 backend.
- Google Sheets is a reporting interface, not the primary database or calculation engine for V5.2.
- R2 evidence must remain private.
- The V5.2 core runtime in this repository is Cloudflare Workers and uses the Google Sheets Direct API. Core processing must not depend on Apps Script.
- Legacy Apps Script workflows may still exist outside this repository or as spreadsheet-bound projects during migration. Treat them as external legacy dependencies until their deployments and triggers are inventoried.
- Do not add new Apps Script dependencies, modify legacy Apps Script code, disable triggers, delete legacy sheets or remove legacy deployments without an explicit task and owner approval.

## Required reading

Before changing code, read:

1. `README.md`
2. `docs/01_SETUP_TH.md`
3. `docs/02_SHEET_MAPPING_TH.md`
4. `docs/03_TEST_AND_CUTOVER_TH.md`
5. `docs/04_OPERATIONS_TH.md`
6. `docs/05_LINE_FLEX_FLOW_TH.md`
7. `docs/06_LEGACY_APPS_SCRIPT_STATUS_TH.md`
8. `docs/07_ARCHITECTURE_AND_OPERATING_MODEL_TH.md`
9. `docs/08_RELEASE_AND_CUTOVER_PLAN_TH.md`
10. `docs/09_OWNER_ACTION_CHECKLIST_TH.md`
11. `docs/10_CODEX_TASK_TEMPLATE_TH.md`

Then inspect only the additional files relevant to the assigned task.

## Runtime and tooling

- Node.js 22 or newer
- TypeScript
- Cloudflare Workers
- D1
- Durable Objects
- Queues and DLQ
- R2
- Google Sheets API
- LINE Messaging API
- OpenAI structured vision extraction

Install dependencies with:

```bash
npm ci
```

## Mandatory validation

After modifying code, run:

```bash
npm run check
npx wrangler deploy --dry-run
```

Do not claim completion unless both commands pass. When relevant, also run the task-specific test suite documented in `README.md`.

Do not run live integration tests, remote database migrations or a real deployment unless the task explicitly authorizes them.

## Environment boundaries

- Local/Test is for typecheck, automated tests, local D1 and dry-run only.
- Shadow/UAT may connect to real services but must use approved users, explicit flags and documented test cases.
- Production changes require a separate Production Change issue, exact commit SHA, UAT evidence, backup, rollback plan and explicit owner approval.
- Merging a pull request does not authorize production deployment.

## Production safety

Never:

- Commit secrets, tokens, private keys or production credentials
- Print secrets in logs, test output or error messages
- Deploy directly to production without explicit owner approval
- Run remote D1 migrations without explicit owner approval
- Delete or overwrite production D1 data
- Delete R2 evidence
- Weaken LINE signature verification
- Bypass admin authorization
- Disable idempotency or duplicate protection
- Remove audit trails
- Change payroll rules silently
- Overwrite Google Sheets formulas outside documented writable cells
- Modify or disable legacy Apps Script projects, deployments or triggers before verified cutover and explicit owner approval
- Change the LINE webhook without a documented cutover and rollback plan

Use mock or local values for tests.

## Attendance invariants

Attendance changes must preserve these rules:

- Official time comes only from the white Timestamp + GPS overlay.
- The physical shop clock is supporting shop-location evidence, not the payroll time source.
- GPS radius and photo-age checks remain enforced.
- LINE redelivery and duplicate Message IDs must not create duplicate attendance.
- Concurrent IN/OUT events remain safely ordered.
- Missing punches must not become payable payroll automatically.
- Admin corrections must create an audit trail.

Do not change these rules unless the task explicitly updates the product requirement and the owner approves the business-rule change.

## Expense invariants

Expense changes must preserve these rules:

- Unconfirmed expenses must not be written as finalized expenses.
- Undo must preserve the audit trail.
- Bank transfers use `SHOP_BANK`.
- Duplicate slip detection remains active.
- Failed or incomplete slip validation must not create a finalized expense.
- Google Sheets formula columns must not be overwritten.

## Data and reliability invariants

- Lost event must remain zero.
- Duplicate finalized attendance, payroll and expense must remain zero.
- Sheets reconcile must rebuild reporting from D1 without creating new business transactions.
- Queue retry and DLQ behaviour must remain observable.
- R2 evidence keys must not be exposed as public permanent URLs.
- Schema changes require versioned migrations and a rollback or forward-fix plan.

## Change discipline

For every task:

1. Restate the problem and acceptance criteria.
2. Inspect the relevant implementation and tests.
3. Identify the root cause before editing.
4. Classify the change as Low, Medium or High risk.
5. Make the smallest complete change.
6. Add or update regression tests.
7. Run all required checks.
8. Summarize risks, assumptions and remaining limitations.
9. Provide manual UAT and a rollback procedure.

Avoid unrelated refactors. Do not rewrite working modules merely to make them look cleaner.

## Git workflow

- One task per branch.
- One task per pull request.
- Use branch names such as:
  - `codex/fix-<short-name>`
  - `codex/feature-<short-name>`
  - `codex/test-<short-name>`
  - `codex/docs-<short-name>`
- Do not push directly to `main`.
- Do not merge the pull request.
- Keep commits focused and reversible.
- Do not rewrite existing history.
- Start from a GitHub issue using the repository issue forms whenever possible.

## Pull request requirements

Every pull request must include:

- Problem being solved
- Root cause or design rationale
- Scope and explicit out-of-scope items
- Files changed
- Behaviour before and after
- Tests executed and results
- Security, payroll, accounting and data risks
- Migration or configuration changes
- Rollback procedure
- Remaining limitations
- Manual UAT checklist
- Confirmation that merging does not authorize production deployment

## Definition of done

A task is complete only when:

- Acceptance criteria are satisfied
- Regression tests exist where appropriate
- `npm run check` passes
- `npx wrangler deploy --dry-run` passes
- No secrets are committed
- No unrelated files are changed
- Documentation is updated when behaviour or configuration changes
- The pull request is ready for independent review
- Manual UAT and rollback steps are specific enough to execute

## Communication

When requirements are ambiguous:

- Do not invent payroll, attendance, accounting or production rules.
- State the ambiguity explicitly.
- Prefer the safest reversible implementation when a decision is unavoidable.
- Record assumptions in the pull request.
- Do not assume a legacy Apps Script project is inactive merely because V5.2 is receiving events. Verify LINE webhook configuration, Apps Script deployments and installed triggers first.

The repository owner makes the final decision on production behaviour, business rules, migrations, webhook changes, legacy shutdown and deployment.