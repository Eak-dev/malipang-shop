# Issue #248 — Source audit and writer handoff

Observed: 2026-11-11T04:44:22.980282+00:00. Canonical main used: `f56503fb174e2cb256eb91773b7cf639d7f95e88`. Related task: #274.

## Owner decision

**WAIT_FOR_CLAUDE**: Owner chose to wait for Claude to finish the current task before moving #248 to a single primary branch. Primary branch remains unselected; `codex/restore-daily-sheet-sync-248` is a proposal only. No source checkout, open PR, release control or Production state was changed by this audit.

## Verified private preservation

Backup reference: `private:issue274-backup-20261111T044210Z`. Manifest SHA-256: `f19a50defe6508091e9ce85816941409660b5f6527f1a7b05f48bc7e3e59b221`.

Captured nine checkout snapshots (including the audit/reference checkouts), Git histories and tracked/untracked non-ignored files. Commit history was restored into independent bare repositories and checked with git fsck; each recorded HEAD resolves. Archive contents were rehashed and matched file manifests; source HEAD/status/file hashes remained stable during capture. Ignored credentials/runtime/dependency files were excluded.

Some source clones have truncated/shallow history. Their bundle alone is insufficient: restore verification seeded the canonical full-history bundle, then imported the source bundle. Preserve the entire private backup set and manifest together. The private location and backup contents are not committed. Earlier failed shallow-only restore attempts were not used as verified evidence.

**Snapshot stability is not writer quiescence.** Claude processes and the latest recovery-chat report show pending work/automatic resumption; no claim is made that writers have stopped. Capture a new final snapshot after Claude hands off.

## Remote source dispositions

All 19 canonical remote source tips were fetched before comparison. Sixteen exact tips match merged PR heads whose merge commits are reachable from main. Three source tips remain unproven, with open PRs. INTEGRATED means integration evidence exists, not that deletion is authorized.

| Branch | Tip | Integration | Open head PR | Open base PR | Merged PR evidence |
|---|---|---|---|---|---|
| `codex/issue248-g7-audit-relay` | `95912e26122e` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [262] |
| `codex/issue248-gh-audit-writer` | `cf4fecb420da` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [261] |
| `codex/issue248-post-cas-proof` | `1414078390fc` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [259] |
| `issue248/g6a-gate-on` | `7061e0222b55` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [253] |
| `issue248/g6a-incident-recheck` | `c6a8af9670b6` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [254] |
| `issue248/g6b-notice-readonly-diagnostic` | `c990cc9d4b08` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [255] |
| `issue248/g7-owner-receipt-writer` | `549b7b320023` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [266] |
| `issue248/g7-register-audit-workflow` | `323c2d12e862` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [264] |
| `issue248/g7-zero-audit-writer` | `a8b4cc50c3b2` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [263] |
| `issue248/g8-gh-audit-log-fix` | `bdc3fbc48b1b` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [267] |
| `issue248/g8-monitoring-risk-v2` | `4cd00e334e72` | NOT_PROVEN | [260] | [] | [] |
| `issue248/g8-steady-draft-c4` | `cd16f1915a82` | NOT_PROVEN | [258] | [260] | [] |
| `issue248/g8-zero-e68f-review` | `9f39c5455ff2` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [265] |
| `issue248/nonfinancial-completion-review-guard` | `a212af53392c` | NOT_PROVEN | [271] | [] | [] |
| `issue248/original-notice-diagnostic-20261110` | `403dac842cbe` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [256] |
| `issue248/supervised-notice-caller` | `5bf0515d59b9` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [257] |
| `issue248/terminal-direct-delivery-guard` | `af696f766616` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [268] |
| `issue248/terminal-guard-release-control` | `752283939e80` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [269] |
| `issue248/terminal-hotfix-head-repin` | `b75ca59445e5` | EXACT_PR_MERGED_TO_MAIN | [] | [] | [270] |

## Local work to preserve

Counts below are per checkout status entries, not unique changes across the project. Non-ancestor commits may include changes already squashed into main; content comparison is still required.

| Source | Branch | Tip | Outside-main commits | Dirty entries |
|---|---|---|---:|---:|
| Codex-Handoff-20261110 | `issue248/codex-local-handoff-20261110` | `891caaeabda0` | 3 | 46 |
| PR-B-ready | `issue248/local-steady-release` | `891caaeabda0` | 3 | 0 |
| PR-A | `issue248/local-g6a-prep` | `4bbc41346d15` | 2 | 0 |
| PR-B | `issue248/local-steady-prep` | `e35e75c3800e` | 1 | 5 |
| claude-5 | `main` | `6650030e94b5` | 0 | 1 |
| claude-6 | `claude/issue248-nonfinancial-release` | `26559dde594a` | 4 | 11 |
| claude-7 | `worktree-bridge-cse_016awLBPpADU3cfiEuwFSid9` | `6650030e94b5` | 0 | 0 |

## Integration queue after Claude finishes

1. Receive final source branch/SHA, git status, tests/review results and any explicitly deferred work from Claude and the coordination chat. Recheck processes/scheduled resumption; obtain writer handoff rather than inferring it from an idle chat.
2. Refresh live remote/local refs and PRs, and take a new verified backup of all changed files and commits. Review the dirty handoff checkout, PR-B draft and Claude release checkout separately.
3. Reconcile PR #271 and the stacked #260 -> #258 relationship. Keep their existing release gates; compare functionality already in main before cherry-picking anything. Do not close or retarget PRs as part of this audit.
4. Select one #248 primary branch from latest canonical main. Adopt only required, reviewed changes; document duplicates, superseded code and excluded experiments. Test the actual combined code.
5. Publish one target PR, set work item MANAGED only when the selected remote primary is registered and the coordination handoff is established. No automatic production release follows.
6. Review each old source for worktree/PR/external references and a fresh recoverable backup before DELETE_READY. No source meets complete readiness in this audit.

## Outstanding deletion evidence

No literal reference to these 19 exact branch names was found in the current main workflow files. This does not inventory historical reruns, Cloudflare build configuration, other automation or unknown clones. Worktree/writer and external-reference clearance remain unproven. No DELETE_READY record was created.

## Validation and rollback

Run the existing lifecycle validator and targeted lifecycle tests for this metadata-only change. Roll back this metadata via a reviewed revert; retain private backups and original source checkouts. This audit does not authorize merge/deploy/deletion or alter #248 business/release authority.
