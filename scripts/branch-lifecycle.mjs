import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const states = new Set(['NEEDS_AUDIT', 'ACTIVE', 'PENDING_INTEGRATION', 'INTEGRATED', 'DELETE_READY', 'DELETED', 'PROTECTED']);
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const present = value => typeof value === 'string' && value.trim().length > 0;
const date = value => present(value) && Number.isFinite(Date.parse(value));

// Structural validation is not live proof or authority to delete a branch.
export function validateRegistry(registry) {
  const errors = [];
  if (registry?.version !== 1 || registry?.mode !== 'report-only' || !Array.isArray(registry?.branches) || !Array.isArray(registry?.work_items)) {
    return ['Expected version 1, mode report-only, branches and work_items arrays'];
  }
  if (registry.repository !== 'Eak-dev/malipang-shop') errors.push('Registry must identify the canonical repository');
  if (!date(registry.observed_at) || !sha(registry.canonical_main_sha)) errors.push('Invalid inventory timestamp or main SHA');
  const keys = new Set();
  for (const item of registry.branches) {
    if (!item || typeof item !== 'object') { errors.push('Invalid branch record'); continue; }
    const key = `${item.scope}:${item.source}:${item.branch}`;
    const fail = reason => errors.push(`${key}: ${reason}`);
    if (keys.has(key)) fail('duplicate record');
    keys.add(key);
    if (!['local', 'remote'].includes(item.scope) || !present(item.source) || !present(item.branch) || !sha(item.source_sha)) fail('invalid identity / SHA');
    if (!states.has(item.status)) fail('invalid status');
    if (!Array.isArray(item.issues) || item.issues.some(n => !Number.isInteger(n) || n < 1)) fail('invalid issues');
    if (!present(item.reason)) fail('reason required');
    if (item.branch === 'main' && item.status !== 'PROTECTED') fail('main must remain PROTECTED');
    if (!['DELETE_READY', 'DELETED'].includes(item.status)) continue;
    const proof = item.readiness;
    if (!proof || typeof proof !== 'object') { fail('missing readiness evidence'); continue; }
    if (proof.source_sha !== item.source_sha || !sha(proof.target_sha) || !present(proof.target_branch) || proof.target_branch === item.branch) fail('readiness must bind exact source and distinct target');
    if (!date(proof.checked_at) || !present(proof.checked_by)) fail('reviewer and timestamp required');
    for (const field of ['integration_verified', 'target_pushed', 'checks_passed', 'worktrees_clear', 'dependencies_clear', 'external_refs_reviewed']) {
      if (proof[field] !== true) fail(`${field} must be true`);
    }
    for (const field of ['integration_evidence', 'checks_evidence', 'worktree_evidence', 'dependency_evidence', 'external_refs_evidence']) {
      if (!present(proof[field])) fail(`${field} reference required`);
    }
    if (proof.backup?.source_sha !== item.source_sha || proof.backup?.verified !== true || !present(proof.backup?.reference)) fail('verified recoverable source backup required');
    if (item.branch === 'main' || item.protected === true || item.active_writer === true || item.uncommitted_work === true) fail('protected branch, active writer or uncommitted work cannot be deletion-ready');
    if (item.status === 'DELETED' && (!date(item.deletion?.verified_at) || item.deletion?.absence_verified !== true || !present(item.deletion?.evidence))) fail('verified deletion evidence required');
  }
  const issues = new Set();
  for (const work of registry.work_items) {
    if (!Number.isInteger(work?.issue) || work.issue < 1 || issues.has(work.issue)) { errors.push('Invalid / duplicate work item issue'); continue; }
    issues.add(work.issue);
    if (!['MIGRATION_PENDING', 'MANAGED'].includes(work.mode)) errors.push(`#${work.issue}: invalid work mode`);
    if (work.mode === 'MANAGED') {
      const active = registry.branches.filter(b => b.scope === 'remote' && b.issues?.includes(work.issue) && b.status === 'ACTIVE');
      if (!present(work.primary_branch) || active.length !== 1 || active[0].branch !== work.primary_branch) errors.push(`#${work.issue}: MANAGED requires one registered active remote primary branch`);
    }
  }
  return errors;
}

