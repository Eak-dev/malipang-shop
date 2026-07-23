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

Do not change these rules unless the task explicitly updates the product requirement.

## Expense invariants

Expense changes must preserve these rules:

- Unconfirmed expenses must not be written as finalized expenses.
- Undo must preserve the audit trail.
- Bank transfers use `SHOP_BANK`.
- Duplicate slip detection remains active.
- Failed or incomplete slip validation must not create a finalized expense.
- Google Sheets formula columns must not be overwritten.

## Change discipline

For every task:

1. Restate the problem and acceptance criteria.
2. Inspect the relevant implementation and tests.
3. Identify the root cause before editing.
4. Make the smallest complete change.
5. Add or update regression tests.
6. Run all required checks.
7. Summarize risks, assumptions and remaining limitations.

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

## Pull request requirements

Every pull request must include:

- Problem being solved
- Root cause or design rationale
- Files changed
- Behaviour before and after
- Tests executed and results
- Security, payroll, accounting and data risks
- Migration or configuration changes
- Rollback procedure
- Remaining limitations
- Manual UAT checklist

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

## Communication

When requirements are ambiguous:

- Do not invent payroll, attendance, accounting or production rules.
- State the ambiguity explicitly.
- Prefer the safest reversible implementation when a decision is unavoidable.
- Record assumptions in the pull request.
- Do not assume a legacy Apps Script project is inactive merely because V5.2 is receiving events. Verify LINE webhook configuration, Apps Script deployments and installed triggers first.

The repository owner makes the final decision on production behaviour and deployment.