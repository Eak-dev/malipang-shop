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

This system affects real employee attendance, payroll, expenses and business records. Correctness, auditability, safe rollback and operational clarity are more important than cleverness, speed or broad refactoring.

## Source of truth

- D1 is the operational source of truth for the V5.2 backend.
- Google Sheets is a reporting and operational interface, not the primary database or calculation engine for V5.2.
- R2 evidence must remain private.
- The V5.2 core runtime in this repository is Cloudflare Workers and uses the Google Sheets Direct API. Core processing must not depend on Apps Script.
- Legacy Apps Script workflows may still exist outside this repository or as spreadsheet-bound projects during migration. Treat them as external legacy dependencies until their deployments and triggers are inventoried.
- Do not add new Apps Script dependencies, modify legacy Apps Script code, disable triggers, delete legacy sheets or remove legacy deployments without an explicit task and owner approval.

## Evidence hierarchy

When sources disagree, prefer evidence in this order:

1. Current Production state
2. Current D1 records and authoritative runtime data
3. Exact deployed SHA and runtime configuration
4. Current canonical `main`
5. Automated tests reproducing the behaviour
6. Current Google Sheets operational/reporting data
7. Current runbooks/documentation
8. Issue or pull request descriptions
9. Historical chat, screenshots or assumptions

Never mutate Production only because documentation says it should look different. Investigate the discrepancy first.

## Task authority and scope

The task must state one authority mode. If it does not, use `REVIEW_ONLY`.

- `REVIEW_ONLY`: inspect, diagnose, test locally and propose changes only.
- `DEV_OWNED`: implement, test, commit, push and open a pull request. Merge and Production release still require explicit authorization.
- `AUTO_RELEASE`: only when the owner explicitly grants it for the named task. Codex may merge and release after every release gate passes.

Before editing, record the acceptance criteria, affected systems, risk level and explicit out-of-scope items. Do not broaden scope or refactor unrelated code; record useful follow-up ideas as backlog instead. Explicit task authority overrides the default Git merge/deploy restrictions below, but never overrides safety invariants, privacy rules, secret handling or destructive-change gates.

## Developer decision authority

Codex should decide without asking the owner when the decision is an implementation detail that preserves approved behaviour, including:

- internal naming and module/file organization
- type design and test structure
- error handling
- retry/backoff implementation within existing policy
- performance optimization that preserves behaviour
- bug fixes whose expected behaviour is already documented or evidenced
- backward-compatible refactors required to complete the task
- documentation corrections that match verified Production behaviour

Codex must stop and request owner input when the decision would change:

- payroll calculations, payable amounts or wage policy
- attendance business rules
- expense/accounting policy
- employee authorization policy
- data-retention policy
- Production infrastructure architecture with material blast radius
- destructive or irreversible data behaviour
- LINE webhook ownership/cutover
- any business behaviour that cannot be inferred safely from approved requirements or stronger evidence

Do not escalate routine engineering choices to the owner.

## Required reading

Always read:

1. `AGENTS.md`
2. `README.md`
3. `docs/07_ARCHITECTURE_AND_OPERATING_MODEL_TH.md`
4. Documentation directly relevant to the affected subsystem

Read the following only when the task can affect them:

- `docs/01_SETUP_TH.md` for setup/environment work
- `docs/02_SHEET_MAPPING_TH.md` for Google Sheets mapping or writes
- `docs/03_TEST_AND_CUTOVER_TH.md` for test/cutover work
- `docs/04_OPERATIONS_TH.md` for operational procedures
- `docs/05_LINE_FLEX_FLOW_TH.md` for LINE interaction changes
- `docs/06_LEGACY_APPS_SCRIPT_STATUS_TH.md` for legacy Apps Script dependencies
- `docs/08_RELEASE_AND_CUTOVER_PLAN_TH.md` for Production release/cutover
- `docs/09_OWNER_ACTION_CHECKLIST_TH.md` when owner action is actually required
- `docs/10_CODEX_TASK_TEMPLATE_TH.md` when creating or normalizing Codex tasks

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

## Test requirements by change type

- Identity or authorization: positive, negative, privilege-escalation and idempotency tests.
- Attendance, payroll or expense: regression, duplicate-protection and failed-notification tests.
- Google Sheets: column mapping and formula-safe write tests.
- Schema migration: clean database, Production-shaped database, retry/idempotency and integrity tests.
- LINE interaction: Reply-first behaviour and notification-recovery tests.
- Queue/recovery changes: retry, replay, duplicate-protection and DLQ observability tests.
- Configuration changes: default, invalid-config and backward-compatibility tests.

## Environment boundaries

- Local/Test is for typecheck, automated tests, local D1 and dry-run only.
- Shadow/UAT may connect to real services but must use approved users, explicit flags and documented test cases.
- Production changes require a separate Production Change issue, exact commit SHA, UAT evidence, backup, rollback plan and explicit owner approval unless the named task explicitly grants `AUTO_RELEASE`.
- Merging a pull request does not authorize Production deployment unless the named task explicitly grants `AUTO_RELEASE`.