const cell = value => String(value).replace(/[\r\n|<>`]/g, ' ');
export function buildReport(registry, event = {}) {
  const errors = validateRegistry(registry);
  registry = registry && typeof registry === 'object' ? registry : {};
  const branches = Array.isArray(registry.branches) ? registry.branches.filter(b => b && typeof b === 'object') : [];
  const workItems = Array.isArray(registry.work_items) ? registry.work_items.filter(w => w && typeof w === 'object') : [];
  const lines = ['# Branch lifecycle — report only', '', `Inventory observed: ${cell(registry.observed_at ?? 'unknown')}`, '', '**A snapshot is not live deletion authorization. Recheck source/target SHAs, all worktrees, dependencies and backup immediately before an approved deletion.**', ''];
  if (errors.length) lines.push('## Invalid registry', '', ...errors.map(e => `- ${cell(e)}`), '');
  const counts = {};
  for (const b of branches) counts[b.status] = (counts[b.status] ?? 0) + 1;
  lines.push('| Status | Snapshot records |', '|---|---:|', ...Object.entries(counts).map(([s,n]) => `| ${cell(s)} | ${n} |`), '');
  const pr = event.pull_request;
  if (pr) {
    const found = branches.find(b => b.scope === 'remote' && b.branch === pr.head?.ref && pr.head?.repo?.full_name === registry.repository);
    const warnings = [];
    if (!found) warnings.push('Head branch is not registered for this repository. Add a record; existing PRs remain unblocked during rollout.');
    else {
      if (found.source_sha !== pr.head?.sha) warnings.push('Head SHA changed since inventory. Refresh the record; any previous deletion readiness is stale.');
      if (!found.issues?.length) warnings.push('Issue linkage is missing.');
    }
    if (!/^## Branch lifecycle\s*$/m.test(pr.body ?? '')) warnings.push('PR lacks the Branch lifecycle section.');
    lines.push('## Current PR', '', ...warnings.map(w => `- ${w}`));
    if (!warnings.length) lines.push('- Registered head SHA and lifecycle section found. This does not prove integration or deployment.');
    lines.push('');
  }
  lines.push('## Work items', '');
  for (const work of workItems) lines.push(`- #${cell(work.issue)}: ${cell(work.mode)}; primary: ${cell(work.primary_branch ?? 'not selected')}`);
  lines.push('', '## Deletion markers', '');
  const ready = branches.filter(b => b.status === 'DELETE_READY');
  if (errors.length) lines.push('- Registry invalid: do not use any readiness marker.');
  else if (!ready.length) lines.push('- No branch is marked DELETE_READY.');
  else lines.push(...ready.map(b => `- ${cell(b.scope)} ${cell(b.branch)} @ ${cell(b.source_sha)} — recorded readiness only; live revalidation required.`));
  lines.push('', '## Registered branches (snapshot)', '', '| Scope / source | Branch | Observed SHA | Status | Issues | Reason |', '|---|---|---|---|---|---|');
  for (const branch of branches) lines.push(`| ${cell(branch.scope)} / ${cell(branch.source)} | ${cell(branch.branch)} | ${cell(branch.source_sha)} | ${cell(branch.status)} | ${cell((Array.isArray(branch.issues) ? branch.issues : []).join(', '))} | ${cell(branch.reason)} |`);
  return { markdown: `${lines.join('\n')}\n`, errors };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
  const registry = JSON.parse(readFileSync(option('--registry', 'docs/branch-lifecycle.json'), 'utf8'));
  const eventPath = option('--event');
  const event = eventPath ? JSON.parse(readFileSync(eventPath, 'utf8')) : {};
  const result = buildReport(registry, event);
  const reportPath = option('--report');
  if (reportPath) appendFileSync(reportPath, result.markdown);
  else process.stdout.write(result.markdown);
  if (result.errors.length) process.exitCode = 1;
}
