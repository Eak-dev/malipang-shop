import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistry, buildReport } from '../scripts/branch-lifecycle.mjs';

const a = 'a'.repeat(40), b = 'b'.repeat(40);
function sample() {
  return { version: 1, mode: 'report-only', repository: 'Eak-dev/malipang-shop', observed_at: '2026-11-11T00:00:00Z', canonical_main_sha: b, work_items: [], branches: [{ scope: 'remote', source: 'origin', branch: 'codex/old', source_sha: a, issues: [248], status: 'DELETE_READY', reason: 'Reviewed', readiness: { source_sha: a, target_sha: b, target_branch: 'codex/current', checked_by: 'reviewer', checked_at: '2026-11-11T00:00:00Z', integration_verified: true, target_pushed: true, checks_passed: true, worktrees_clear: true, dependencies_clear: true, external_refs_reviewed: true, integration_evidence: 'PR/integration', checks_evidence: 'CI/result', worktree_evidence: 'audit/local', dependency_evidence: 'audit/PRs', external_refs_evidence: 'audit/workflows', backup: { source_sha: a, verified: true, reference: 'private verified bundle' } } }] };
}
test('readiness must be bound to unchanged source SHA', () => {
  const r = sample(); assert.deepEqual(validateRegistry(r), []);
  r.branches[0].source_sha = b;
  assert.ok(validateRegistry(r).some(e => e.includes('exact source')));
});
test('dirty work, active writer, missing evidence and unverified backup block readiness', () => {
  for (const change of [r => r.branches[0].uncommitted_work = true, r => r.branches[0].active_writer = true, r => r.branches[0].readiness.checks_passed = false, r => delete r.branches[0].readiness.worktree_evidence, r => r.branches[0].readiness.backup.verified = false]) {
    const r = sample(); change(r); assert.ok(validateRegistry(r).length > 0);
  }
});
test('main stays protected and deletion requires absence proof', () => {
  const r = sample(); r.branches[0].branch = 'main'; assert.ok(validateRegistry(r).length);
  const d = sample(); d.branches[0].status = 'DELETED'; assert.ok(validateRegistry(d).length);
  d.branches[0].deletion = { verified_at: '2026-11-11T01:00:00Z', absence_verified: true, evidence: 'audit/readback' }; assert.deepEqual(validateRegistry(d), []);
});
test('managed task cannot have multiple active remote branches', () => {
  const r = sample(); r.branches[0].status = 'ACTIVE'; r.work_items = [{ issue: 248, mode: 'MANAGED', primary_branch: 'codex/old' }];
  assert.deepEqual(validateRegistry(r), []);
  r.branches.push({ ...r.branches[0], branch: 'codex/another' }); assert.ok(validateRegistry(r).length);
});
test('PR drift and missing registration are advisory, not deletion proof', () => {
  const r = sample(); r.branches[0].status = 'ACTIVE';
  const event = { pull_request: { head: { ref: 'codex/old', sha: b, repo: { full_name: r.repository } }, body: '' } };
  const result = buildReport(r, event); assert.deepEqual(result.errors, []); assert.match(result.markdown, /Head SHA changed/); assert.match(result.markdown, /No branch is marked DELETE_READY/);
  event.pull_request.head.repo.full_name = 'fork/repo'; assert.match(buildReport(r, event).markdown, /not registered/);
});
test('duplicate records and invalid registries cannot produce readiness advice', () => {
  const r = sample(); r.branches.push({ ...r.branches[0] }); assert.match(buildReport(r).markdown, /Registry invalid/);
  assert.ok(validateRegistry({}).length);
  for (const malformed of [null, {}, { branches: {}, work_items: null }, { branches: [null], work_items: [null] }]) {
    assert.match(buildReport(malformed).markdown, /Registry invalid/);
  }
});