## Production safety

Never:

- Commit secrets, tokens, private keys or Production credentials
- Print secrets in logs, test output or error messages
- Deploy directly to Production without task authority that explicitly permits it
- Run remote D1 migrations without task authority that explicitly permits it
- Delete or overwrite Production D1 data without an exact approved destructive operation
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

## Privacy and Production data

Never expose raw LINE user IDs, private evidence URLs, access tokens, personal staff/customer data or Production payloads in chat, logs, screenshots, test fixtures, pull requests or issues. Use sanitized counts, masked identifiers and redacted examples. Admin endpoints that return operational diagnostics must not return raw identity identifiers unless an explicitly approved incident procedure requires it.

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

## Idempotency default

Every externally triggered write path should be retry-safe by default, especially:

- LINE webhook events
- Queue jobs
- Google Sheets synchronization
- Staff imports
- Attendance writes
- Expense confirmation
- Identity approval
- Shift generation
- Recovery and replay operations

A retry must not create a second business transaction. If full idempotency is impossible, document why and add an explicit guard and reconciliation step.

## Side-effect isolation

Business transaction success must not depend on optional notification or reporting success.

- Attendance, Expense, Payroll, Staff and Identity commits must have retry/idempotency boundaries separate from LINE notification and Google Sheets reporting.
- A failed LINE notification must not cause the underlying business transaction to execute again.
- A failed Sheets mirror must not invalidate an already committed D1 business transaction.
- Recovery/replay must target the failed side effect, not replay the business transaction unless that transaction is proven absent.

## Root-cause gate

Do not patch symptoms when the underlying failure is still unknown.

Before implementing a bug fix, establish and record:

- `OBSERVED`
- `EXPECTED`
- `REPRODUCTION`
- `ROOT_CAUSE`
- `AFFECTED_PATH`
- `DATA_IMPACT`

If the root cause cannot yet be proven, continue read-only investigation. Do not mutate Production merely to discover the root cause.

## Change discipline

For every task:

1. Restate the problem and acceptance criteria.
2. Inspect the relevant implementation and tests.
3. Identify the root cause before editing for bug-fix work.
4. Classify the change as Low, Medium or High risk.
5. Classify any external mutation level.
6. Make the smallest complete change.
7. Add or update regression tests.
8. Run all required checks.
9. Summarize risks, assumptions and remaining limitations.
10. Provide manual UAT and a rollback procedure.

Avoid unrelated refactors. Do not rewrite working modules merely to make them look cleaner.

## Mutation classification

Classify every external mutation before execution:

- `L0` — Local-only changes and tests
- `L1` — Git branch, commit, push, PR metadata
- `L2` — Reversible non-business Production configuration
- `L3` — Reversible Production business-data mutation
- `L4` — Schema migration, payroll, identity or historical-data mutation
- `L5` — Destructive or irreversible mutation

Authority rules:

- `REVIEW_ONLY`: no mutation beyond safe local/read-only inspection.
- `DEV_OWNED`: may perform L0-L1 only unless the named task explicitly authorizes a higher level.
- `AUTO_RELEASE`: may perform authorized L0-L4 after all required gates pass.
- L5 always requires explicit owner approval for the exact mutation, even under `AUTO_RELEASE`.

## Production blast-radius gate

Before any Production mutation determine:

- records affected
- users affected
- systems affected
- whether historical data changes
- whether the operation is idempotent
- whether retry can duplicate business effects
- rollback/forward-fix mechanism
- observable success signal
- observable failure signal

If the blast radius cannot be bounded, do not execute the mutation.

## Database migration gate

Production migrations must be additive where practical, idempotent and retry-safe. Before applying one:

1. Create a fresh private backup.
2. Verify its download checksum.
3. Restore it locally.
4. Run an integrity check.
5. Record before counts for every affected entity.
6. Apply the migration to the restored Production-shaped database.
7. Verify retry/idempotency behaviour.
8. Run foreign-key validation.
9. Record expected after counts.
10. Prepare a rollback or forward-fix plan.

Do not rewrite immutable raw evidence without explicit approval; preserve it and add a safe relational resolution path instead.

## Canonical Main Gate

Before ANY code or repository mutation, Codex must prove that the task branch originates from the latest canonical `main` of `Eak-dev/malipang-shop`.

Required sequence:

1. Inspect:
   - `git status --short`
   - `git branch --show-current`
   - `git remote -v`
2. Identify the remote that points to the canonical repository `Eak-dev/malipang-shop`.
3. Fetch the latest canonical `main`.
4. Verify the worktree is clean before switching branches or fast-forwarding.
5. Switch to local `main`.
6. Fast-forward local `main` to the fetched canonical `main` using `--ff-only`.
7. Record the canonical `main` SHA used for the task.
8. Create a new task branch from that exact synchronized SHA.
9. Only after steps 1-8 succeed may implementation or repository mutation begin.

