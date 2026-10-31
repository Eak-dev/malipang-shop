# Durable execution state and handoff contract

This is a schema/runbook with an initial planning snapshot. It is not an active job, automation or claim that Codex is running after the conversation ends

## Initial state — 2026-09-08 prompt-authoring round

| Field | Value |
|---|---|
| Program | MPW / Epic #175 |
| Current activity | DOCUMENTATION_UPDATE — master execution prompt and readiness contracts |
| Runtime implementation | NOT_STARTED / BLOCKED_BY_LEGACY_DECOMMISSION |
| Authority actually exercised | DEV_OWNED docs/planning metadata L0–L1 |
| Production/TEST external changes | NONE |
| Program execution mandate submitted | NOT RECORDED — writing the prompt is not dispatch |
| Main baseline | 597b8d0f016f2cabb9656a8a54b6356ff5d565fc |
| Existing planning PR | #193; current head must be fetched, not hard-coded from this snapshot |
| Next action on mandate submission | revalidate W00/readiness, then all eligible planning tasks; implement only after gates |
| Unverified items | actual cloud/LINE/data/device readiness as listed in 15_READINESS_AND_OWNER_ACTIONS.md |

## Required checkpoint fields

Use an append-only progress entry or reviewed update under this document's execution log section / the owning Issue. Keep an index to latest checkpoint in Epic; do not duplicate 17 competing global state files

```yaml
checkpoint_id: unique operation/session checkpoint reference
checked_at: timestamp with timezone
epic: 175
authority_source: actual Owner message or approved GitHub decision
authority_mode: actual mode, not inferred from desired outcome
phase: planning/test/release/observation
state: RUNNING or BLOCKED_ACCESS or BLOCKED_POLICY or BLOCKED_GATE or WAITING_OWNER or PAUSED_LIMIT or COMPLETED
base_sha: canonical source baseline
docs_sha: exact planning/contract commit
task_id: current W-number and Issue
branch: actual branch
head_sha: actual latest tested commit
worktree: clean or preserved dirty-path summary
completed_acceptance: requirement-to-evidence references
checks: command, exact head, result, skip reasons
readiness: VERIFIED/MISSING/INACCESSIBLE/UNKNOWN/NOT_REQUIRED deltas
approvals: approved target, scope, version, remaining conditions
pending_owner_actions: only concrete action IDs with prepared instructions
in_flight: receipts, queues, draft/financial state and data source confidence
rollback: verified plan/version or UNKNOWN
next_action: one exact allowed action, prerequisites, expected proof
remaining_scope: modules/features/gates not yet delivered
saved_remotely: true only after readback verification
```

Do not include secret values, PII, raw staff identifiers or private backup URLs in a public checkpoint. Sensitive evidence stays in approved private storage with sanitized references. If data cannot be queried under authority, in_flight=UNKNOWN rather than 0

## Work loop and progression

1. Read latest control + checkpoint + current Issue/PR changes; verify head and actual gate state
2. Choose a ready task whose dependencies/authority are satisfied; record why it is eligible
3. Work to the next verifiable milestone; fix concrete regressions before claiming task-ready
4. Publish focused PR/evidence; group ordered integration requests when merge is required
5. Complete other authorized independent work while approvals are pending; do not rework completed artifacts to fill time
6. Update checkpoint and read back; progress to the next eligible task under the same submitted program mandate

Unmerged dependent PRs may block the next canonical-main task even if code is good. This is a real integration gate: prepare ordered merge packet, continue independent tasks, and do not invent approval or force stacked branches past repo policy. One program command reduces task dispatch overhead; it does not authorize future unknown commits

## Pause and resume

Before voluntary pause, finish safe atomic work and save checkpoint. Do not begin an unsafe migration just before a known session end. If quota/network/credential blocks saving, preserve local work and report exactly which state is not durable. Do not schedule wake-ups or promise automatic quota recovery unless an actual authorized automation capability is configured

Resume instruction can be “ทำงาน MPW ต่อจาก checkpoint ล่าสุด”. That is a reference to prior authority and goal, not a fresh approval to deploy or a reset of the project. If no current checkpoint is available, reconstruct from actual commits/PR/evidence before proceeding; do not assume the previous summary is current

## Completion vocabulary

| State | Required evidence |
|---|---|
| READY_FOR_TEST | implemented scope + local/CI checks, TEST prerequisites identified; not deployed |
| UAT_PASSED | authorized environment, actual tested actors/devices/journeys and reconciliation |
| READY_FOR_RELEASE | exact reviewable deployment/merge packet complete; awaits required GO |
| PILOT_LIVE | approved limited scope reachable, users verified, operations monitored |
| FULL_WEB_OPERATIONAL | all scoped business modules usable with actual authorized data and role controls |
| RETIREMENT_COMPLETE | old readers/writers/LINE intake retired as authorized, actual cycles observed, history/recovery intact |
| PROGRAM_COMPLETE | all scoped DoD + Owner acceptance/closeout authority, no concealed remaining scope |

Delivered URL alone is not completion; mock data, an Owner dashboard without Team functionality, or a screenshot does not satisfy the program target