Do not assume the canonical remote is named `origin`.

If `origin` points to the canonical repository, the normal sequence is:

```bash
git fetch origin main
git switch main
git merge --ff-only origin/main
```

If `origin` does not exist, inspect other remotes and use one only if it is verified to point to `Eak-dev/malipang-shop`.

If no canonical remote is available:

- `REVIEW_ONLY` may continue read-only and must state that remote synchronization could not be verified.
- `DEV_OWNED` and `AUTO_RELEASE` must not edit code or mutate repository contents.
- Report the blocker.

If local changes or divergent history prevent a safe fast-forward:

- do not use `git reset --hard`
- do not automatically rebase
- do not overwrite user changes
- do not force push
- stop the mutation path and report the blocker

## Git workflow

- One task per branch.
- One task per pull request.
- Use branch names such as:
  - `codex/fix-<short-name>`
  - `codex/feature-<short-name>`
  - `codex/test-<short-name>`
  - `codex/docs-<short-name>`
- Do not push directly to `main`.
- Do not merge the pull request unless the task explicitly grants `AUTO_RELEASE` authority and required checks are green.
- Keep commits focused and reversible.
- Do not rewrite existing history.
- Start from a GitHub issue using the repository issue forms whenever possible.

## Dependency policy

Do not add or upgrade a dependency when the task can reasonably be completed with the existing stack.

For every new Production dependency verify:

- why it is required
- maintenance status
- license compatibility
- security implications
- bundle/runtime impact

Never perform broad dependency upgrades as part of an unrelated fix.

## Backward compatibility

Prefer additive, backward-compatible changes.

For high-risk behavioural changes, prefer feature flags, shadow evaluation or staged rollout when practical.

Do not remove the previous working path in the same release unless:

- the replacement is verified
- rollback is documented
- the task explicitly requires cutover

## Pull request requirements

Every pull request must include:

- Problem being solved
- Root cause or design rationale
- Acceptance criteria
- Scope and explicit out-of-scope items
- Risk classification and mutation level
- Canonical `main` SHA used as task base
- Files changed
- Behaviour before and after
- Tests executed and results
- Security, payroll, accounting and data risks
- Migration or configuration changes
- Rollback or forward-fix procedure
- Remaining limitations
- Manual UAT checklist
- Confirmation of the task authority mode
- Confirmation that merge/deploy authority follows that mode

## Production reconciliation

A successful API response, migration command or deployment is not sufficient evidence of success.

After any Production business-data mutation verify, as applicable:

- intended writes
- actual D1 writes
- Sheets mirror/reconciliation state
- Queue state
- failed jobs
- duplicate state
- lost-record state
- affected authorization/identity state
- affected historical references

Expected unexplained values:

- `LOST = 0`
- `DUPLICATE = 0`

Do not declare `PRODUCTION_FIXED` until reconciliation passes or the exact remaining degraded side effect is explicitly documented and the core business transaction is proven correct.

## Incident mode

For a Production incident prioritize:

1. Contain
2. Preserve evidence
3. Determine business-data impact
4. Find root cause
5. Implement the smallest safe fix
6. Test
7. Release when authorized
8. Reconcile
9. Document follow-up

During an incident, do not perform unrelated refactors, dependency upgrades or architecture redesigns.

## Stop conditions

Do not stop for:

- routine implementation decisions
- naming or file placement
- test failures that can be diagnosed safely
- lint/type errors
- transient API failure with a safe retry path
- PR review feedback
- merge conflicts that can be resolved without changing business semantics
- missing optional enhancement
- documentation inconsistency that can be resolved from stronger evidence

Stop and request owner input only for a true blocker such as:

- unclear business rule affecting money, payroll or employee rights
- destructive/irreversible Production mutation not explicitly authorized
- unverifiable identity mapping
- backup/restore integrity failure
- unavailable required credential or permission
- Production state contradicting assumptions in a way that risks data loss
- security incident requiring owner awareness
- no safe rollback or forward-fix path

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

For an authorized Production release, also require:

- Exact merged and deployed SHA plus Worker version recorded
- CI, dry-run, backup/restore and migration validation passed where applicable
- Health, readiness, affected D1 records and Sheets reconciliation passed
- No new unexplained lost, duplicate or failed jobs
- Sanitized release evidence posted to the related issue or pull request

## Communication

When requirements are ambiguous:

- Do not invent payroll, attendance, accounting or Production rules.
- State the ambiguity explicitly when it is material.
- Prefer the safest reversible implementation when a decision is unavoidable and does not change business policy.
- Record assumptions in the pull request.
- Do not assume a legacy Apps Script project is inactive merely because V5.2 is receiving events. Verify LINE webhook configuration, Apps Script deployments and installed triggers first.

The repository owner makes the final decision on Production behaviour, business rules, destructive mutations, webhook changes, legacy shutdown and deployment authority. Within approved scope, Codex is expected to own routine engineering decisions and complete the task end-to-end according to the selected authority mode.
